// SPDX-License-Identifier: GPL-3.0-or-later
// Troca de mês FLUIDA no calendário emprestado do GNOME.
//
// Como o GNOME troca o mês: Calendar._rebuildCalendar() DESTRÓI os 42
// botões de dia e cria outros 42 (o calendário mostra sempre 6 semanas, então
// a altura não muda). Isso acontece de uma vez, sem animação.
//
// O que fazemos, sem copiar nem reescrever o calendário do GNOME:
//
//   1. Enquanto o calendário está emprestado, trocamos SÓ neste objeto o
//      método _rebuildCalendar por um que envolve o original (o protótipo do
//      GNOME não é tocado; ao devolver, apagamos a nossa versão).
//   2. Logo ANTES de o original destruir os dias do mês antigo, nós os
//      tiramos do calendário (sem destruir) e os colocamos numa camada
//      "fantasma" por cima, cada um na posição em que estava. O título do
//      mês antigo vira um rótulo fantasma no mesmo lugar.
//   3. O original cria os dias do mês novo normalmente.
//   4. Animamos: o grupo fantasma INTEIRO (uma animação só) sai deslizando
//      para o lado oposto à seta, com fade; os dias novos entram do outro
//      lado com fade-in. Só opacity e translation_x (baratos na GPU: não
//      refazem o layout). O palco recorta o que passa da borda.
//
// Cliques rápidos: o grupo fantasma anterior é descartado na hora (já estava
// quase invisível) e os dias que ainda estavam entrando viram o novo
// fantasma a partir de onde estavam — nada acumula, nada duplica.
// Atualizações do MESMO mês (eventos chegando do servidor de agenda) no
// meio da animação recriam os dias: os novos continuam do ponto em que a
// animação estava.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

/** Duração da troca de mês (ms) e quanto o conteúdo desliza (fração da largura). */
const DURATION = 280;
const SLIDE_FRACTION = 0.35;
/** Deslocamento do título do mês (px). */
const TITLE_SLIDE = 14;

// A camada fantasma precisa da classe "calendar" para os dias e o título
// manterem EXATAMENTE o estilo do tema (as regras são ".calendar
// .calendar-day" etc.), mas sem desenhar o fundo/borda do cartão de novo.
const NEUTRAL = 'background-color: transparent; background-image: none; border: none;' +
    ' box-shadow: none; padding: 0; margin: 0;';

/** Mesma curva do EASE_OUT_CUBIC (para continuar uma animação do meio). */
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

const monthIndex = date => date.getFullYear() * 12 + date.getMonth();

export class CalendarMotion {
    /**
     * @param {St.Widget} calendar - o Calendar do GNOME (emprestado)
     * @param {St.Widget} stage - o pai dele (BinLayout, recorta o conteúdo)
     */
    constructor(calendar, stage) {
        this._cal = calendar;
        this._stage = stage;
        this._ghost = null; // grupo fantasma em animação
        this._run = null; // {start, dir, distance} da troca em andamento
        this._settings = St.Settings.get();

        // Camada por cima do calendário, onde os fantasmas são desenhados.
        // reactive: false — só os botões fantasmas poderiam receber cliques,
        // e esses nós desligamos (ver _ghostify).
        this._layer = new St.Widget({style_class: 'calendar', style: NEUTRAL, reactive: false});
        stage.add_child(this._layer);

        this._monthText = calendar._monthLabel?.text ?? '';
        const original = Object.getPrototypeOf(calendar)._rebuildCalendar;
        calendar._rebuildCalendar = (...args) => this._rebuild(original, args);
    }

    get _days() {
        const first = this._cal._firstDayIndex ?? Infinity;
        return this._cal.get_children().slice(first);
    }

    /** Há uma troca de mês em andamento? (pelo tempo: nada depende de sinais) */
    get _running() {
        return !!this._run && GLib.get_monotonic_time() - this._run.start < DURATION * 1000;
    }

    // Por que `allocation` e não has_allocation()/get_allocation_box(): o
    // GNOME troca o texto do título ANTES de recriar os dias, e isso deixa o
    // calendário "esperando layout" — has_allocation() fica falso e
    // get_allocation_box() forçaria um layout no meio da troca. A propriedade
    // `allocation` é a última posição DESENHADA: exatamente onde os dias
    // antigos estão na tela agora.
    _canAnimate() {
        return this._settings.enable_animations && this._cal.mapped &&
            this._cal.allocation.get_width() > 0 && this._cal._firstDayIndex !== undefined;
    }

    _rebuild(original, args) {
        const cal = this._cal;
        const oldBegin = cal._calendarBegin;
        const selected = cal._selectedDate;
        const dir = oldBegin && selected
            ? Math.sign(monthIndex(selected) - monthIndex(oldBegin)) : 0;

        if (dir !== 0 && this._canAnimate()) {
            this._takeOldMonth(dir);
            original.apply(cal, args);
            this._bringNewMonth();
        } else {
            original.apply(cal, args);
            // Mesmo mês, mas recriado no meio de uma troca (ex.: eventos
            // chegaram): os dias novos continuam de onde a animação estava.
            if (this._running)
                this._bringNewMonth(true);
        }
        this._monthText = cal._monthLabel?.text ?? this._monthText;
    }

    /** Passa os dias (e o título) do mês que sai para um grupo fantasma. */
    _takeOldMonth(dir) {
        const cal = this._cal;
        // Troca anterior ainda rodando: o fantasma dela já está quase
        // invisível — descarta para não acumular.
        this._ghost?.destroy();

        const calBox = cal.allocation;
        const width = calBox.get_width();
        this._run = {start: GLib.get_monotonic_time(), dir, distance: Math.round(width * SLIDE_FRACTION)};

        const ghost = new St.Widget({reactive: false, width, height: calBox.get_height()});
        this._layer.add_child(ghost);
        this._ghost = ghost;

        for (const day of this._days)
            this._ghostify(day, ghost);

        // Título do mês que sai, no mesmo lugar do de verdade.
        const label = cal._monthLabel;
        const header = cal._topBox;
        const headerBox = header?.allocation;
        const labelBox = label?.allocation;
        if (labelBox?.get_width() > 0 && headerBox?.get_width() > 0) {
            // As classes do cabeçalho mantêm a fonte e o tamanho do tema.
            const ghostHeader = new St.Widget({style_class: 'calendar-month-header', style: NEUTRAL});
            const ghostLabel = new St.Label({
                style_class: 'calendar-month-label',
                text: this._monthText,
                x: labelBox.x1,
                y: labelBox.y1,
                width: labelBox.get_width(),
                height: labelBox.get_height(),
                opacity: label.opacity,
                translation_x: label.translation_x,
            });
            ghostLabel.clutter_text.x_align = Clutter.ActorAlign.CENTER;
            ghostHeader.add_child(ghostLabel);
            ghostHeader.set_position(headerBox.x1, headerBox.y1);
            ghost.add_child(ghostHeader);
            label.remove_all_transitions();
        }

        // UMA animação para o mês inteiro que sai.
        ghost.ease({
            translation_x: -dir * this._run.distance,
            opacity: 0,
            duration: DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                if (this._ghost === ghost)
                    this._ghost = null;
                ghost.destroy();
            },
        });
    }

    /** Move um dia do calendário para o fantasma, na mesma posição. */
    _ghostify(day, ghost) {
        const box = day.allocation; // onde está desenhado agora
        // Se ainda estava entrando (clique rápido), sai do ponto em que está.
        day.remove_all_transitions();
        this._cal.remove_child(day);
        ghost.add_child(day);
        day.set_position(box.x1, box.y1);
        day.set_size(box.get_width(), box.get_height());
        // Um dia fantasma não pode ser clicado (voltaria para o mês antigo).
        // reactive=false liga o :insensitive do St, que mudaria a cor: tiramos.
        day.reactive = false;
        day.remove_style_pseudo_class('insensitive');
        day.track_hover = false;
    }

    /**
     * Faz os dias (recém-criados) e o título do mês novo entrarem.
     *
     * @param {boolean} [resume] - continuar do ponto atual da troca
     */
    _bringNewMonth(resume = false) {
        const {start, dir, distance} = this._run;
        const elapsed = (GLib.get_monotonic_time() - start) / 1000;
        const progress = resume ? Math.min(1, elapsed / DURATION) : 0;
        if (progress >= 1)
            return;
        const done = easeOutCubic(progress);
        const left = Math.max(1, Math.round(DURATION * (1 - progress)));
        // Retomando no meio, a curva já está na parte "lenta": QUAD termina suave.
        const mode = resume ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_CUBIC;
        const entering = [...this._days];

        const label = this._cal._monthLabel;
        if (label && !resume) {
            label.translation_x = dir * TITLE_SLIDE;
            label.opacity = 0;
            label.ease({translation_x: 0, opacity: 255, duration: DURATION, mode});
        }

        for (const day of entering) {
            day.translation_x = dir * distance * (1 - done);
            day.opacity = Math.round(255 * done);
            day.ease({translation_x: 0, opacity: 255, duration: left, mode});
        }
    }

    /** Termina tudo no estado final (sem animação). */
    finish() {
        this._ghost?.destroy();
        this._ghost = null;
        this._run = null;
        for (const actor of [...this._days, this._cal._monthLabel].filter(Boolean)) {
            actor.remove_all_transitions();
            actor.translation_x = 0;
            actor.opacity = 255;
        }
    }

    /** Devolve o calendário como o GNOME o deixou. */
    destroy() {
        this.finish();
        // Apaga a NOSSA versão: volta a valer a do protótipo (a do GNOME).
        delete this._cal._rebuildCalendar;
        this._layer.destroy();
    }
}
