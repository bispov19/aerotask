// SPDX-License-Identifier: GPL-3.0-or-later
// HUD de volume no centro da tela, como o do macOS:
//
//        ╭──────────────────╮
//        │        🔊        │
//        │  ▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯  │
//        │       56%        │
//        ╰──────────────────╯
//
// Aparece quando o volume da SAÍDA PADRÃO muda — por qualquer caminho: teclas,
// controle da barra, pavucontrol, um app… — e some sozinho pouco depois.
// Para isso escutamos o próprio mixer do GNOME (Gvc, o mesmo objeto que o
// controle de volume da barra usa), não só as teclas.
//
// As teclas de volume no máximo/mínimo não mudam o mixer, mas o GNOME ainda
// chama o OSD dele: o OsdOverride nos repassa essas chamadas (handleOsd), e o
// OSD padrão de volume não aparece (nunca dois indicadores).
//
// Caixa, posição e animação: CenterHud (a mesma do HUD de "tela ligada").

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {CenterHud} from './centerHud.js';
import {T, formatPercent} from './island/strings.js';

/** Quadradinhos da barra, como no macOS. */
const SEGMENTS = 16;

export class VolumeHud {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._sound = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});

        this._build();

        // O mixer do GNOME (único no Shell): a saída padrão pode trocar
        // (fone conectado…); a cada troca passamos a escutar a nova.
        this._control = getMixerControl();
        this._stream = null;
        this._control.connectObject(
            'default-sink-changed', () => this._watchSink(),
            'state-changed', () => this._watchSink(),
            this);
        this._watchSink();
        settings.connectObject('changed::volume-hud-show-percentage', () => this._syncPercent(), this);
    }

    _build() {
        this._hud = new CenterHud('aero-volume-hud');
        this.actor = this._hud.actor;

        this._icon = new St.Icon({
            style_class: 'aero-volume-hud-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._icon);

        this._bar = new St.BoxLayout({
            style_class: 'aero-volume-hud-bar',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._segments = [];
        for (let i = 0; i < SEGMENTS; i++) {
            const segment = new St.Widget({style_class: 'aero-volume-hud-segment'});
            this._segments.push(segment);
            this._bar.add_child(segment);
        }
        this.actor.add_child(this._bar);

        this._value = new St.Label({
            style_class: 'aero-volume-hud-value',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._value);
    }

    get enabled() {
        return this._settings.get_boolean('alert-volume');
    }

    _watchSink() {
        this._stream?.disconnectObject(this);
        this._stream = this._control.get_default_sink();
        if (!this._stream)
            return;
        // Trocar de saída não é "mudar o volume": só lembramos o estado.
        this._last = {volume: this._stream.volume, muted: this._stream.is_muted};
        this._stream.connectObject(
            'notify::volume', () => this._onStreamChanged(),
            'notify::is-muted', () => this._onStreamChanged(),
            this);
    }

    _onStreamChanged() {
        const stream = this._stream;
        if (stream.volume === this._last.volume && stream.is_muted === this._last.muted)
            return;
        this._last = {volume: stream.volume, muted: stream.is_muted};
        if (!this.enabled)
            return;
        const norm = this._control.get_vol_max_norm();
        this.show(stream.volume / norm, stream.is_muted, this._maxLevel());
    }

    /** 1 (100%), ou 1,5 com "volume acima de 100%" ligado. */
    _maxLevel() {
        if (!this._sound.get_boolean('allow-volume-above-100-percent'))
            return 1;
        return this._control.get_vol_max_amplified() / this._control.get_vol_max_norm();
    }

    /**
     * Chamado pelo OsdOverride quando o GNOME ia mostrar o OSD de volume.
     *
     * @param {object} osd - {name, level, maxLevel, muted}
     * @returns {boolean} true = o HUD mostrou (o OSD do GNOME não aparece)
     */
    handleOsd({level, maxLevel, muted}) {
        if (!this.enabled)
            return false;
        this.show(level, muted, maxLevel > 0 ? maxLevel : 1);
        return true;
    }

    /**
     * @param {number} level - 0 a maxLevel (1 = 100%)
     * @param {boolean} muted
     * @param {number} maxLevel
     */
    show(level, muted, maxLevel = 1) {
        level = Math.max(0, Math.min(level, maxLevel));
        const silent = muted || level <= 0;
        this._icon.icon_name = silent ? 'audio-volume-muted-symbolic'
            : level > 1 ? 'audio-volume-overamplified-symbolic'
                : level < 1 / 3 ? 'audio-volume-low-symbolic'
                    : level < 2 / 3 ? 'audio-volume-medium-symbolic'
                        : 'audio-volume-high-symbolic';

        const filled = silent ? 0 : Math.round(Math.min(level, 1) * SEGMENTS);
        this._segments.forEach((segment, i) => {
            if (i < filled)
                segment.add_style_pseudo_class('checked');
            else
                segment.remove_style_pseudo_class('checked');
        });

        this._muted = muted;
        this._value.text = muted ? T.muted : formatPercent(level);
        if (!muted && level > 1.001)
            this._value.add_style_class_name('aero-volume-hud-over');
        else
            this._value.remove_style_class_name('aero-volume-hud-over');
        this._syncPercent();

        this._hud.flash();
    }

    /** "Mostrar a porcentagem" desligado: some o número (o "Mudo" fica). */
    _syncPercent() {
        this._value.visible = this._muted ||
            this._settings.get_boolean('volume-hud-show-percentage');
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._control.disconnectObject(this);
        this._stream?.disconnectObject(this);
        this._stream = null;
        this._hud.destroy();
    }
}
