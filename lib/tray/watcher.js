// SPDX-License-Identifier: GPL-3.0-or-later
// O "cartório" dos ícones de bandeja: o serviço org.kde.StatusNotifierWatcher.
//
// Programas com ícone de bandeja (protocolos StatusNotifierItem/KDE e
// AppIndicator/Ayatana — Discord, Steam, Telegram, Nextcloud…) procuram este
// nome no barramento de sessão e se registram nele ("tenho um ícone em tal
// endereço"). A barra (o "host") pergunta aqui quais ícones existem e é
// avisada quando um entra ou sai.
//
// Quando um programa fecha (sai do barramento), o ícone dele sai junto: o
// próprio barramento avisa (bus_watch_name), sem verificar de tempos em tempos.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {debug, logError} from '../util.js';

const BUS_NAME = 'org.kde.StatusNotifierWatcher';
const OBJECT_PATH = '/StatusNotifierWatcher';
/** Caminho padrão do objeto do ícone, quando o programa só manda o nome. */
const DEFAULT_ITEM_PATH = '/StatusNotifierItem';

const WATCHER_XML = `
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg type="s" name="service" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg type="s" name="service" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg type="s" name="service"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
      <arg type="s" name="service"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>`;

/**
 * Sinais: 'item-added' (id, busName, objectPath), 'item-removed' (id).
 */
export class StatusNotifierWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._items = new Map(); // id → {bus, path}
        this._watches = new Map(); // nome no barramento → id do watch

        this._impl = Gio.DBusExportedObject.wrapJSObject(WATCHER_XML, this);
        // Lança erro se outro código deste processo já exportou o objeto
        // (ex.: a extensão AppIndicator): quem cria trata.
        this._impl.export(Gio.DBus.session, OBJECT_PATH);

        // Pedimos o nome sem tomar de outro dono. Os programas observam o
        // dono deste nome: quando ele aparece, eles (re)registram os ícones.
        this._ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => {
                debug('bandeja: StatusNotifierWatcher ativo');
                this._impl.emit_signal('StatusNotifierHostRegistered', null);
            },
            () => debug('bandeja: outro processo já é o StatusNotifierWatcher'));
    }

    /** @returns {Map<string, {bus: string, path: string}>} */
    get items() {
        return this._items;
    }

    // ----- Métodos D-Bus (chamados pelos programas) ------------------------------
    // O sufixo "Async" faz o GJS entregar a "invocation": dela tiramos quem
    // chamou (o nome único do programa no barramento).

    RegisterStatusNotifierItemAsync([service], invocation) {
        const sender = invocation.get_sender();
        // Dois jeitos de se registrar: pelo NOME no barramento (o objeto fica
        // no caminho padrão) ou pelo CAMINHO do objeto (o nome é quem chamou —
        // é o que o libayatana-appindicator faz).
        const bus = service.startsWith('/') ? sender : service;
        const path = service.startsWith('/') ? service : DEFAULT_ITEM_PATH;
        const id = `${bus}${path}`;
        if (!this._items.has(id)) {
            this._items.set(id, {bus, path});
            this._watchBus(bus);
            debug(`bandeja: ícone registrado ${id}`);
            this._impl.emit_signal('StatusNotifierItemRegistered', new GLib.Variant('(s)', [id]));
            this._impl.emit_property_changed('RegisteredStatusNotifierItems',
                new GLib.Variant('as', [...this._items.keys()]));
            this.emit('item-added', id, bus, path);
        }
        invocation.return_value(null);
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_value(null);
    }

    get RegisteredStatusNotifierItems() {
        return [...this._items.keys()];
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    // ----- Uso interno ---------------------------------------------------------

    /** O programa saiu do barramento (fechou/travou): os ícones dele saem. */
    _watchBus(bus) {
        if (this._watches.has(bus))
            return;
        const watchId = Gio.bus_watch_name_on_connection(Gio.DBus.session, bus,
            Gio.BusNameWatcherFlags.NONE, null, () => {
                for (const [id, item] of [...this._items]) {
                    if (item.bus === bus)
                        this._remove(id);
                }
                Gio.bus_unwatch_name(watchId);
                this._watches.delete(bus);
            });
        this._watches.set(bus, watchId);
    }

    _remove(id) {
        if (!this._items.delete(id))
            return;
        debug(`bandeja: ícone saiu ${id}`);
        this._impl.emit_signal('StatusNotifierItemUnregistered', new GLib.Variant('(s)', [id]));
        this._impl.emit_property_changed('RegisteredStatusNotifierItems',
            new GLib.Variant('as', [...this._items.keys()]));
        this.emit('item-removed', id);
    }

    destroy() {
        for (const watchId of this._watches.values())
            Gio.bus_unwatch_name(watchId);
        this._watches.clear();
        this._items.clear();
        try {
            Gio.bus_unown_name(this._ownerId);
            this._impl.unexport();
        } catch (e) {
            logError(e, 'encerrando o StatusNotifierWatcher');
        }
    }
}
