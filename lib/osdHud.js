// SPDX-License-Identifier: GPL-3.0-or-later
// O HUD no centro da tela, como o do macOS — UM SÓ para todos os avisos:
//
//        ╭──────────────────╮          ╭──────────────────╮
//        │        🔊        │          │        ⇪         │
//        │  ▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯  │          │                  │
//        │       56%        │          │ Caps Lock ativado│
//        ╰──────────────────╯          ╰──────────────────╯
//
// Quem aparece aqui:
//   - volume: quando o volume da SAÍDA PADRÃO muda — por qualquer caminho
//     (teclas, controle da barra, pavucontrol, um app…). Escutamos o próprio
//     mixer do GNOME (Gvc), não só as teclas;
//   - brilho da tela e luz do teclado: o GNOME 51 chama o OSD dele em
//     qualquer mudança (teclas E o controle das Configurações Rápidas), e o
//     OsdOverride repassa para cá;
//   - Caps Lock: ao ligar/desligar (estado do teclado do Clutter);
//   - "Manter Tela Ligada" (lib/keepAwake.js chama show());
//   - qualquer outro aviso do OSD do GNOME (microfone, touchpad…).
//
// Um só HUD: um aviso novo SUBSTITUI o que estiver na tela (nunca dois
// empilhados). Com a opção de um tipo desligada, segue o pop-up do GNOME.
// Caixa, posição e animação: CenterHud.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {CenterHud} from './centerHud.js';
import {T, formatPercent} from './farol/strings.js';

/** Quadradinhos da barra, como no macOS. */
const SEGMENTS = 16;

export class OsdHud {
    /**
     * @param {Gio.Settings} settings
     * @param {OsdOverride} osd - o ponto único que intercepta o OSD do GNOME
     * @param {Gio.File} iconsDir - pasta icons/ da extensão
     */
    constructor(settings, osd, iconsDir) {
        this._settings = settings;
        this._osd = osd;
        this._iconsDir = iconsDir;
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

        // Caps Lock: o "state-changed" vem para qualquer tecla de estado
        // (Num Lock…); só mostramos quando o Caps Lock mudou de fato.
        const seat = global.stage.context.get_backend().get_default_seat();
        this._keymap = seat.get_keymap();
        this._capsLock = this._keymap.get_caps_lock_state();
        this._keymap.connectObject('state-changed', () => this._checkCapsLock(), this);

        settings.connectObject('changed::volume-hud-show-percentage', () => this._syncPercent(), this);

        // Todos os tipos do OSD do GNOME passam por aqui.
        for (const kind of ['volume', 'brightness', 'keyboard', 'other'])
            osd.setHandler(kind, info => this.handleOsd(info));
    }

    _build() {
        this._hud = new CenterHud('aero-osd-hud');
        this.actor = this._hud.actor;
        // Todos os avisos com o MESMO tamanho de caixa (o do macOS): o
        // conteúdo fica numa caixa interna, centralizada na vertical.
        this._content = new St.BoxLayout({
            style_class: 'aero-osd-hud-content',
            orientation: Clutter.Orientation.VERTICAL,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._content);

        this._icon = new St.Icon({
            style_class: 'aero-osd-hud-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._icon);

        // Texto: o nome (Caps Lock, Wi-Fi, nome do dispositivo…) e, colada
        // embaixo, a linha de estado ("Ativado", "Desempenho"…).
        this._text = new St.BoxLayout({
            style_class: 'aero-osd-hud-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._text);
        this._caption = new St.Label({
            style_class: 'aero-osd-hud-caption',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._text.add_child(this._caption);
        this._detail = new St.Label({
            style_class: 'aero-osd-hud-detail',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._text.add_child(this._detail);

        this._bar = new St.BoxLayout({
            style_class: 'aero-osd-hud-bar',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._segments = [];
        for (let i = 0; i < SEGMENTS; i++) {
            const segment = new St.Widget({style_class: 'aero-osd-hud-segment'});
            this._segments.push(segment);
            this._bar.add_child(segment);
        }
        this._content.add_child(this._bar);

        this._value = new St.Label({
            style_class: 'aero-osd-hud-value',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._value);
    }

    // ----- Volume (mixer) ---------------------------------------------------------

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
        if (!this._settings.get_boolean('alert-volume'))
            return;
        const norm = this._control.get_vol_max_norm();
        this._showVolume(stream.volume / norm, stream.is_muted, this._maxVolume());
    }

    /** 1 (100%), ou 1,5 com "volume acima de 100%" ligado. */
    _maxVolume() {
        if (!this._sound.get_boolean('allow-volume-above-100-percent'))
            return 1;
        return this._control.get_vol_max_amplified() / this._control.get_vol_max_norm();
    }

    _showVolume(level, muted, maxLevel) {
        const silent = muted || level <= 0;
        const iconName = silent ? 'audio-volume-muted-symbolic'
            : level > 1 ? 'audio-volume-overamplified-symbolic'
                : level < 1 / 3 ? 'audio-volume-low-symbolic'
                    : level < 2 / 3 ? 'audio-volume-medium-symbolic'
                        : 'audio-volume-high-symbolic';
        this.show({icon: new Gio.ThemedIcon({name: iconName}), level, maxLevel, muted});
    }

    // ----- Caps Lock ----------------------------------------------------------------

    _checkCapsLock() {
        const on = this._keymap.get_caps_lock_state();
        if (on === this._capsLock)
            return;
        this._capsLock = on;
        if (!this._settings.get_boolean('alert-caps-lock'))
            return;
        this.show({
            icon: this.fileIcon(on ? 'caps-lock-on-symbolic.svg' : 'caps-lock-symbolic.svg'),
            caption: T.capsLock,
            detail: on ? T.turnedOn : T.turnedOff,
        });
    }

    // ----- OSD do GNOME ---------------------------------------------------------------

    /**
     * Chamado pelo OsdOverride quando o GNOME ia mostrar o pop-up dele.
     *
     * @param {object} osd - {kind, icon, label, level, maxLevel, muted}
     * @returns {boolean} true = o HUD mostrou (o pop-up do GNOME não aparece)
     */
    handleOsd({kind, icon, label, level, maxLevel, muted}) {
        if (kind === 'volume') {
            if (!this._settings.get_boolean('alert-volume'))
                return false;
            // As teclas no máximo/mínimo não mudam o mixer: chegam só por aqui.
            this._showVolume(level ?? 0, muted, maxLevel > 0 ? maxLevel : 1);
            return true;
        }
        if ((kind === 'brightness' || kind === 'keyboard') &&
            !this._settings.get_boolean('alert-brightness'))
            return false;
        this.show({icon, caption: label, level, maxLevel, muted});
        return true;
    }

    // ----- Mostrar ----------------------------------------------------------------------

    /**
     * Mostra um aviso no HUD (substitui o que estiver na tela).
     *
     * @param {object} params
     * @param {Gio.Icon} params.icon
     * @param {string} [params.caption] - nome embaixo do ícone (negrito)
     * @param {string} [params.detail] - linha de estado ("Ativado"…)
     * @param {number|null} [params.level] - 0 a maxLevel; sem nível, sem barra
     * @param {number} [params.maxLevel] - 1 (100%), ou mais com volume amplificado
     * @param {boolean} [params.muted] - "Mudo" no lugar do número
     */
    show({icon, caption = null, detail = null, level = null, maxLevel = 1, muted = false}) {
        this._icon.gicon = icon;
        this._caption.text = caption ?? '';
        this._caption.visible = Boolean(caption);
        this._detail.text = detail ?? '';
        this._detail.visible = Boolean(detail);
        this._text.visible = Boolean(caption || detail);

        const hasLevel = level !== null && level !== undefined;
        this._bar.visible = hasLevel;
        this._level = hasLevel ? Math.max(0, Math.min(level, maxLevel)) : null;
        this._muted = hasLevel && muted;
        if (hasLevel) {
            const filled = this._muted ? 0 : Math.round(Math.min(this._level, 1) * SEGMENTS);
            this._segments.forEach((segment, i) => {
                if (i < filled)
                    segment.add_style_pseudo_class('checked');
                else
                    segment.remove_style_pseudo_class('checked');
            });
            this._value.text = this._muted ? T.muted : formatPercent(this._level);
            // Acima de 100% (volume amplificado): a cor de "overdrive" do GNOME.
            if (!this._muted && this._level > 1.001)
                this._value.add_style_class_name('aero-osd-hud-over');
            else
                this._value.remove_style_class_name('aero-osd-hud-over');
        }
        this._syncPercent();
        this._hud.flash();
    }

    /** "Mostrar a porcentagem" desligado: some o número (o "Mudo" fica). */
    _syncPercent() {
        this._value.visible = this._level !== null && this._level !== undefined &&
            (this._muted || this._settings.get_boolean('volume-hud-show-percentage'));
    }

    /**
     * Ícone de arquivo da pasta icons/ da extensão.
     *
     * @param {string} name - ex.: "caps-lock-symbolic.svg"
     * @returns {Gio.FileIcon}
     */
    fileIcon(name) {
        return new Gio.FileIcon({file: this._iconsDir.get_child(name)});
    }

    destroy() {
        for (const kind of ['volume', 'brightness', 'keyboard', 'other'])
            this._osd.setHandler(kind, null);
        this._settings.disconnectObject(this);
        this._control.disconnectObject(this);
        this._stream?.disconnectObject(this);
        this._stream = null;
        this._keymap.disconnectObject(this);
        this._hud.destroy();
    }
}

