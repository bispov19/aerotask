// SPDX-License-Identifier: GPL-3.0-or-later
// Os ícones de bandeja na barra: um botão (TrayButton) para cada programa
// registrado no StatusNotifierWatcher, à esquerda do menu de status do GNOME
// (como os ícones da barra do macOS, antes da Central de Controle).
//
// O watcher (o serviço D-Bus) vive na EXTENSÃO — continua com a tela
// bloqueada, para os programas não perderem o registro. Esta parte (os
// botões) é da interface: some ao bloquear e volta ao desbloquear, lendo os
// ícones que o watcher já conhece.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TrayButton} from './trayButton.js';
import {logError} from '../util.js';

/** Programas vistos, para a lista das preferências ("id<TAB>título"). */
const KNOWN_KEY = 'tray-known-items';
const MAX_KNOWN = 40;

export class TrayIcons {
    /**
     * @param {Gio.Settings} settings
     * @param {object} host - {getAppearance(), getMenuOptions()}
     */
    constructor(settings, host) {
        this._settings = settings;
        this._host = {
            ...host,
            remember: (key, title) => this._remember(key, title),
        };
        this._buttons = new Map(); // id → TrayButton
        this._watcher = null;
    }

    /** O watcher mudou (ligado/desligado nas preferências, conflito…). */
    setWatcher(watcher) {
        if (watcher === this._watcher)
            return;
        this._watcher?.disconnectObject(this);
        this._clear();
        this._watcher = watcher;
        if (!watcher)
            return;
        watcher.connectObject(
            'item-added', (_w, id, bus, path) => this._add(id, bus, path),
            'item-removed', (_w, id) => this._remove(id),
            this);
        for (const [id, {bus, path}] of watcher.items)
            this._add(id, bus, path);
    }

    _add(id, bus, path) {
        if (this._buttons.has(id))
            return;
        try {
            const button = new TrayButton({id, bus, path}, this._settings, this._host);
            this._buttons.set(id, button);
            // À esquerda do menu de status do GNOME (Wi-Fi, som, bateria…).
            const box = Main.panel._rightBox;
            const quick = Main.panel.statusArea.quickSettings?.container;
            const index = quick ? Math.max(0, box.get_children().indexOf(quick)) : 0;
            Main.panel.addToStatusArea(`aerotask-tray:${id}`, button, index, 'right');
        } catch (e) {
            logError(e, `bandeja: criando o ícone ${id}`);
        }
    }

    _remove(id) {
        const button = this._buttons.get(id);
        this._buttons.delete(id);
        // destroy() tira o botão da barra e o menu do gerenciador de menus.
        button?.destroy();
    }

    _clear() {
        for (const id of [...this._buttons.keys()])
            this._remove(id);
    }

    /** Guarda o programa na lista das preferências (só quando é novo). */
    _remember(key, title) {
        const known = this._settings.get_strv(KNOWN_KEY);
        const entry = `${key}\t${title}`;
        if (known.includes(entry))
            return;
        const others = known.filter(k => k.split('\t')[0] !== key);
        this._settings.set_strv(KNOWN_KEY, [entry, ...others].slice(0, MAX_KNOWN));
    }

    setAppearance(appearance) {
        for (const button of this._buttons.values())
            button.setAppearance(appearance);
    }

    destroy() {
        this._watcher?.disconnectObject(this);
        this._watcher = null;
        this._clear();
    }
}
