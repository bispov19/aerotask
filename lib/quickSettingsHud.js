// SPDX-License-Identifier: GPL-3.0-or-later
// Botões das Configurações Rápidas → o HUD do centro da tela.
//
// Ao USAR um botão (Wi-Fi, Bluetooth, Modo de energia, Luz noturna, Estilo
// escuro, Não perturbe, Teclado, Modo avião, Manter Tela Ligada, botões de
// outras extensões…), o HUD mostra o ícone, o nome e o novo estado:
//
//        ╭──────────────────╮
//        │        ✈         │
//        │   Modo avião     │
//        │     Ativado      │
//        ╰──────────────────╯
//
// Genérico: vale para qualquer QuickToggle/QuickMenuToggle que entrar na
// grade (inclusive os criados depois, por outras extensões).
//
// Só reage a USO: um clique no botão ou uma escolha no submenu dele "arma"
// o botão por alguns segundos, e só as mudanças nesse intervalo aparecem.
// Assim nada pisca sozinho (ex.: o Bluetooth religando ao voltar da
// suspensão). Teclas de função (modo avião…) já chegam pelo OSD do GNOME.
//
// O estado é lido um instante DEPOIS da mudança: vários botões atualizam o
// ícone e o subtítulo logo em seguida (o Wi-Fi só muda quando o
// NetworkManager confirma).

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickMenuToggle, QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {T} from './island/strings.js';
import {TimeoutRegistry} from './util.js';

/** Depois de um clique, por quanto tempo as mudanças do botão contam (ms). */
const ARMED_TIME = 3000;
/** Espera para o botão terminar de se atualizar (ms). */
const SETTLE_TIME = 120;

export class QuickSettingsHud {
    /**
     * @param {Gio.Settings} settings
     * @param {OsdHud} hud - o HUD do centro da tela
     */
    constructor(settings, hud) {
        this._settings = settings;
        this._hud = hud;
        this._timers = new TimeoutRegistry();
        this._items = new Map(); // botão → {checked, subtitle, armedUntil, settleId, levelId}

        // A grade de botões das Configurações Rápidas (interna do Shell:
        // QuickSettingsMenu._grid; addItem() põe os botões ali).
        this._grid = Main.panel.statusArea.quickSettings?.menu?._grid ?? null;
        if (!this._grid)
            return;
        this._grid.connectObject(
            'child-added', (_grid, child) => this._watch(child),
            'child-removed', (_grid, child) => this._unwatch(child),
            this);
        for (const child of this._grid.get_children())
            this._watch(child);
    }

    _watch(item) {
        if (this._items.has(item))
            return;
        if (!(item instanceof QuickToggle || item instanceof QuickMenuToggle))
            return;
        this._items.set(item, {
            checked: item.checked,
            subtitle: item.subtitle,
            armedUntil: 0,
            settleId: 0,
            levelId: 0,
        });
        item.connectObject(
            // Botão com toggle_mode inverte o "checked" ANTES do "clicked":
            // a mudança chega primeiro e é conferida depois (_settle).
            'clicked', () => this._arm(item),
            'notify::checked', () => this._queueSettle(item),
            'notify::subtitle', () => this._queueSettle(item),
            'destroy', () => this._unwatch(item),
            this);
        // Escolha no submenu (Modo de energia, rede Wi-Fi…).
        item.menu?.connectObject?.('activate', () => this._arm(item), this);
        // Teclado: o nível escolhido no submenu não gera o aviso do GNOME.
        for (const level of this._levelItems(item))
            level.connectObject('notify::value', () => this._queueLevel(item, level), this);
    }

    /** Controles de nível dentro do submenu (só o botão "Teclado" tem). */
    _levelItems(item) {
        return [item._sliderItem, item._discreteItem]
            .filter(level => level && typeof level.connectObject === 'function');
    }

    _unwatch(item) {
        const state = this._items.get(item);
        if (!state)
            return;
        this._timers.remove(state.settleId);
        this._timers.remove(state.levelId);
        item.disconnectObject(this);
        item.menu?.disconnectObject?.(this);
        for (const level of this._levelItems(item))
            level.disconnectObject(this);
        this._items.delete(item);
    }

    _arm(item) {
        const state = this._items.get(item);
        if (!state)
            return;
        state.armedUntil = Date.now() + ARMED_TIME;
        this._queueSettle(item);
    }

    _queueSettle(item) {
        const state = this._items.get(item);
        if (!state || state.settleId)
            return;
        state.settleId = this._timers.add(SETTLE_TIME, () => {
            state.settleId = 0;
            this._settle(item, state);
        });
    }

    _settle(item, state) {
        const checkedChanged = item.checked !== state.checked;
        const subtitleChanged = item.subtitle !== state.subtitle;
        state.checked = item.checked;
        state.subtitle = item.subtitle;
        if (!checkedChanged && !subtitleChanged)
            return;
        if (Date.now() > state.armedUntil || !this._settings.get_boolean('alert-quick-settings'))
            return;

        // Botão com submenu que mostra a opção escolhida no subtítulo (Modo
        // de energia → "Desempenho"): o estado é o subtítulo. Desligar, ou
        // botão sem subtítulo: "Ativado"/"Desativado".
        const useSubtitle = item instanceof QuickMenuToggle && subtitleChanged &&
            Boolean(item.subtitle) && (item.checked || !checkedChanged);
        const detail = useSubtitle ? item.subtitle
            : item.checked ? T.turnedOn : T.turnedOff;
        this._hud.show({
            icon: this._iconOf(item),
            caption: item.title,
            detail,
        });
    }

    _queueLevel(item, level) {
        const state = this._items.get(item);
        // Só com o submenu aberto (é você mexendo); o aviso de quando o
        // nível muda sozinho é do GNOME.
        if (!state || !item.menu?.isOpen || !this._settings.get_boolean('alert-brightness'))
            return;
        this._timers.remove(state.levelId);
        state.levelId = this._timers.add(SETTLE_TIME / 2, () => {
            state.levelId = 0;
            this._hud.show({
                icon: new Gio.ThemedIcon({name: 'keyboard-brightness-symbolic'}),
                level: Math.max(0, Math.min(level.value, 100)) / 100,
            });
        });
    }

    _iconOf(item) {
        if (item.gicon)
            return item.gicon;
        return new Gio.ThemedIcon({name: item.icon_name || 'emblem-system-symbolic'});
    }

    destroy() {
        this._grid?.disconnectObject(this);
        for (const item of [...this._items.keys()])
            this._unwatch(item);
        this._timers.clear();
    }
}
