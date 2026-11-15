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
// Animação: a mesma dos pop-ups do GNOME (BoxPointer): aparece crescendo de
// 96% para 100% com fade; some do mesmo jeito. "Reduzir animação" zera tudo.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {POPUP_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {T, formatPercent} from './island/strings.js';
import {TimeoutRegistry} from './util.js';

/** Some 1,5 s depois do último ajuste — o mesmo tempo do OSD do GNOME. */
const HIDE_TIMEOUT = 1500;
/** Quadradinhos da barra, como no macOS. */
const SEGMENTS = 16;
/** Tamanho inicial na animação (o mesmo do BoxPointer do GNOME). */
const START_SCALE = 0.96;

export class VolumeHud {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._timers = new TimeoutRegistry();
        this._hideTimer = 0;
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
        this.actor = new St.BoxLayout({
            style_class: 'aero-volume-hud',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
            opacity: 0,
            // Só mostra; nunca rouba cliques de quem está embaixo.
            reactive: false,
        });
        this.actor.set_pivot_point(0.5, 0.5);

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

        // Na camada de interface do Shell (acima das janelas, inclusive em
        // tela cheia), como o OSD do GNOME.
        Main.uiGroup.add_child(this.actor);
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

        this._appear();
        this._timers.remove(this._hideTimer);
        this._hideTimer = this._timers.add(HIDE_TIMEOUT, () => {
            this._hideTimer = 0;
            this._disappear();
        });
    }

    /** "Mostrar a porcentagem" desligado: some o número (o "Mudo" fica). */
    _syncPercent() {
        this._value.visible = this._muted ||
            this._settings.get_boolean('volume-hud-show-percentage');
    }

    _appear() {
        const actor = this.actor;
        // No centro do monitor principal.
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            const [, width] = actor.get_preferred_width(-1);
            const [, height] = actor.get_preferred_height(width);
            actor.set_position(
                Math.round(monitor.x + (monitor.width - width) / 2),
                Math.round(monitor.y + (monitor.height - height) / 2));
        }
        Main.uiGroup.set_child_above_sibling(actor, null);
        if (actor.visible && actor.opacity === 255 && !actor.get_transition('opacity'))
            return; // já na tela: só os números mudaram
        actor.remove_all_transitions();
        if (!actor.visible) {
            actor.opacity = 0;
            actor.scale_x = actor.scale_y = START_SCALE;
            actor.show();
        }
        actor.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: POPUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _disappear() {
        this.actor.ease({
            opacity: 0,
            scale_x: START_SCALE,
            scale_y: START_SCALE,
            duration: POPUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.actor.hide(),
        });
    }

    destroy() {
        this._timers.clear();
        this._settings.disconnectObject(this);
        this._control.disconnectObject(this);
        this._stream?.disconnectObject(this);
        this._stream = null;
        // Animação rodando em ator que sai do palco gera aviso: parar antes.
        this.actor.remove_all_transitions();
        this.actor.destroy();
    }
}
