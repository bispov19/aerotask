// SPDX-License-Identifier: GPL-3.0-or-later
// Centro de controle no estilo do macOS (Big Sur em diante), feito em cima
// do PRÓPRIO menu de Configurações Rápidas do GNOME:
//
//   - a grade troca de layout (lib/controlCenter/layout.js): bloco de
//     conectividade, Foco, telhas, blocos Tela e Som, Tocando agora;
//   - os botões ganham o visual do macOS por CSS (ícone num círculo que fica
//     na cor de destaque quando ligado);
//   - nos controles deslizantes, o ícone vai para DENTRO da barra grossa;
//   - um bloco novo, "Tocando agora" (lib/controlCenter/media.js).
//
// Nada é recriado: os botões, submenus (redes, dispositivos, saída de som,
// menu de energia), atalhos e botões de outras extensões são os do GNOME.
// Por isso nada do que funciona hoje para de funcionar. Desligar a opção (ou
// a extensão) devolve o layout, as classes e os ícones originais.
//
// Abrir/fechar, Esc e clique fora: os do próprio menu do GNOME (com a
// animação padrão dos pop-ups).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickMenuToggle, QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createControlCenterLayout} from './layout.js';
import {MediaBlock} from './media.js';

/** Classes CSS por papel (os botões do GNOME ganham, e perdem ao desfazer). */
const ROLE_CLASSES = {
    conn: ['aero-cc-toggle', 'aero-cc-conn'],
    focus: ['aero-cc-toggle', 'aero-cc-tile'],
    tile: ['aero-cc-toggle', 'aero-cc-tile'],
};

/** Fundos (cinza translúcido: bom no modo claro e no escuro). */
const TILE_BG = 'rgba(128, 128, 128, 0.16)';
const TILE_BG_HOVER = 'rgba(128, 128, 128, 0.26)';
const ROW_BG_HOVER = 'rgba(128, 128, 128, 0.14)';
const BUTTON_BG_HOVER = 'rgba(128, 128, 128, 0.2)';

export class ControlCenter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._qs = Main.panel.statusArea.quickSettings;
        this._active = false;
        this._laterId = 0;
        settings.connectObject('changed::macos-control-center', () => this._syncEnabled(), this);
        this._syncEnabled();
    }

    _syncEnabled() {
        const want = this._settings.get_boolean('macos-control-center');
        if (want && !this._active)
            this._apply();
        else if (!want && this._active)
            this._revert();
    }

    /**
     * Papel de um filho da grade no layout do macOS.
     *
     * @param {Clutter.Actor} child
     * @returns {string}
     */
    roleOf(child) {
        if (child._aeroCcRole)
            return child._aeroCcRole;
        const qs = this._qs;
        const from = indicator => indicator?.quickSettingsItems?.includes(child);
        if (from(qs._system))
            return 'system';
        if (from(qs._brightness))
            return 'display';
        if (from(qs._volumeOutput) || from(qs._volumeInput))
            return 'sound';
        if (from(qs._network) || from(qs._bluetooth) || from(qs._rfkill))
            return 'conn';
        if (from(qs._doNotDisturb))
            return 'focus';
        if (from(qs._backgroundApps))
            return 'wide';
        if (child instanceof QuickSlider)
            return 'wide';
        // Botões (do GNOME ou de outras extensões): telhas.
        return 'checked' in child && 'title' in child ? 'tile' : 'wide';
    }

    _apply() {
        const menu = this._qs?.menu;
        const grid = menu?._grid;
        if (!grid?.layout_manager?._overlay)
            return; // estrutura diferente da esperada: não mexemos
        this._menu = menu;
        this._grid = grid;
        this._original = grid.layout_manager;

        // Peças novas: fundos dos blocos, títulos e o "Tocando agora".
        const bg = role => {
            const actor = new St.Widget({style_class: 'aero-cc-block'});
            actor._aeroCcRole = role;
            return actor;
        };
        const title = (role, text) => {
            const label = new St.Label({style_class: 'aero-cc-block-title', text});
            label._aeroCcRole = role;
            return label;
        };
        this.blocks = {
            conn: bg('bg-conn'),
            display: {bg: bg('bg-display'), title: title('title-display', _('Display'))},
            sound: {bg: bg('bg-sound'), title: title('title-sound', _('Sound'))},
        };
        this._media = new MediaBlock();
        this._media.actor._aeroCcRole = 'media';
        this._backgrounds = [this.blocks.conn, this.blocks.display.bg, this.blocks.sound.bg];
        this._extras = [
            ...this._backgrounds,
            this.blocks.display.title, this.blocks.sound.title,
            this._media.actor,
        ];

        // Troca o layout, levando o "column-span" de cada botão.
        const spans = new Map();
        for (const child of grid)
            spans.set(child, this._original.get_child_meta(grid, child).column_span);
        this._layout = createControlCenterLayout(this._original, this);
        grid.layout_manager = this._layout;
        for (const [child, span] of spans)
            this._layout.get_child_meta(grid, child).column_span = span;

        for (const actor of this._extras)
            grid.add_child(actor);
        menu.box.add_style_class_name('aero-control-center');

        this._undo = new Map(); // botão → função que desfaz o visual
        grid.connectObject(
            'child-added', () => this._queueSync(),
            'child-removed', (_grid, child) => this._forget(child),
            this);
        this._active = true;
        this._sync();
    }

    /** Vários botões chegando juntos (login, outra extensão) = um ajuste só. */
    _queueSync() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            if (this._active)
                this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        // Fundos dos blocos SEMPRE por baixo de tudo (botões novos entram na
        // frente: o GNOME insere "antes do primeiro item").
        for (const actor of this._backgrounds)
            this._grid.set_child_below_sibling(actor, null);
        for (const child of this._grid) {
            if (!this._undo.has(child) && !child._aeroCcRole && child !== this._original._overlay)
                this._decorate(child);
        }
    }

    _decorate(child) {
        const role = this.roleOf(child);
        if (ROLE_CLASSES[role])
            this._undo.set(child, this._decorateToggle(child, role));
        else if ((role === 'display' || role === 'sound') && child instanceof QuickSlider)
            this._undo.set(child, this._decorateSlider(child));
        else
            this._undo.set(child, () => {});
    }

    /**
     * Botão no visual do macOS. O círculo do ícone vem do CSS; o FUNDO do
     * botão vai em estilo "em linha": cada tema pinta o botão ligado com
     * seletores fortes (às vezes com !important) e o estilo em linha é o
     * único que sempre vence — assim o centro de controle não depende do
     * tema. Ao passar o mouse, o fundo clareia.
     *
     * @param {QuickToggle|QuickMenuToggle} item
     * @param {string} role - 'conn', 'focus' ou 'tile'
     * @returns {Function} desfaz
     */
    _decorateToggle(item, role) {
        ROLE_CLASSES[role].forEach(c => item.add_style_class_name(c));
        // Botão com submenu: [conteúdo][separador][seta].
        const withMenu = item instanceof QuickMenuToggle;
        const inner = withMenu ? item._box?.get_first_child() ?? null : null;
        const arrow = withMenu ? item._menuButton ?? null : null;
        const separator = withMenu
            ? item._box?.get_children().find(c => c.has_style_class_name?.('quick-toggle-separator')) ?? null
            : null;
        const actors = [item, inner, arrow, separator].filter(Boolean);
        const saved = new Map(actors.map(a => [a, a.style]));

        const tile = role !== 'conn';
        const apply = () => {
            const bg = tile
                ? item.hover ? TILE_BG_HOVER : TILE_BG
                : item.hover ? ROW_BG_HOVER : 'transparent';
            item.style = `background-color: ${bg}; box-shadow: none; color: inherit; ` +
                `border-radius: ${tile ? 18 : 14}px; transition-duration: 150ms;`;
            if (inner)
                inner.style = 'background-color: transparent; box-shadow: none; color: inherit;';
            if (arrow) {
                arrow.style = `background-color: ${arrow.hover ? BUTTON_BG_HOVER : 'transparent'}; ` +
                    'box-shadow: none; color: inherit; border-radius: 99px;';
            }
            if (separator)
                separator.style = 'width: 0; background-color: transparent;';
        };
        item.connectObject('notify::hover', apply, 'notify::checked', apply, this);
        arrow?.connectObject('notify::hover', apply, this);
        apply();

        return () => {
            item.disconnectObject(this);
            arrow?.disconnectObject(this);
            for (const [actor, style] of saved)
                actor.style = style;
            ROLE_CLASSES[role].forEach(c => item.remove_style_class_name(c));
        };
    }

    /**
     * Barra grossa com o ícone DENTRO, como no macOS. O ícone original do
     * GNOME (um botão: no volume, ele liga/desliga o mudo) fica escondido e
     * um botão nosso, com o mesmo ícone e a mesma ação, vai para a ponta
     * esquerda da barra.
     *
     * @param {QuickSlider} item
     * @returns {Function} desfaz
     */
    _decorateSlider(item) {
        item.add_style_class_name('aero-cc-slider');
        const {slider, _iconButton: original} = item;
        if (!slider || !original)
            return () => item.remove_style_class_name('aero-cc-slider');

        const icon = new St.Icon({style_class: 'aero-cc-slider-icon'});
        const button = new St.Button({
            style_class: 'aero-cc-slider-icon-button',
            child: icon,
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const bindings = [
            item.bind_property('gicon', icon, 'gicon', GObject.BindingFlags.SYNC_CREATE),
            // Sem ação (brilho): o clique passa para a barra.
            item.bind_property('icon-reactive', button, 'reactive', GObject.BindingFlags.SYNC_CREATE),
        ];
        button.connect('clicked', () => item.emit('icon-clicked'));

        // A barra (St.DrawingArea) não desenha filhos: envolvemos a barra
        // numa caixa com BinLayout e pomos o ícone POR CIMA dela, na ponta
        // esquerda. A caixa ocupa o lugar da barra dentro do "sliderBin".
        const bin = slider.get_parent();
        const wrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Camada da largura toda por cima da barra, com o ícone na ponta
        // esquerda; ela não recebe cliques (só o ícone, quando tem ação).
        const overlay = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        overlay.add_child(button);
        bin.set_child(wrapper);
        wrapper.add_child(slider);
        wrapper.add_child(overlay);
        original.hide();

        return () => {
            bindings.forEach(b => b.unbind());
            wrapper.remove_child(slider);
            if (bin.get_parent())
                bin.set_child(slider);
            wrapper.destroy();
            original.show();
            item.remove_style_class_name('aero-cc-slider');
        };
    }

    _forget(child) {
        // Botão que saiu da grade (destruído, outra extensão desativada).
        this._undo.delete(child);
    }

    _revert() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        const grid = this._grid;
        grid.disconnectObject(this);

        for (const undo of this._undo.values())
            undo();
        this._undo.clear();

        for (const actor of this._extras)
            actor.get_parent()?.remove_child(actor);
        this._backgrounds.forEach(a => a.destroy());
        this.blocks.display.title.destroy();
        this.blocks.sound.title.destroy();
        this._media.destroy();
        this._menu.box.remove_style_class_name('aero-control-center');

        // Layout original de volta, com o "column-span" de cada botão.
        const spans = new Map();
        for (const child of grid)
            spans.set(child, this._layout.get_child_meta(grid, child).column_span);
        grid.layout_manager = this._original;
        for (const [child, span] of spans)
            this._original.get_child_meta(grid, child).column_span = span;

        this._layout._cc = null;
        this._layout = null;
        this.blocks = null;
        this._active = false;
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._active)
            this._revert();
    }
}
