#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// Player MPRIS FALSO, para testar o bloco "Tocando agora" do centro de
// controle sem abrir um player de verdade. Responde a PlayPause/Next/Previous
// (imprime cada comando) e troca de faixa no Next/Previous.
//
//   DBUS_SESSION_BUS_ADDRESS="$(cut -d# -f1 ~/.local/state/aero-menu-global/nested-bus)" \
//       gjs -m dev/test-apps/mpris-test.js [nome] [--longo]
//
// [nome]: sufixo do nome no barramento (para rodar dois players juntos);
// --longo: começa numa faixa com título e artista bem longos.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
  </interface>
</node>`;

const args = ARGV.filter(a => !a.startsWith('--'));
const busSuffix = args[0] ?? 'aerotest';
const tracks = [
    ['Música de Teste', ['Artista Exemplo']],
    ['Segunda Faixa', ['Outra Banda', 'Participação']],
    ['SINAL DE ALERTA PRA ESPANHA? DEBATEMOS VITÓRIA DA INGLATERRA NA NATIONS! E MUITO MAIS NESTE PROGRAMA',
        ['Canal Com Um Nome Bem Comprido Para Testar', 'Convidado Especial Também Com Nome Longo']],
];
let index = ARGV.includes('--longo') ? 2 : 0;
let playing = true;

const nodeInfo = Gio.DBusNodeInfo.new_for_xml(IFACE);
let connection = null;

function metadata() {
    const [title, artists] = tracks[index];
    return new GLib.Variant('a{sv}', {
        'mpris:trackid': new GLib.Variant('o', `/test/track/${index}`),
        'xesam:title': new GLib.Variant('s', title),
        'xesam:artist': new GLib.Variant('as', artists),
    });
}

function property(name) {
    switch (name) {
        case 'Identity': return new GLib.Variant('s', 'Player de Teste');
        case 'PlaybackStatus': return new GLib.Variant('s', playing ? 'Playing' : 'Paused');
        case 'Metadata': return metadata();
        case 'CanGoNext':
        case 'CanGoPrevious':
        case 'CanPlay':
        case 'CanPause': return new GLib.Variant('b', true);
    }
    return null;
}

function changed(...names) {
    const props = {};
    for (const n of names)
        props[n] = property(n);
    connection.emit_signal(null, '/org/mpris/MediaPlayer2',
        'org.freedesktop.DBus.Properties', 'PropertiesChanged',
        new GLib.Variant('(sa{sv}as)', ['org.mpris.MediaPlayer2.Player', props, []]));
}

const vtable = {
    method_call(_conn, _sender, _path, _iface, method, _params, invocation) {
        print(`comando: ${method}`);
        if (method === 'PlayPause')
            playing = !playing;
        else if (method === 'Next')
            index = (index + 1) % tracks.length;
        else if (method === 'Previous')
            index = (index + tracks.length - 1) % tracks.length;
        invocation.return_value(null);
        changed('PlaybackStatus', 'Metadata');
    },
    get_property(_conn, _sender, _path, _iface, name) {
        return property(name);
    },
};

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, `org.mpris.MediaPlayer2.${busSuffix}`,
    Gio.BusNameOwnerFlags.NONE,
    conn => {
        connection = conn;
        for (const iface of nodeInfo.interfaces) {
            conn.register_object('/org/mpris/MediaPlayer2', iface,
                vtable.method_call, vtable.get_property, null);
        }
    },
    () => print(`pronto: org.mpris.MediaPlayer2.${busSuffix}`),
    () => loop.quit());
loop.run();
