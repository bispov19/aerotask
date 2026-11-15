// SPDX-License-Identifier: GPL-3.0-or-later
// "Manter Tela Ligada" — a mesma função da extensão Caffeine: enquanto
// ligada, a tela não apaga, não bloqueia sozinha e o computador não suspende
// por inatividade.
//
// Como funciona: pedimos ao gnome-session um "inibidor de ociosidade"
// (org.gnome.SessionManager.Inhibit com a flag 8 = IDLE). Quem decide apagar
// a tela, bloquear e suspender por inatividade (gsd-power e o próprio Shell)
// consulta esses inibidores. Desligar = Uninhibit(cookie). Se o Shell sair,
// o gnome-session apaga o inibidor sozinho (ele é ligado à nossa conexão).
//
// Não usamos a flag 4 (SUSPEND): ela bloquearia também a suspensão PEDIDA
// (fechar a tampa, Suspender no menu) — não é o que "tela ligada" quer dizer.
//
// Três peças:
//   - KeepAwake: o serviço. Vive na EXTENSÃO (como o Foco): sobrevive ao
//     bloqueio de tela, quando a interface é destruída.
//   - KeepAwakeIndicator: o botão nas Configurações Rápidas + a xícara na
//     barra enquanto ligado.
//   - KeepAwakeHud: o aviso no centro da tela, igual ao HUD de volume.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CenterHud} from './centerHud.js';
import {logError} from './util.js';

const SM_NAME = 'org.gnome.SessionManager';
const SM_PATH = '/org/gnome/SessionManager';
const SM_IFACE = 'org.gnome.SessionManager';
/** GsmInhibitorFlag: 8 = ociosidade (apagar tela, bloquear, suspender sozinho). */
const INHIBIT_IDLE = 8;

/**
 * O serviço. Emite 'changed' quando o estado EFETIVO muda (o inibidor
 * existe ou deixou de existir), e 'failed' se o gnome-session recusar.
 */
export class KeepAwake extends Signals.EventEmitter {
    /** @param {string} appId - identifica quem inibe (aparece no gnome-session) */
    constructor(appId) {
        super();
        this._appId = appId;
        this._wanted = false; // o que o usuário pediu
        this._cookie = null; // o inibidor que existe de fato
        this._busy = false;
        this._destroyed = false;
    }

    /** Ligado de fato (o inibidor existe)? */
    get active() {
        return this._cookie !== null;
    }

    /** O que o usuário pediu (o botão mostra isto, sem esperar o D-Bus). */
    get wanted() {
        return this._wanted;
    }

    toggle() {
        this.setWanted(!this._wanted);
    }

    /** @param {boolean} on */
    setWanted(on) {
        if (this._destroyed || on === this._wanted)
            return;
        this._wanted = on;
        this._sync();
    }

    /**
     * Leva o estado real até o pedido. Uma chamada por vez: se o usuário
     * clicar várias vezes enquanto o D-Bus responde, o laço confere de novo
     * no fim e corrige (nunca sobra inibidor "perdido").
     */
    async _sync() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            for (;;) {
                if (this._wanted && this._cookie === null) {
                    const reply = await Gio.DBus.session.call(SM_NAME, SM_PATH, SM_IFACE,
                        'Inhibit',
                        new GLib.Variant('(susu)', [this._appId, 0,
                            _('Keeping the screen on'), INHIBIT_IDLE]),
                        new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null);
                    [this._cookie] = reply.deepUnpack();
                    this._emit('changed');
                } else if (!this._wanted && this._cookie !== null) {
                    const cookie = this._cookie;
                    this._cookie = null;
                    this._emit('changed');
                    await this._uninhibit(cookie);
                } else {
                    break;
                }
            }
        } catch (e) {
            // Sem gnome-session (ex.: sessão aninhada) ou pedido recusado:
            // volta a "desligado" e avisa quem mostra o botão.
            logError(e, 'pedindo ao gnome-session para manter a tela ligada');
            this._wanted = false;
            this._emit('failed');
        } finally {
            this._busy = false;
        }
    }

    async _uninhibit(cookie) {
        try {
            await Gio.DBus.session.call(SM_NAME, SM_PATH, SM_IFACE, 'Uninhibit',
                new GLib.Variant('(u)', [cookie]), null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            logError(e, 'devolvendo o inibidor ao gnome-session');
        }
    }

    _emit(signal) {
        if (!this._destroyed)
            this.emit(signal);
    }

    destroy() {
        // Desligar a extensão desliga a função. Se um Inhibit ainda está a
        // caminho, o laço do _sync() vê "_wanted = false" quando a resposta
        // chegar e devolve o inibidor.
        this._destroyed = true;
        this._wanted = false;
        if (!this._busy && this._cookie !== null) {
            const cookie = this._cookie;
            this._cookie = null;
            this._uninhibit(cookie);
        }
    }
}

/** A xícara: com fumaça (ligado) ou sem (desligado). */
function cupIcon(iconsDir, on) {
    const name = on ? 'keep-awake-symbolic.svg' : 'keep-awake-off-symbolic.svg';
    return new Gio.FileIcon({file: iconsDir.get_child(name)});
}

/** O aviso no centro da tela, ao ligar e ao desligar. */
class KeepAwakeHud {
    /** @param {Gio.File} iconsDir */
    constructor(iconsDir) {
        this._iconsDir = iconsDir;
        this._hud = new CenterHud('aero-awake-hud');
        this._icon = new St.Icon({
            style_class: 'aero-awake-hud-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'aero-awake-hud-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hud.actor.add_child(this._icon);
        this._hud.actor.add_child(this._label);
    }

    /** @param {boolean} on */
    show(on) {
        this._icon.gicon = cupIcon(this._iconsDir, on);
        this._label.text = on ? _('Screen stays on') : _('Screen can turn off');
        this._hud.flash();
    }

    destroy() {
        this._hud.destroy();
    }
}

const KeepAwakeToggle = GObject.registerClass(
class AeroMenuKeepAwakeToggle extends QuickToggle {
    /**
     * @param {KeepAwake} service
     * @param {Gio.File} iconsDir
     */
    _init(service, iconsDir) {
        super._init({
            title: _('Keep Screen On'),
            gicon: cupIcon(iconsDir, true),
            toggle_mode: true,
        });
        this._service = service;
        this.checked = service.wanted;
        // O clique já inverte "checked" (toggle_mode); o serviço segue.
        this.connect('clicked', () => service.setWanted(this.checked));
    }
});

/** Botão nas Configurações Rápidas + xícara na barra enquanto ligado. */
export const KeepAwakeIndicator = GObject.registerClass(
class AeroMenuKeepAwakeIndicator extends SystemIndicator {
    /**
     * @param {KeepAwake} service
     * @param {Gio.Settings} settings
     * @param {Gio.File} iconsDir - pasta icons/ da extensão
     */
    _init(service, settings, iconsDir) {
        super._init();
        this._service = service;
        this._settings = settings;

        this._indicator = this._addIndicator();
        this._indicator.gicon = cupIcon(iconsDir, true);

        this._toggle = new KeepAwakeToggle(service, iconsDir);
        this.quickSettingsItems.push(this._toggle);

        this._hud = new KeepAwakeHud(iconsDir);

        service.connectObject(
            'changed', () => this._onChanged(),
            'failed', () => this._sync(),
            this);
        this._sync();

        Main.panel.statusArea.quickSettings.addExternalIndicator(this);
    }

    _sync() {
        this._toggle.checked = this._service.wanted;
        this._indicator.visible = this._service.active;
    }

    _onChanged() {
        this._sync();
        if (this._settings.get_boolean('alert-keep-awake'))
            this._hud.show(this._service.active);
    }

    destroy() {
        this._service.disconnectObject(this);
        this._hud.destroy();
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
