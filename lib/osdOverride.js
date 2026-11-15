// SPDX-License-Identifier: GPL-3.0-or-later
// O ÚNICO ponto que intercepta o "OSD" do GNOME (a caixinha de volume/brilho).
//
// Quem mostra o OSD:
//   - teclas de volume/brilho/brilho do teclado: o gsd-media-keys chama
//     org.gnome.Shell.ShowOSD → Main.osdWindowManager.showOne(...);
//   - rolar o mouse no ícone de volume: volume.js → showAll(...);
//   - teclas de brilho da tela: brightnessManager.js → show(...).
//
// Interceptamos os três métodos com o InjectionManager do GNOME (a forma
// oficial de "remendar" o Shell; clear() devolve os originais) e repassamos
// cada tipo para quem se registrou:
//   - 'volume'   → o HUD de volume no centro da tela (extensão);
//   - 'brightness', 'keyboard' → os alertas que saem do relógio.
// Sem ninguém registrado (ou se ele recusar), segue o OSD original — nunca
// aparecem dois indicadores.
//
// Por que um ponto só? Duas extensões (ou duas partes da mesma) remendando o
// mesmo método e desfazendo em ordem diferente deixariam um remendo "órfão".

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

export class OsdOverride {
    constructor() {
        this._handlers = new Map(); // tipo → (osd) => boolean
        this._injections = new InjectionManager();

        const self = this;
        const osd = Main.osdWindowManager;
        this._injections.overrideMethod(osd, 'showAll', original =>
            function(icon, label, level, maxLevel) {
                if (!self._dispatch(icon, label, level, maxLevel))
                    original.call(this, icon, label, level, maxLevel);
            });
        this._injections.overrideMethod(osd, 'showOne', original =>
            function(monitorIndex, icon, label, level, maxLevel) {
                if (!self._dispatch(icon, label, level, maxLevel))
                    original.call(this, monitorIndex, icon, label, level, maxLevel);
            });
        this._injections.overrideMethod(osd, 'show', original =>
            function(icon, label, levels) {
                // Brilho por monitor: usamos o do monitor principal (ou o
                // primeiro que vier).
                const entry = levels?.[Main.layoutManager.primaryIndex] ??
                    Object.values(levels ?? {})[0];
                if (!entry || !self._dispatch(icon, label, entry.level, entry.maxLevel))
                    original.call(this, icon, label, levels);
            });
    }

    /**
     * @param {string} kind - 'volume', 'brightness' ou 'keyboard'
     * @param {Function|null} handler - (osd) => boolean; true = mostrou
     */
    setHandler(kind, handler) {
        if (handler)
            this._handlers.set(kind, handler);
        else
            this._handlers.delete(kind);
    }

    /** @returns {boolean} true = alguém mostrou (o OSD original não aparece) */
    _dispatch(icon, label, level, maxLevel) {
        if (level === null || level === undefined || !icon)
            return false;
        const name = iconName(icon);
        const kind = name.startsWith('audio-volume') ? 'volume'
            : name.startsWith('display-brightness') ? 'brightness'
                : name.startsWith('keyboard-brightness') ? 'keyboard'
                    : null; // microfone, touchpad… seguem para o OSD do GNOME
        const handler = kind && this._handlers.get(kind);
        if (!handler)
            return false;
        const shown = handler({
            kind,
            icon,
            name,
            label,
            level,
            maxLevel: maxLevel > 0 ? maxLevel : 1,
            muted: name.includes('muted'),
        });
        if (!shown)
            return false;
        // Se o OSD do GNOME estava na tela (de antes), some com ele.
        Main.osdWindowManager.hideAll();
        return true;
    }

    destroy() {
        this._handlers.clear();
        this._injections.clear();
    }
}

/**
 * Nome do ícone (ex.: "audio-volume-high-symbolic") de um Gio.Icon.
 *
 * @param {Gio.Icon} icon
 * @returns {string}
 */
export function iconName(icon) {
    if (icon instanceof Gio.ThemedIcon)
        return icon.get_names()[0] ?? '';
    return icon?.to_string?.() ?? '';
}
