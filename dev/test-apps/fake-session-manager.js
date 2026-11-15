#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// gnome-session FALSO, só para testar "Manter Tela Ligada" na sessão
// aninhada (lá não existe gnome-session). Implementa o mínimo:
// Inhibit/Uninhibit e a propriedade InhibitedActions, e imprime cada
// chamada. Rodar no barramento da sessão aninhada:
//
//   DBUS_SESSION_BUS_ADDRESS="$(cut -d# -f1 ~/.local/state/aero-menu-global/nested-bus)" \
//       gjs -m dev/test-apps/fake-session-manager.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const IFACE = `
<node>
  <interface name="org.gnome.SessionManager">
    <method name="Inhibit">
      <arg type="s" name="app_id" direction="in"/>
      <arg type="u" name="toplevel_xid" direction="in"/>
      <arg type="s" name="reason" direction="in"/>
      <arg type="u" name="flags" direction="in"/>
      <arg type="u" name="inhibit_cookie" direction="out"/>
    </method>
    <method name="Uninhibit">
      <arg type="u" name="inhibit_cookie" direction="in"/>
    </method>
    <property name="InhibitedActions" type="u" access="read"/>
  </interface>
</node>`;

const inhibitors = new Map(); // cookie → flags
let nextCookie = 1;

const service = {
    Inhibit(appId, xid, reason, flags) {
        const cookie = nextCookie++;
        inhibitors.set(cookie, flags);
        print(`Inhibit app=${appId} reason="${reason}" flags=${flags} → cookie ${cookie}`);
        notifyActions();
        return cookie;
    },
    Uninhibit(cookie) {
        print(`Uninhibit cookie ${cookie} (${inhibitors.has(cookie) ? 'ok' : 'DESCONHECIDO'})`);
        inhibitors.delete(cookie);
        notifyActions();
    },
    get InhibitedActions() {
        let flags = 0;
        for (const f of inhibitors.values())
            flags |= f;
        return flags;
    },
};

const exported = Gio.DBusExportedObject.wrapJSObject(IFACE, service);

function notifyActions() {
    exported.emit_property_changed('InhibitedActions',
        new GLib.Variant('u', service.InhibitedActions));
}

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.gnome.SessionManager',
    Gio.BusNameOwnerFlags.NONE,
    connection => exported.export(connection, '/org/gnome/SessionManager'),
    () => print('pronto: org.gnome.SessionManager (falso)'),
    () => {
        print('não consegui o nome (já existe um gnome-session?)');
        loop.quit();
    });
loop.run();
