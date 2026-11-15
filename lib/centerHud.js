// SPDX-License-Identifier: GPL-3.0-or-later
// O "esqueleto" dos HUDs no centro da tela, como os do macOS: uma caixa
// escura e arredondada que aparece no meio do monitor principal e some
// sozinha pouco depois. Quem usa (o HUD de volume, o de "tela sempre
// ligada") só põe o conteúdo dentro de `actor` e chama flash().
//
// Animação: a mesma dos pop-ups do GNOME (BoxPointer): aparece crescendo de
// 96% para 100% com fade; some do mesmo jeito. "Reduzir animação" zera tudo
// (o ease() do Shell já ajusta as durações).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {POPUP_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/boxpointer.js';

import {TimeoutRegistry} from './util.js';

/** Some 1,5 s depois do último aviso — o mesmo tempo do OSD do GNOME. */
const HIDE_TIMEOUT = 1500;
/** Tamanho inicial na animação (o mesmo do BoxPointer do GNOME). */
const START_SCALE = 0.96;

export class CenterHud {
    /** @param {string} styleClass - classe extra (a base é "aero-hud") */
    constructor(styleClass) {
        this._timers = new TimeoutRegistry();
        this._hideTimer = 0;

        this.actor = new St.BoxLayout({
            style_class: `aero-hud ${styleClass}`,
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
            opacity: 0,
            // Só mostra; nunca rouba cliques de quem está embaixo.
            reactive: false,
        });
        this.actor.set_pivot_point(0.5, 0.5);

        // Na camada de interface do Shell (acima das janelas, inclusive em
        // tela cheia), como o OSD do GNOME.
        Main.uiGroup.add_child(this.actor);
    }

    /** Mostra (ou mantém na tela) e reinicia a contagem para sumir. */
    flash() {
        this._appear();
        this._timers.remove(this._hideTimer);
        this._hideTimer = this._timers.add(HIDE_TIMEOUT, () => {
            this._hideTimer = 0;
            this._disappear();
        });
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
            return; // já na tela: só o conteúdo mudou
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
        // Animação rodando em ator que sai do palco gera aviso: parar antes.
        this.actor.remove_all_transitions();
        this.actor.destroy();
    }
}
