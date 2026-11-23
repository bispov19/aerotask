// SPDX-License-Identifier: GPL-3.0-or-later
// "A cor da barra", num lugar só.
//
// As formas que saem da barra (o painel do relógio e os menus) precisam ter
// a MESMA cor que ela, para as duas parecerem uma peça só:
//   - estilo Preto ou Vidro: a cor que o AeroTask pinta na barra
//     (panelLook.js);
//   - estilo Padrão GNOME: a cor que o tema (ou o Blur my Shell) dá à barra.
//
// Quem usa escuta o sinal "changed" para se atualizar ao vivo.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {panelTint} from '../panelLook.js';

export class BarLook extends Signals.EventEmitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._tint = [0, 0, 0, 0.85];
        settings.connectObject(
            'changed::panel-style', () => this._update(),
            'changed::glass-opacity', () => this._update(),
            this);
        // O tema, o Blur my Shell ou o nosso estilo mudaram o painel.
        Main.panel.connectObject('style-changed', () => this._update(), this);
        this._update();
    }

    /** @returns {number[]} [r, g, b (0–255), alfa (0–1)] */
    get tint() {
        return this._tint;
    }

    /** Os menus da barra também usam o vidro fumê ("Menus no estilo Farol")? */
    get menusEnabled() {
        return this._settings.get_boolean('farol-menus');
    }

    _update() {
        let tint = panelTint(this._settings);
        if (!tint) {
            const c = Main.panel.get_theme_node().get_background_color();
            tint = [c.red, c.green, c.blue, c.alpha / 255];
        }
        if (tint.every((v, i) => Math.abs(v - this._tint[i]) < 0.001))
            return;
        this._tint = tint;
        this.emit('changed');
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.panel.disconnectObject(this);
    }
}
