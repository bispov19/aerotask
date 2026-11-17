// SPDX-License-Identifier: GPL-3.0-or-later
// Um ícone de bandeja na barra (um programa com StatusNotifierItem).
//
// O programa oferece no barramento um objeto org.kde.StatusNotifierItem:
// propriedades (ícone, título, estado…), sinais quando algo muda
// (NewIcon, NewStatus…) e o caminho do menu dele, no protocolo DBusMenu — o
// mesmo que a barra já lê dos apps Qt/Electron. O menu abre no AeroTaskMenu, o
// mesmo pop-up dos outros menus.
//
// Visual do macOS:
//   - se o tema tem a versão SIMBÓLICA do ícone ("…-symbolic"), ela é usada:
//     monocromática e recolorida pelo tema (o "template" do macOS);
//   - senão, com "Monocromático" (padrão), o ícone colorido vira um
//     "template" na cor do texto da barra (templateEffect.js + iconShape.js):
//     uma FORMA sobre fundo transparente (o coração do Deezer) fica só com o
//     contorno; um "ladrilho" (ícone de app em quadrado, como os do tema
//     Vitral) perde o fundo e fica só o desenho de dentro. Antes era tons de
//     cinza, que deixava ícones coloridos escuros, como se estivessem
//     apagados. Só um ladrilho de fundo degradê fica em tons de cinza.
//     "Original" mantém as cores;
//   - mesmo tamanho dos outros ícones da barra (classe system-status-icon).
//
// Clique (como no macOS): esquerdo ou direito abre o menu; sem menu, o
// esquerdo "ativa" o programa (ex.: mostra a janela). Botão do meio: ação
// secundária. Rolar o mouse: repassado ao programa.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {AeroTaskMenu, fillMenu} from '../popup.js';
import {DBusMenuSource} from '../sources/dbusMenuSource.js';
import {STATUS_BUTTON_CLASS} from '../statusBar/common.js';
import {analyzeIcon, glyphMask} from './iconShape.js';
import {TemplateEffect} from './templateEffect.js';
import {debug, isExpectedDBusError, logError} from '../util.js';

const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const CALL_TIMEOUT = 2000; // ms — um programa travado não trava a barra
/** Vários sinais seguidos (NewIcon + NewTitle…) viram uma leitura só. */
const REFRESH_DELAY = 100; // ms
/** Tamanho dos ícones da barra (o mesmo de system-status-icon). */
const ICON_SIZE = 16;
/** Tamanho mínimo em que um arquivo de ícone é lido para a análise (px). */
const ANALYSIS_SIZE = 32;
/** Desenho extraído menor que isso (fração do ícone) = ladrilho liso. */
const MIN_GLYPH_SHARE = 0.03;
/** Margem em volta do desenho extraído (fração do tamanho dele). */
const GLYPH_MARGIN = 0.06;

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

export const TrayButton = GObject.registerClass(
class AeroTaskTrayButton extends PanelMenu.Button {
    /**
     * @param {object} item - {id, bus, path}
     * @param {Gio.Settings} settings
     * @param {object} host - {getAppearance(), getMenuOptions(), remember(key, title)}
     */
    _init(item, settings, host) {
        // true = sem o menu padrão do GNOME: usamos o AeroTaskMenu.
        super._init(0.5, '', true);
        this.add_style_class_name('aerotask-tray-button');
        // Mesmo espaço entre ícones que o resto da barra (stylesheet.css).
        this.add_style_class_name(STATUS_BUTTON_CLASS);
        this._item = item;
        this._settings = settings;
        this._host = host;
        this._props = {};
        this._cancellable = new Gio.Cancellable();
        this._refreshId = 0;
        this._menuSource = null;
        this._menuPath = null;

        this._icon = new St.Icon({
            style_class: 'system-status-icon aerotask-tray-icon',
            fallback_icon_name: 'application-x-executable-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this._effect = null; // TemplateEffect ou DesaturateEffect
        this._effectKind = null; // 'template', 'gray' ou null
        // Resultado da análise de cada arquivo de ícone deste programa
        // (caminho → {kind, glyph}); o Deezer troca entre poucos arquivos.
        this._analysis = new Map();
        this._iconRequest = 0;
        // A cor do template acompanha a do texto da barra (tema claro/escuro).
        // (style-changed vem quando o tema muda; notify::mapped garante a cor
        // na primeira vez que o ícone entra na tela.)
        this._icon.connect('style-changed', () => this._syncTemplateColor());
        this._icon.connect('notify::mapped', () => this._syncTemplateColor());

        this.setMenu(new AeroTaskMenu(this, host.getAppearance(), 0.5));
        this.menu.beforeOpen = () => {
            this._menuSource?.aboutToShowRoot();
            this._rebuildMenu();
        };
        // O PanelMenu.Button abre o menu com QUALQUER botão; trocamos pelo
        // nosso gesto, que diferencia os botões do mouse.
        this._clickGesture.set_enabled(false);
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', gesture => this._onClick(gesture.get_button()));
        this.add_action(click);

        const scroll = new Clutter.ScrollController({
            flags: Clutter.ScrollControllerFlags.SCROLL_VERTICAL,
        });
        scroll.connect('scroll', (_c, _sprite, _source, _dx, dy) => {
            if (dy)
                this._call('Scroll', new GLib.Variant('(is)', [dy > 0 ? 1 : -1, 'vertical']));
        });
        this.add_action(scroll);

        // Qualquer aviso do programa (ícone, título, estado mudou): relê.
        this._signalId = Gio.DBus.session.signal_subscribe(item.bus, ITEM_IFACE, null,
            item.path, null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, signal) => {
                if (signal.startsWith('New'))
                    this._queueRefresh();
            });
        settings.connectObject(
            'changed::tray-icon-style', () => this._syncIcon(),
            'changed::tray-hidden-items', () => this._syncVisible(),
            this);

        this.visible = false; // aparece quando as propriedades chegarem
        this._refresh();
    }

    /** O nome usado nas preferências para esconder este ícone. */
    get key() {
        return this._props.Id || this._item.bus;
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        try {
            const reply = await Gio.DBus.session.call(this._item.bus, this._item.path,
                'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [ITEM_IFACE]),
                new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, CALL_TIMEOUT,
                this._cancellable);
            const [props] = reply.recursiveUnpack();
            this._props = props;
        } catch (e) {
            if (!isExpectedDBusError(e))
                logError(e, `bandeja: lendo ${this._item.id}`);
            return;
        }
        if (this._cancellable.is_cancelled())
            return;
        this.accessible_name = this._props.Title ?? this._props.Id ?? '';
        this._host.remember(this.key, this._props.Title || this._props.Id || this.key);
        this._syncMenu();
        this._syncIcon();
        this._syncVisible();
    }

    _syncVisible() {
        const hidden = this._settings.get_strv('tray-hidden-items').includes(this.key);
        // "Passive" = o programa pede para o ícone ficar escondido agora.
        this.visible = !hidden && this._props.Status !== 'Passive' && Boolean(this._icon.gicon);
        if (!this.visible)
            this.menu.close();
    }

    // ----- Ícone ---------------------------------------------------------------

    _syncIcon() {
        const p = this._props;
        const attention = p.Status === 'NeedsAttention';
        const name = (attention && p.AttentionIconName) || p.IconName;
        const pixmaps = (attention && p.AttentionIconPixmap?.length && p.AttentionIconPixmap) ||
            p.IconPixmap;
        const mono = this._settings.get_string('tray-icon-style') === 'monochrome';
        const request = ++this._iconRequest;

        if (name) {
            const [gicon, symbolic] = iconFromName(name, p.IconThemePath);
            // Simbólico ou "Original": o ícone como veio.
            const path = symbolic || !mono ? null : iconFilePath(gicon);
            if (!path) {
                this._setIcon(gicon, symbolic || !mono ? null : 'template');
            } else if (this._analysis.has(path)) {
                this._applyAnalysis(gicon, this._analysis.get(path));
            } else {
                // Até a análise (assíncrona) chegar: o ícone como "forma".
                this._setIcon(gicon, 'template');
                this._analyzeFile(path, gicon, request);
            }
        } else if (pixmaps?.length) {
            const pixmap = choosePixmap(pixmaps);
            const gicon = pixmap ? iconFromPixmap(pixmap) : null;
            if (!pixmap || !mono)
                this._setIcon(gicon, null);
            else
                this._applyAnalysis(gicon, analyzePixmap(pixmap));
        } else {
            this._setIcon(null, null);
        }
        this._syncVisible();
    }

    /**
     * @param {Gio.Icon} gicon - o ícone original
     * @param {object} analysis - {kind, glyph}: glyph = o desenho já sem o
     *   fundo (ícone branco), quando kind é 'glyph'
     */
    _applyAnalysis(gicon, analysis) {
        if (analysis.kind === 'glyph' && analysis.glyph)
            this._setIcon(analysis.glyph, 'template');
        else
            this._setIcon(gicon, analysis.kind === 'gray' ? 'gray' : 'template');
    }

    /**
     * @param {Gio.Icon|null} gicon
     * @param {string|null} kind - efeito: 'template' (a forma na cor do
     *   texto), 'gray' (tons de cinza) ou null (nenhum)
     */
    _setIcon(gicon, kind) {
        this._icon.gicon = gicon;
        if (kind === this._effectKind)
            return;
        if (this._effect)
            this._icon.remove_effect(this._effect);
        this._effect = null;
        this._effectKind = kind;
        if (kind === 'template') {
            this._effect = new TemplateEffect();
            this._icon.add_effect(this._effect);
            this._syncTemplateColor();
        } else if (kind === 'gray') {
            this._effect = new Clutter.DesaturateEffect({factor: 1});
            this._icon.add_effect(this._effect);
        }
    }

    _syncTemplateColor() {
        if (this._effectKind !== 'template' || !this._icon.get_stage())
            return;
        this._effect.setColor(this._icon.get_theme_node().get_foreground_color());
    }

    /** Lê o arquivo do ícone (pequeno, assíncrono) e o analisa. */
    async _analyzeFile(path, gicon, request) {
        let analysis = {kind: 'shape', glyph: null};
        try {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const size = Math.max(ANALYSIS_SIZE, ICON_SIZE * scale);
            const stream = await Gio.File.new_for_path(path)
                .read_async(GLib.PRIORITY_DEFAULT, this._cancellable);
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream,
                size, size, true, this._cancellable);
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
            analysis = analyzePixbuf(pixbuf);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            debug(`bandeja: não deu para ler ${path}: ${e.message}`);
        }
        this._analysis.set(path, analysis);
        // O ícone pode ter mudado enquanto líamos: só aplica se ainda é este.
        if (!this._cancellable.is_cancelled() && request === this._iconRequest)
            this._applyAnalysis(gicon, analysis);
    }

    // ----- Menu ----------------------------------------------------------------

    _syncMenu() {
        const path = this._props.Menu;
        if (path === this._menuPath)
            return;
        this._menuSource?.disconnectObject(this);
        this._menuSource?.destroy();
        this._menuSource = null;
        this._menuPath = path;
        if (path && path !== '/') {
            this._menuSource = new DBusMenuSource(this._item.bus, path);
            this._menuSource.connectObject('changed', () => {
                if (this.menu.isOpen)
                    this._rebuildMenu();
            }, this);
        }
    }

    _rebuildMenu() {
        this.menu.removeAll();
        const nodes = this._menuSource?.getRootNodes() ?? [];
        fillMenu(this.menu, nodes, this._host.getMenuOptions());
    }

    get _hasMenu() {
        return Boolean(this._menuSource) && this._menuSource.getRootNodes().length > 0;
    }

    _onClick(button) {
        if (button === Clutter.BUTTON_MIDDLE) {
            this._call('SecondaryActivate', this._pointer());
            return;
        }
        // Como no macOS: o clique abre o menu do programa.
        if (this._hasMenu) {
            this._rebuildMenu();
            this.menu.toggle();
            return;
        }
        // Sem menu: esquerdo ativa (mostra o programa); direito pede o menu
        // de contexto do próprio programa.
        this._call(button === Clutter.BUTTON_SECONDARY ? 'ContextMenu' : 'Activate', this._pointer());
    }

    _pointer() {
        const [x, y] = global.get_pointer();
        return new GLib.Variant('(ii)', [x, y]);
    }

    _call(method, params) {
        Gio.DBus.session.call(this._item.bus, this._item.path, ITEM_IFACE, method, params,
            null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT, this._cancellable)
            .catch(e => {
                if (!isExpectedDBusError(e))
                    debug(`bandeja: ${method} em ${this._item.id} falhou: ${e.message}`);
            });
    }

    setAppearance(appearance) {
        this.menu.setAppearance(appearance);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        this._settings.disconnectObject(this);
        this._menuSource?.disconnectObject(this);
        this._menuSource?.destroy();
        this._menuSource = null;
        super.destroy();
    }
});

/**
 * Ícone pelo NOME: arquivo (caminho absoluto), pasta de ícones própria do
 * programa (IconThemePath) ou o tema do sistema — preferindo a versão
 * simbólica, quando existir.
 *
 * @param {string} name
 * @param {string} [themePath]
 * @returns {[Gio.Icon, boolean]} [ícone, é simbólico?]
 */
function iconFromName(name, themePath) {
    if (name.startsWith('/'))
        return [new Gio.FileIcon({file: Gio.File.new_for_path(name)}), name.includes('-symbolic')];
    if (themePath) {
        const file = findInThemePath(themePath, name);
        if (file)
            return [new Gio.FileIcon({file}), name.endsWith('-symbolic')];
    }
    const theme = new St.IconTheme();
    const symbolicName = name.endsWith('-symbolic') ? name : `${name}-symbolic`;
    if (theme.lookup_icon(symbolicName, ICON_SIZE, 0))
        return [new Gio.ThemedIcon({name: symbolicName}), true];
    return [new Gio.ThemedIcon({name}), false];
}

/** Procura o ícone na pasta de ícones do próprio programa. */
function findInThemePath(themePath, name) {
    const dirs = [themePath];
    for (const size of ['scalable', '16x16', '22x22', '24x24', '32x32', '48x48', '64x64'])
        dirs.push(GLib.build_filenamev([themePath, 'hicolor', size, 'apps']), GLib.build_filenamev([themePath, size]));
    for (const dir of dirs) {
        for (const ext of ['svg', 'png']) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `${name}.${ext}`]));
            if (file.query_exists(null))
                return file;
        }
    }
    return null;
}

/**
 * Caminho do arquivo por trás do ícone (arquivo direto ou do tema), para
 * medir a cobertura.
 *
 * @param {Gio.Icon|null} gicon
 * @returns {string|null}
 */
function iconFilePath(gicon) {
    if (gicon instanceof Gio.FileIcon)
        return gicon.file.get_path();
    if (gicon instanceof Gio.ThemedIcon) {
        const info = new St.IconTheme().lookup_icon(gicon.get_names()[0], ANALYSIS_SIZE, 0);
        return info?.get_filename() ?? null;
    }
    return null;
}

/**
 * IconPixmap traz várias imagens ARGB32 de tamanhos diferentes (em ordem
 * de rede): usamos a menor que ainda tenha pelo menos o tamanho do ícone na
 * tela.
 *
 * @param {Array} pixmaps - [[largura, altura, bytes], …]
 * @returns {Array|null} [largura, altura, bytes]
 */
function choosePixmap(pixmaps) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const target = ICON_SIZE * scale;
    const valid = pixmaps.filter(([w, h, data]) => w > 0 && h > 0 && data?.length >= w * h * 4)
        .sort((a, b) => a[0] - b[0]);
    return valid.find(([w]) => w >= target) ?? valid[valid.length - 1] ?? null;
}

/** @returns {Gio.Icon} o pixmap como ícone */
function iconFromPixmap([width, height, data]) {
    // St.ImageContent também é um Gio.Icon: dá para pôr direto no St.Icon.
    const content = St.ImageContent.new_with_preferred_size(width, height);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(),
        new GLib.Bytes(data), Cogl.PixelFormat.ARGB_8888, width, height, width * 4);
    return content;
}

/**
 * Analisa um pixmap ARGB (o alfa é o 1º byte de cada pixel; sem
 * pré-multiplicação, pela especificação do StatusNotifierItem).
 *
 * @returns {object} {kind, glyph}
 */
function analyzePixmap([width, height, data]) {
    const pixel = (x, y) => {
        const o = (y * width + x) * 4;
        return [data[o + 1], data[o + 2], data[o + 3], data[o]];
    };
    return analyzePixels(width, height, pixel);
}

/** Analisa um GdkPixbuf (RGB ou RGBA). */
function analyzePixbuf(pixbuf) {
    const bytes = pixbuf.read_pixel_bytes().toArray();
    const {width, height, rowstride, n_channels: channels} = pixbuf;
    const alpha = pixbuf.has_alpha;
    const pixel = (x, y) => {
        const o = y * rowstride + x * channels;
        return [bytes[o], bytes[o + 1], bytes[o + 2], alpha ? bytes[o + 3] : 255];
    };
    return analyzePixels(width, height, pixel);
}

/**
 * Classifica o ícone (iconShape.js) e, se for um ladrilho, monta o desenho
 * de dentro como um ícone BRANCO (o TemplateEffect o pinta na cor do texto).
 */
function analyzePixels(width, height, pixel) {
    const {kind, background} = analyzeIcon(width, height, pixel);
    if (kind !== 'glyph')
        return {kind, glyph: null};
    const mask = glyphMask(width, height, pixel, background);

    // Caixa do desenho: ele é recortado e centralizado num quadrado com uma
    // margem pequena, para ocupar o ícone todo (dentro do ladrilho ele era
    // pequeno).
    let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] < 64)
            continue;
        const x = i % width, y = Math.floor(i / width);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        count++;
    }
    // Ladrilho liso, sem desenho dentro: fica a forma do ladrilho.
    if (count < mask.length * MIN_GLYPH_SHARE)
        return {kind: 'shape', glyph: null};

    const side = Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) * (1 + GLYPH_MARGIN * 2));
    const offX = Math.round((side - (maxX - minX + 1)) / 2) - minX;
    const offY = Math.round((side - (maxY - minY + 1)) / 2) - minY;
    const rgba = new Uint8Array(side * side * 4);
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const o = ((y + offY) * side + x + offX) * 4;
            rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
            rgba[o + 3] = mask[y * width + x];
        }
    }
    const content = St.ImageContent.new_with_preferred_size(side, side);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(),
        new GLib.Bytes(rgba), Cogl.PixelFormat.RGBA_8888, side, side, side * 4);
    return {kind, glyph: content};
}
