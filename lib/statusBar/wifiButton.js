// SPDX-License-Identifier: GPL-3.0-or-later
// Botão do Wi-Fi na barra, com o pop-up de redes do macOS:
//
//   Wi-Fi                         [interruptor]
//   ─────────────────────────────────────────
//   REDES                              (girando enquanto procura)
//   ✓ Minha Casa                   🔒 ▂▄▆
//     Vizinho                      🔒 ▂▄
//   ─────────────────────────────────────────
//   Configurações de Wi-Fi…
//
// Nada de lógica de rede própria: a lista é o MESMO item que o GNOME usa no
// menu dele (NMWirelessDeviceItem, de ui/status/network.js), criado pelo
// método do próprio botão de Wi-Fi do GNOME (`_createDeviceMenuItem`). Ele já
// sabe ordenar (conhecidas primeiro, depois pelo sinal), conectar, pedir a
// senha (o diálogo de senha do GNOME), abrir as Configurações para redes
// corporativas (802.1x) e se atualizar quando as redes mudam. Criamos uma
// cópia SÓ NOSSA (não mexemos na lista do centro de controle).
//
// O ícone e a visibilidade vêm do botão de Wi-Fi das Configurações Rápidas
// (`NMWirelessToggle`): ícone de sinal, "desligado", "conectando"… e some se
// o computador não tem Wi-Fi.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {openSettingsPanel} from '../actions.js';
import {logError} from '../util.js';
import {StatusMenuButton, SwitchHeaderItem, plainItem, separatorItem} from './common.js';

/** Igual ao GNOME (WIFI_SCAN_FREQUENCY em ui/status/network.js). */
const SCAN_INTERVAL = 15; // s
/** Quanto esperar o fim de uma busca antes de desistir. */
const SCAN_TIMEOUT = 10000; // ms
const SCAN_POLL = 500; // ms

export const WifiButton = GObject.registerClass(
class AeroTaskWifiButton extends StatusMenuButton {
    /**
     * @param {object} toggle - o NMWirelessToggle do GNOME
     * @param {() => object} getAppearance
     */
    _init(toggle, getAppearance) {
        super._init(_('Wi-Fi'), getAppearance);
        this._toggle = toggle;
        this._client = null;
        this._items = new Map(); // NM.Device → item de lista do GNOME
        this._scanId = 0;
        this._scanning = 0; // buscas em andamento
        this._pollIds = new Set();

        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        // Acompanha o botão do GNOME (ligações desfeitas no destroy).
        this._bindings = [
            toggle.bind_property('icon-name', this._icon, 'icon-name',
                GObject.BindingFlags.SYNC_CREATE),
            toggle.bind_property('visible', this, 'visible',
                GObject.BindingFlags.SYNC_CREATE),
        ];
        // O conteúdo existe desde já: a 1ª abertura fica igual às outras (o
        // Blur my Shell mede o pop-up quando ele aparece).
        this._buildMenu();
        this._ensureClient();
        this._sync();
    }

    _buildMenu() {
        this._switch = new SwitchHeaderItem(_('Wi-Fi'));
        this._switch.connect('toggled', (_item, state) => {
            // Só age se o pedido é diferente do estado real (o interruptor
            // também é movido por nós quando o Wi-Fi muda por fora).
            if (this._client && state !== this._client.wireless_enabled)
                this._toggle.activate(); // o mesmo que clicar no botão do GNOME
        });
        // Sem permissão (polkit) ou com a chave física desligada: cinza.
        this._bindings.push(this._toggle.bind_property('reactive',
            this._switch, 'reactive', GObject.BindingFlags.SYNC_CREATE));
        this.menu.addMenuItem(this._switch);

        this._listSeparator = separatorItem();
        this.menu.addMenuItem(this._listSeparator);

        this._header = plainItem(_('Networks'), false);
        this._header.add_style_class_name('aerotask-menu-header');
        this._spinner = new Spinner(16, {hideOnStop: true});
        this._spinner.x_expand = true;
        this._spinner.x_align = Clutter.ActorAlign.END;
        this._header.add_child(this._spinner);
        this.menu.addMenuItem(this._header);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);

        this.menu.addMenuItem(separatorItem());
        const settings = plainItem(_('Wi-Fi Settings…'));
        settings.connect_after('activate', () => openSettingsPanel('wifi'));
        this.menu.addMenuItem(settings);
    }

    _onMenuOpen() {
        this._ensureClient();
        this._sync();
        this._startScanning();
    }

    _onMenuClose() {
        this._stopScanning();
    }

    /**
     * O cliente do NetworkManager é o do GNOME (criado de forma assíncrona
     * no login). O botão só aparece depois que ele existe, então na hora do
     * clique ele já está lá.
     */
    _ensureClient() {
        const client = this._toggle._client ?? null;
        if (client === this._client)
            return;
        this._client?.disconnectObject(this);
        this._items.forEach(item => item.destroy());
        this._items.clear();

        this._client = client;
        if (!client)
            return;
        client.connectObject(
            'notify::wireless-enabled', () => this._sync(),
            'device-added', () => this._syncDevices(),
            'device-removed', () => this._syncDevices(),
            this);
        this._syncDevices();
    }

    /** Um item de lista (do GNOME) por placa de Wi-Fi. */
    _syncDevices() {
        const devices = (this._client?.get_devices() ?? [])
            .filter(d => d.get_device_type() === NM.DeviceType.WIFI);

        for (const [device, item] of this._items) {
            if (!devices.includes(device)) {
                item.destroy();
                this._items.delete(device);
            }
        }
        const names = NM.Device.disambiguate_names(devices);
        devices.forEach((device, i) => {
            let item = this._items.get(device);
            if (!item) {
                try {
                    item = this._toggle._createDeviceMenuItem(device);
                } catch (e) {
                    logError(e, 'Wi-Fi: criando a lista de redes');
                    return;
                }
                this._items.set(device, item);
                this._list.addMenuItem(item);
                this._adoptItems(item);
            }
            item.setDeviceName(names[i]);
            // Uma placa só: as redes aparecem direto (sem submenu).
            item.single_device_mode = devices.length === 1;
        });
        this._sync();
    }

    /**
     * As linhas de rede do GNOME ganham o visual dos itens do AeroTask
     * (destaque azul, cantos, espaçamento), inclusive as que chegarem depois.
     */
    _adoptItems(deviceItem) {
        const box = deviceItem.section.box;
        const adopt = child => child.add_style_class_name?.('aerotask-menu-item');
        box.get_children().forEach(adopt);
        box.connectObject('child-added', (_b, child) => adopt(child), this);
    }

    _sync() {
        const enabled = Boolean(this._client?.wireless_enabled);
        this._switch.setStateQuietly(enabled);
        // Wi-Fi desligado: só o interruptor e as Configurações (como no macOS).
        this._listSeparator.visible = enabled;
        this._header.visible = enabled;
        this._list.actor.visible = enabled;
    }

    // ----- Busca de redes (só com o pop-up aberto) -----------------------------

    _startScanning() {
        this._stopScanning();
        this._scanAll();
        this._scanId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SCAN_INTERVAL, () => {
            this._scanAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopScanning() {
        if (this._scanId)
            GLib.source_remove(this._scanId);
        this._scanId = 0;
        this._pollIds.forEach(id => GLib.source_remove(id));
        this._pollIds.clear();
        this._scanning = 0;
        this._spinner?.stop();
    }

    _scanAll() {
        if (!this._client?.wireless_enabled)
            return;
        for (const device of this._items.keys())
            this._scan(device);
    }

    /**
     * Pede uma busca à placa. A busca termina quando `last-scan` muda (o
     * mesmo critério do GNOME); enquanto isso o ícone gira no título.
     */
    _scan(device) {
        const lastScan = device.last_scan;
        this._scanning++;
        this._spinner.play();
        const done = () => {
            this._scanning = Math.max(0, this._scanning - 1);
            if (this._scanning === 0)
                this._spinner?.stop();
        };
        // O GNOME já "promisificou" request_scan_async (ui/status/network.js).
        device.request_scan_async(null).catch(() => {
            // Busca recusada (ex.: placa ocupada, busca recente): não é erro.
        });
        let waited = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCAN_POLL, () => {
            waited += SCAN_POLL;
            if (device.last_scan !== lastScan || waited >= SCAN_TIMEOUT) {
                this._pollIds.delete(id);
                done();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._pollIds.add(id);
    }

    destroy() {
        this._stopScanning();
        this._bindings.forEach(b => b.unbind());
        this._bindings = [];
        this._client?.disconnectObject(this);
        this._client = null;
        this._items.clear(); // os itens morrem junto com o menu
        super.destroy();
    }
});
