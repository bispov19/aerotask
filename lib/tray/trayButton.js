// SPDX-License-Identifier: GPL-3.0-or-later
// Um ícone de bandeja na barra (um programa com StatusNotifierItem).
//
// O programa oferece no barramento um objeto org.kde.StatusNotifierItem:
// propriedades (ícone, título, estado…), sinais quando algo muda
// (NewIcon, NewStatus…) e o caminho do menu dele, no protocolo DBusMenu — o
// mesmo que a barra já lê dos apps Qt/Electron. O menu abre no AeroMenu, o
// mesmo pop-up dos outros menus.
//
// Visual do macOS:
//   - se o tema tem a versão SIMBÓLICA do ícone ("…-symbolic"), ela é usada:
//     monocromática e recolorida pelo tema (o "template" do macOS);
//   - senão, com "Monocromático" (padrão), o ícone colorido vira tons de
//     cinza; "Original" mantém as cores;
//   - mesmo tamanho dos outros ícones da barra (classe system-status-icon).
//
// Clique (como no macOS): esquerdo ou direito abre o menu; sem menu, o
// esquerdo "ativa" o programa (ex.: mostra a janela). Botão do meio: ação
// secundária. Rolar o mouse: repassado ao programa.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {AeroMenu, fillMenu} from '../popup.js';
import {DBusMenuSource} from '../sources/dbusMenuSource.js';
import {debug, isExpectedDBusError, logError} from '../util.js';

const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const CALL_TIMEOUT = 2000; // ms — um programa travado não trava a barra
/** Vários sinais seguidos (NewIcon + NewTitle…) viram uma leitura só. */
const REFRESH_DELAY = 100; // ms
/** Tamanho dos ícones da barra (o mesmo de system-status-icon). */
const ICON_SIZE = 16;

export const TrayButton = GObject.registerClass(
class AeroMenuTrayButton extends PanelMenu.Button {
    /**
     * @param {object} item - {id, bus, path}
     * @param {Gio.Settings} settings
     * @param {object} host - {getAppearance(), getMenuOptions(), remember(key, title)}
     */
    _init(item, settings, host) {
        // true = sem o menu padrão do GNOME: usamos o AeroMenu.
        super._init(0.5, '', true);
        this.add_style_class_name('aero-tray-button');
        this._item = item;
        this._settings = settings;
        this._host = host;
        this._props = {};
        this._cancellable = new Gio.Cancellable();
        this._refreshId = 0;
        this._menuSource = null;
        this._menuPath = null;

        this._icon = new St.Icon({
            style_class: 'system-status-icon aero-tray-icon',
            fallback_icon_name: 'application-x-executable-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this._grayscale = null;

        this.setMenu(new AeroMenu(this, host.getAppearance(), 0.5));
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

        let gicon = null;
        let symbolic = false;
        if (name)
            [gicon, symbolic] = iconFromName(name, p.IconThemePath);
        else if (pixmaps?.length)
            gicon = iconFromPixmaps(pixmaps);

        this._icon.gicon = gicon;

        // Tons de cinza só no ícone colorido (o simbólico já é monocromático).
        const gray = !symbolic && this._settings.get_string('tray-icon-style') === 'monochrome';
        if (gray && !this._grayscale) {
            this._grayscale = new Clutter.DesaturateEffect({factor: 1});
            this._icon.add_effect(this._grayscale);
        } else if (!gray && this._grayscale) {
            this._icon.remove_effect(this._grayscale);
            this._grayscale = null;
        }
        this._syncVisible();
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
 * Ícone em PIXELS (IconPixmap: várias imagens ARGB32 de tamanhos
 * diferentes, em ordem de rede): usamos a menor que ainda tenha pelo menos o
 * tamanho do ícone na tela.
 *
 * @param {Array} pixmaps - [[largura, altura, bytes], …]
 * @returns {Gio.Icon|null}
 */
function iconFromPixmaps(pixmaps) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const target = ICON_SIZE * scale;
    const valid = pixmaps.filter(([w, h, data]) => w > 0 && h > 0 && data?.length >= w * h * 4)
        .sort((a, b) => a[0] - b[0]);
    const [width, height, data] = valid.find(([w]) => w >= target) ?? valid[valid.length - 1] ?? [];
    if (!width)
        return null;
    // St.ImageContent também é um Gio.Icon: dá para pôr direto no St.Icon.
    const content = St.ImageContent.new_with_preferred_size(width, height);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(),
        new GLib.Bytes(data), Cogl.PixelFormat.ARGB_8888, width, height, width * 4);
    return content;
}
