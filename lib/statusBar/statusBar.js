// SPDX-License-Identifier: GPL-3.0-or-later
// Ícones de status da barra no estilo do macOS:
//
//   … [localização, bateria…] [Bluetooth] [Wi-Fi] [centro de controle] [relógio]
//
//   - Wi-Fi e Bluetooth viram botões PRÓPRIOS, cada um com o seu pop-up
//     (redes / aparelhos), e somem de dentro do menu de status do GNOME;
//   - o botão do centro de controle (dois interruptores) abre as
//     Configurações Rápidas;
//   - o ícone de volume sai da barra (o som fica no centro de controle).
//
// Cada parte tem a sua chave nas preferências e muda ao vivo. Tudo o que é
// do GNOME só é escondido (VisibilityGuard) e volta ao desativar.
//
// Espaçamento: todos os botões de ícone (estes, o menu de status do GNOME e
// os ícones de bandeja) recebem a classe STATUS_BUTTON_CLASS. No CSS ela dá
// a MESMA distância (12 px) entre dois ícones vizinhos, estejam eles no
// mesmo botão ou em botões diferentes.

import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BluetoothButton} from './bluetoothButton.js';
import {ControlCenterButton} from './controlCenterButton.js';
import {STATUS_BUTTON_CLASS, VisibilityGuard} from './common.js';
import {WifiButton} from './wifiButton.js';

const ROLES = {
    bluetooth: 'aerotask-bluetooth',
    wifi: 'aerotask-wifi',
    controlCenter: 'aerotask-control-center',
};

export class StatusBar {
    /**
     * @param {Gio.Settings} settings
     * @param {object} host - {getAppearance(), iconsDir}
     */
    constructor(settings, host) {
        this._settings = settings;
        this._host = host;
        this._quick = Main.panel.statusArea.quickSettings ?? null;
        this._ready = false;
        this._buttons = {wifi: null, bluetooth: null, controlCenter: null};
        this._guards = {wifi: null, bluetooth: null, volume: null};
        this._laterId = 0;

        if (!this._quick)
            return;
        this._quick.add_style_class_name(STATUS_BUTTON_CLASS);

        settings.connectObject(
            'changed::status-wifi-bluetooth-menus', () => this._sync(),
            'changed::status-control-center-button', () => this._sync(),
            'changed::status-show-volume', () => this._sync(),
            this);
        this._waitForIndicators();
    }

    /**
     * No login, o GNOME cria os indicadores de forma ASSÍNCRONA
     * (`_setupIndicators` em ui/panel.js) e põe o da bateria (`_system`) por
     * último. Quando ele tem pai, todos os outros (rede, Bluetooth, volume)
     * já existem.
     */
    _waitForIndicators() {
        if (this._quick._system?.get_parent()) {
            this._ready = true;
            this._quick._indicators.disconnectObject(this);
            this._sync();
            return;
        }
        this._quick._indicators.connectObject('child-added',
            () => this._waitForIndicators(), this);
    }

    _sync() {
        if (!this._ready)
            return;
        const settings = this._settings;
        const menus = settings.get_boolean('status-wifi-bluetooth-menus');
        const network = this._quick._network ?? null;
        const bluetooth = this._quick._bluetooth ?? null;

        // A ordem de criação define a ordem na barra (logo depois do menu de
        // status do GNOME): Bluetooth, Wi-Fi, centro de controle.
        this._setButton('bluetooth', menus && bluetooth,
            () => new BluetoothButton(bluetooth, this._host.getAppearance));
        this._setButton('wifi', menus && network?._wirelessToggle,
            () => new WifiButton(network._wirelessToggle, this._host.getAppearance));
        this._setButton('controlCenter', settings.get_boolean('status-control-center-button'),
            () => new ControlCenterButton(this._quick, this._host.iconsDir));

        // Ícones do GNOME que viraram botões próprios: escondidos.
        this._setGuard('bluetooth', menus && bluetooth, () => new VisibilityGuard(
            bluetooth, () => true, () => bluetooth._syncIndicatorsVisible()));
        const primary = network?._primaryIndicator;
        this._setGuard('wifi', menus && primary, () => new VisibilityGuard(
            primary,
            // Só o ícone de Wi-Fi: com cabo, o ícone de rede com fio fica.
            () => (primary.icon_name ?? '').startsWith('network-wireless'),
            // O GNOME recalcula se o ícone de rede deve aparecer. Fora do
            // sinal atual (pode estar no meio do _updateIcon dele).
            () => this._later(() => network._updateIcon?.()),
            ['notify::icon-name']));
        const volume = this._quick._volumeOutput;
        this._setGuard('volume', !settings.get_boolean('status-show-volume') && volume,
            () => new VisibilityGuard(volume, () => true,
                () => volume._syncIndicatorsVisible()));
    }

    _setButton(key, wanted, create) {
        const current = this._buttons[key];
        if (wanted && !current) {
            const button = create();
            this._buttons[key] = button;
            Main.panel.addToStatusArea(ROLES[key], button, this._insertIndex(key), 'right');
        } else if (!wanted && current) {
            current.destroy();
            this._buttons[key] = null;
        }
    }

    /**
     * Posição na caixa da direita: logo depois do menu de status do GNOME e
     * dos nossos botões que vêm antes deste (Bluetooth → Wi-Fi → centro de
     * controle), mesmo quando um deles é ligado depois pelas preferências.
     */
    _insertIndex(key) {
        const box = Main.panel._rightBox;
        const order = Object.keys(ROLES);
        let anchor = this._quick.container;
        for (const other of order.slice(0, order.indexOf(key))) {
            const container = this._buttons[other]?.container;
            if (container?.get_parent() === box)
                anchor = container;
        }
        const index = box.get_children().indexOf(anchor);
        return index < 0 ? box.get_n_children() : index + 1;
    }

    /** Roda `fn` antes do próximo quadro (fora do sinal que está tocando). */
    _later(fn) {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            fn();
            return false;
        });
    }

    _setGuard(key, wanted, create) {
        if (wanted && !this._guards[key]) {
            this._guards[key] = create();
        } else if (!wanted && this._guards[key]) {
            this._guards[key].destroy();
            this._guards[key] = null;
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._quick?._indicators?.disconnectObject(this);
        for (const key of Object.keys(this._guards)) {
            this._guards[key]?.destroy();
            this._guards[key] = null;
        }
        // O ícone de rede devolvido acima é recalculado pelo GNOME já aqui
        // (sem esperar um "later" que ficaria pendurado depois do disable).
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
            this._quick?._network?._updateIcon?.();
        }
        for (const key of Object.keys(this._buttons)) {
            this._buttons[key]?.destroy();
            this._buttons[key] = null;
        }
        this._quick?.remove_style_class_name(STATUS_BUTTON_CLASS);
        this._quick = null;
    }
}
