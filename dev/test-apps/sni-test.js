// SPDX-License-Identifier: GPL-3.0-or-later
// Programa de teste da bandeja: publica um ícone StatusNotifierItem com um
// menu DBusMenu, como Discord/Steam/Telegram fazem. Fora do pacote da
// extensão (pasta dev/).
//
// Uso: gjs -m dev/test-apps/sni-test.js [nome-do-ícone | --pixmap] [título]
//   --pixmap: manda o ícone em pixels (IconPixmap) em vez de nome.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {programArgs} from 'system';

const iconArg = programArgs[0] ?? 'org.gnome.Settings';
const title = programArgs[1] ?? 'Teste da Bandeja';
const usePixmap = iconArg === '--pixmap';
const loop = new GLib.MainLoop(null, false);
const conn = Gio.DBus.session;
const busName = `org.kde.StatusNotifierItem-${new Gio.Credentials().get_unix_pid()}-1`;

const ITEM_XML = `
<node><interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="NewIcon"/>
  <signal name="NewStatus"><arg type="s"/></signal>
</interface></node>`;

const MENU_XML = `
<node><interface name="com.canonical.dbusmenu">
  <method name="GetLayout">
    <arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
    <arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/>
  </method>
  <method name="Event">
    <arg type="i" direction="in"/><arg type="s" direction="in"/>
    <arg type="v" direction="in"/><arg type="u" direction="in"/>
  </method>
  <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
</interface></node>`;

const state = {status: 'Active', icon: usePixmap ? '' : iconArg, revision: 1, events: []};

// Ícone em pixels: um quadrado laranja 22×22 (ARGB, ordem de rede).
function pixmap() {
    const size = 22;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++)
        data.set([255, 255, 140, 0], i * 4);
    return [[size, size, data]];
}

const item = {
    get Category() {
        return 'ApplicationStatus';
    },
    get Id() {
        return 'aerotask-sni-test';
    },
    get Title() {
        return title;
    },
    get Status() {
        return state.status;
    },
    get IconName() {
        return state.icon;
    },
    get IconPixmap() {
        return usePixmap ? pixmap() : [];
    },
    get ItemIsMenu() {
        return true;
    },
    get Menu() {
        return '/MenuBar';
    },
    Activate() {
        print('Activate');
    },
    SecondaryActivate() {
        print('SecondaryActivate');
    },
    ContextMenu() {
        print('ContextMenu');
    },
    Scroll(delta, orientation) {
        print(`Scroll ${delta} ${orientation}`);
    },
};

const MENU = [
    [1, 'Abrir a janela principal'],
    [2, 'Trocar o ícone'],
    [3, ''], // separador
    [4, 'Sair'],
];

const menu = {
    GetLayout() {
        const children = MENU.map(([id, label]) => new GLib.Variant('(ia{sv}av)', [id,
            label ? {label: new GLib.Variant('s', label)} : {type: new GLib.Variant('s', 'separator')},
            []]));
        // O GJS empacota a resposta pela assinatura: a raiz vai como valores
        // comuns (só os filhos, do tipo "v", são GLib.Variant prontos).
        return [state.revision, [0, {'children-display': new GLib.Variant('s', 'submenu')}, children]];
    },
    Event(id, eventId) {
        if (eventId !== 'clicked')
            return;
        state.events.push(id);
        print(`clicked ${id}`);
        if (id === 2) {
            state.icon = state.icon === 'org.gnome.Settings' ? 'org.gnome.Nautilus' : 'org.gnome.Settings';
            itemImpl.emit_signal('NewIcon', null);
        } else if (id === 4) {
            loop.quit();
        }
    },
    AboutToShow() {
        return false;
    },
};

const itemImpl = Gio.DBusExportedObject.wrapJSObject(ITEM_XML, item);
itemImpl.export(conn, '/StatusNotifierItem');
const menuImpl = Gio.DBusExportedObject.wrapJSObject(MENU_XML, menu);
menuImpl.export(conn, '/MenuBar');

Gio.bus_own_name_on_connection(conn, busName, Gio.BusNameOwnerFlags.NONE, () => {
    // Registra quando o watcher (a barra) aparecer — e de novo se ele voltar.
    Gio.bus_watch_name_on_connection(conn, 'org.kde.StatusNotifierWatcher',
        Gio.BusNameWatcherFlags.NONE, () => {
            conn.call('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
                'org.kde.StatusNotifierWatcher', 'RegisterStatusNotifierItem',
                new GLib.Variant('(s)', [busName]), null, Gio.DBusCallFlags.NONE, -1, null,
                (c, res) => {
                    try {
                        c.call_finish(res);
                        print(`registrado como ${busName}`);
                    } catch (e) {
                        print(`falhou ao registrar: ${e.message}`);
                    }
                });
        }, null);
}, null);

loop.run();
