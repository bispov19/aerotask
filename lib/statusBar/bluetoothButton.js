// SPDX-License-Identifier: GPL-3.0-or-later
// Botão do Bluetooth na barra, com o pop-up do macOS:
//
//   Bluetooth                     [interruptor]
//   ─────────────────────────────────────────
//   DISPOSITIVOS
//   (●) Fone JBL                    Conectado
//   (○) Teclado
//   ─────────────────────────────────────────
//   Configurações de Bluetooth…
//
// O "cérebro" é o do GNOME: o BtClient de ui/status/bluetooth.js (o mesmo
// objeto que o menu de Configurações Rápidas usa). Ele lista os aparelhos
// pareados, liga/desliga o Bluetooth (pelo modo avião do gsd-rfkill, como o
// GNOME) e conecta/desconecta. Só a aparência do menu é nossa.
//
// Diferença proposital em relação ao GNOME: lá o ícone na barra só aparece
// com algum aparelho conectado; no macOS ele fica sempre lá (riscado quando
// desligado). Por isso o ícone e a visibilidade vêm do BOTÃO do GNOME (que
// existe sempre que há um adaptador), não do indicador da barra.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {openSettingsPanel} from '../actions.js';
import {logError} from '../util.js';
import {StatusMenuButton, SwitchHeaderItem, plainItem, separatorItem} from './common.js';

/** Uma linha de aparelho: ícone num círculo (azul = conectado), nome e estado. */
const DeviceItem = GObject.registerClass(
class AeroTaskBluetoothDeviceItem extends PopupMenu.PopupBaseMenuItem {
    _init(device, client) {
        super._init({style_class: 'aerotask-menu-item aerotask-status-device'});
        this._device = device;
        this._client = client;
        this._busy = false;

        this._icon = new St.Icon({
            style_class: 'aerotask-status-device-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        this._label = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);
        this.label_actor = this._label;

        this._status = new St.Label({
            style_class: 'aerotask-menu-accel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._status);

        this._spinner = new Spinner(16, {hideOnStop: true});
        this.add_child(this._spinner);

        device.connectObject(
            'notify::alias', () => this._sync(),
            'notify::icon', () => this._sync(),
            'notify::connected', () => this._sync(),
            'notify::connectable', () => this._sync(),
            this);
        this._sync();
    }

    get device() {
        return this._device;
    }

    _sync() {
        const dev = this._device;
        this._label.text = dev.alias ?? '';
        // Primeiro o simbólico (monocromático, como no macOS); depois o nome
        // que o aparelho informa; por fim o ícone do Bluetooth.
        const names = dev.icon ? [`${dev.icon}-symbolic`, dev.icon] : [];
        this._icon.gicon = Gio.ThemedIcon.new_from_names([...names, 'bluetooth-active-symbolic']);
        // Círculo azul = conectado (pseudo-classe :checked no CSS).
        if (dev.connected)
            this._icon.add_style_pseudo_class('checked');
        else
            this._icon.remove_style_pseudo_class('checked');
        this._status.text = dev.connected ? _('Connected') : '';
        this._status.visible = !this._busy;
        // Aparelho que não pode ser conectado agora (ex.: fora de alcance).
        this.visible = dev.connectable !== false;
        this.accessible_name = dev.connected
            ? _('Disconnect %s').format(dev.alias)
            : _('Connect to %s').format(dev.alias);
    }

    /** Clique: conecta/desconecta e o menu continua aberto (como no macOS). */
    activate(_event) {
        if (this._busy)
            return;
        this._toggle().catch(e => logError(e, 'Bluetooth: conectando'));
    }

    async _toggle() {
        this._busy = true;
        this._spinner.play();
        this._sync();
        try {
            await this._client.toggleDevice(this._device);
        } finally {
            // O item pode ter sido destruído enquanto esperávamos.
            if (this._spinner) {
                this._busy = false;
                this._spinner.stop();
                this._sync();
            }
        }
    }

    destroy() {
        this._spinner = null;
        super.destroy();
    }
});

export const BluetoothButton = GObject.registerClass(
class AeroTaskBluetoothButton extends StatusMenuButton {
    /**
     * @param {object} indicator - o Indicator de Bluetooth do GNOME (qs._bluetooth)
     * @param {() => object} getAppearance
     */
    _init(indicator, getAppearance) {
        super._init(_('Bluetooth'), getAppearance);
        this._client = indicator._client;
        this._items = new Map(); // caminho D-Bus do aparelho → DeviceItem

        // O botão "Bluetooth" das Configurações Rápidas do GNOME.
        const toggle = indicator.quickSettingsItems[0];
        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this._bindings = [
            toggle.bind_property('icon-name', this._icon, 'icon-name',
                GObject.BindingFlags.SYNC_CREATE),
            toggle.bind_property('visible', this, 'visible',
                GObject.BindingFlags.SYNC_CREATE),
        ];

        this._client.connectObject(
            'notify::active', () => this._sync(),
            'devices-changed', () => this._sync(),
            'device-removed', (_c, path) => this._removeItem(path),
            this);
        // Conteúdo pronto desde já (a 1ª abertura fica igual às outras).
        this._buildMenu();
        this._sync();
    }

    _buildMenu() {
        this._switch = new SwitchHeaderItem(_('Bluetooth'));
        this._switch.connect('toggled', (_item, state) => {
            if (state !== this._client.active)
                this._client.toggleActive();
        });
        this.menu.addMenuItem(this._switch);

        this._listSeparator = separatorItem();
        this.menu.addMenuItem(this._listSeparator);

        this._header = plainItem(_('Devices'), false);
        this._header.add_style_class_name('aerotask-menu-header');
        this.menu.addMenuItem(this._header);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);

        this._placeholder = plainItem('', false);
        this._placeholder.add_style_class_name('aerotask-status-placeholder');
        this.menu.addMenuItem(this._placeholder);

        this.menu.addMenuItem(separatorItem());
        const settings = plainItem(_('Bluetooth Settings…'));
        settings.connect_after('activate', () => openSettingsPanel('bluetooth'));
        this.menu.addMenuItem(settings);
    }

    _onMenuOpen() {
        this._sync();
    }

    /** Aparelhos pareados, os conectados primeiro e depois por nome (como o GNOME). */
    _sortedDevices() {
        return [...this._client.getDevices()].sort((a, b) => {
            if (a.connected !== b.connected)
                return b.connected - a.connected;
            return (a.alias ?? '').localeCompare(b.alias ?? '');
        });
    }

    _sync() {
        const active = this._client.active;
        this._switch.setStateQuietly(active);

        const devices = active ? this._sortedDevices() : [];
        const paths = new Set(devices.map(d => d.get_object_path()));
        for (const path of [...this._items.keys()]) {
            if (!paths.has(path))
                this._removeItem(path);
        }
        devices.forEach((device, i) => {
            const path = device.get_object_path();
            let item = this._items.get(path);
            if (!item) {
                item = new DeviceItem(device, this._client);
                item.connect('notify::visible', () => this._syncPlaceholder());
                this._items.set(path, item);
                this._list.addMenuItem(item, i);
            } else {
                this._list.moveMenuItem(item, i);
            }
        });
        this._syncPlaceholder();
    }

    _removeItem(path) {
        this._items.get(path)?.destroy();
        this._items.delete(path);
        this._syncPlaceholder();
    }

    _syncPlaceholder() {
        const active = this._client.active;
        const anyVisible = [...this._items.values()].some(item => item.visible);
        this._header.visible = active && anyVisible;
        this._list.actor.visible = active && anyVisible;
        this._placeholder.label.text = active
            ? _('No available or connected devices')
            : _('Turn on Bluetooth to connect to devices');
        this._placeholder.visible = !anyVisible;
    }

    destroy() {
        this._bindings.forEach(b => b.unbind());
        this._bindings = [];
        this._client.disconnectObject(this);
        this._items.clear();
        super.destroy();
    }
});
