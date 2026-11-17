// SPDX-License-Identifier: GPL-3.0-or-later
// Bloco "Tocando agora" do centro de controle (MPRIS):
//
//   ╭──────────────────────────────────────╮
//   │ [capa]  Nome da música          ⏮ ⏯ ⏭ │
//   │         Artista                       │
//   ╰──────────────────────────────────────╯
//
// MPRIS é o padrão do Linux para controlar players: cada player tem um nome
// "org.mpris.MediaPlayer2.<app>" no barramento de sessão, com a música atual
// (Metadata), o estado (PlaybackStatus) e os comandos PlayPause/Next/Previous.
//
// Por que um cliente próprio e não o MprisSource do GNOME (ui/mpris.js)?
// Aquele não tem destroy(): a assinatura do sinal NameOwnerChanged ficaria
// para sempre depois de desativar a extensão. O nosso desfaz tudo.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isExpectedDBusError, logError} from '../util.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
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
</node>`);

/** Os players MPRIS abertos; emite 'changed' quando qualquer um muda. */
class MprisClient extends Signals.EventEmitter {
    constructor() {
        super();
        this._players = new Map(); // nome no barramento → {proxy, lastPlaying}
        this._cancellable = new Gio.Cancellable();
        const bus = Gio.DBus.session;
        // Players que abrem e fecham depois.
        this._subscription = bus.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });
        this._listPlayers();
    }

    async _listPlayers() {
        try {
            const reply = await Gio.DBus.session.call('org.freedesktop.DBus',
                '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
                null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1,
                this._cancellable);
            const [names] = reply.deepUnpack();
            names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'listando os players MPRIS');
        }
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        const entry = {proxy: null, lastPlaying: 0};
        this._players.set(name, entry);
        // Construtor com callback = assíncrono (não trava o Shell).
        new PlayerProxy(Gio.DBus.session, name, MPRIS_PATH, (proxy, error) => {
            if (error) {
                if (!isExpectedDBusError(error))
                    logError(error, `conectando ao player ${name}`);
                return;
            }
            if (this._players.get(name) !== entry)
                return; // fechou antes de responder
            entry.proxy = proxy;
            proxy.connectObject('g-properties-changed', () => this._onChanged(entry), this);
            this._onChanged(entry);
        }, this._cancellable);
    }

    _removePlayer(name) {
        const entry = this._players.get(name);
        if (!entry)
            return;
        entry.proxy?.disconnectObject(this);
        this._players.delete(name);
        this.emit('changed');
    }

    _onChanged(entry) {
        if (entry.proxy?.PlaybackStatus === 'Playing')
            entry.lastPlaying = GLib.get_monotonic_time();
        this.emit('changed');
    }

    /**
     * O player a mostrar: o que está tocando; senão, o que tocou por último;
     * senão, qualquer um com música.
     *
     * @returns {object|null} {proxy, title, artist, artUrl, playing, canNext, canPrevious}
     */
    get current() {
        const candidates = [...this._players.values()]
            .filter(e => e.proxy && this._titleOf(e.proxy));
        if (candidates.length === 0)
            return null;
        candidates.sort((a, b) => {
            const pa = a.proxy.PlaybackStatus === 'Playing' ? 1 : 0;
            const pb = b.proxy.PlaybackStatus === 'Playing' ? 1 : 0;
            return pb - pa || b.lastPlaying - a.lastPlaying;
        });
        const {proxy} = candidates[0];
        const meta = proxy.Metadata ?? {};
        const artists = meta['xesam:artist']?.deepUnpack?.() ?? [];
        return {
            proxy,
            title: this._titleOf(proxy),
            artist: Array.isArray(artists) ? artists.join(', ') : String(artists),
            artUrl: meta['mpris:artUrl']?.deepUnpack?.() ?? '',
            playing: proxy.PlaybackStatus === 'Playing',
            canNext: Boolean(proxy.CanGoNext),
            canPrevious: Boolean(proxy.CanGoPrevious),
        };
    }

    _titleOf(proxy) {
        return proxy.Metadata?.['xesam:title']?.deepUnpack?.() ?? '';
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._subscription);
        for (const entry of this._players.values())
            entry.proxy?.disconnectObject(this);
        this._players.clear();
    }
}

/** O bloco visual (filho da grade do centro de controle). */
export class MediaBlock {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'aerotask-cc-media',
            visible: false,
            x_expand: true,
        });

        this._cover = new St.Icon({
            style_class: 'aerotask-cc-media-cover',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._cover);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aerotask-cc-media-text',
        });
        this._title = new St.Label({style_class: 'aerotask-cc-media-title'});
        this._artist = new St.Label({style_class: 'aerotask-cc-media-artist'});
        for (const label of [this._title, this._artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        this.actor.add_child(text);

        this._previous = this._button('media-skip-backward-symbolic', _('Previous'),
            p => p.PreviousAsync());
        this._playPause = this._button('media-playback-start-symbolic', _('Play or Pause'),
            p => p.PlayPauseAsync());
        this._next = this._button('media-skip-forward-symbolic', _('Next'),
            p => p.NextAsync());

        this._client = new MprisClient();
        this._client.connectObject('changed', () => this._sync(), this);
    }

    _button(iconName, label, action) {
        const button = new St.Button({
            style_class: 'aerotask-cc-media-button',
            child: new St.Icon({icon_name: iconName, style_class: 'aerotask-cc-media-icon'}),
            accessible_name: label,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => {
            const proxy = this._client.current?.proxy;
            if (!proxy)
                return;
            action(proxy).catch(e => {
                if (!isExpectedDBusError(e))
                    logError(e, 'comando do player');
            });
        });
        this.actor.add_child(button);
        return button;
    }

    _sync() {
        const now = this._client.current;
        this.actor.visible = Boolean(now);
        if (!now)
            return;
        this._title.text = now.title;
        this._artist.text = now.artist;
        this._artist.visible = Boolean(now.artist);
        this._cover.gicon = now.artUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(now.artUrl)})
            : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        if (now.artUrl)
            this._cover.remove_style_class_name('aerotask-cc-media-cover-empty');
        else
            this._cover.add_style_class_name('aerotask-cc-media-cover-empty');
        this._playPause.child.icon_name = now.playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._previous.reactive = now.canPrevious;
        this._next.reactive = now.canNext;
    }

    destroy() {
        this._client.disconnectObject(this);
        this._client.destroy();
        this.actor.destroy();
    }
}
