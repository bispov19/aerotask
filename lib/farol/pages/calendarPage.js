// SPDX-License-Identifier: GPL-3.0-or-later
// Página Calendário do Farol: o mês ao lado dos eventos do dia selecionado.
//
// Não criamos um segundo calendário: EMPRESTAMOS o do GNOME (o mesmo widget
// que aparece ao clicar no relógio) enquanto a página está na tela, e o
// devolvemos ao fechar o Farol. Os eventos vêm da MESMA fonte que o relógio
// do GNOME usa (dateMenu._eventSource → org.gnome.Shell.CalendarServer →
// Evolution Data Server: Google, Nextcloud, contas online…).
//
// Por que emprestar em vez de criar um Calendar.Calendar novo? A classe do
// Shell conecta sinais do GSettings que ela nunca desconecta: um calendário
// novo a cada ativação da extensão seria um vazamento. E assim a semana, os
// feriados marcados e o estilo são exatamente os do GNOME (domingo primeiro
// em pt-BR, ou o que você escolheu nas Configurações).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CalendarMotion} from './calendarMotion.js';
import {T, formatDayTitle, formatTimeRange} from '../strings.js';
import {logError} from '../../util.js';

/** Crossfade do painel lateral ao trocar de dia (ms): some e aparece. */
const SIDE_FADE_OUT = 70;
const SIDE_FADE_IN = 80;

/**
 * Tira um ator do lugar dele e o coloca em outro, lembrando de onde veio
 * para devolver na mesma posição.
 */
class Borrowed {
    /** @param {Clutter.Actor} actor */
    constructor(actor) {
        this.actor = actor;
        this._parent = actor.get_parent();
        this._index = this._parent?.get_children().indexOf(actor) ?? -1;
    }

    /** @param {St.Widget} slot - um St.Bin ou um contêiner comum */
    moveTo(slot) {
        this._parent?.remove_child(this.actor);
        if (slot instanceof St.Bin)
            slot.set_child(this.actor);
        else
            slot.add_child(this.actor);
    }

    giveBack() {
        this.actor.get_parent()?.remove_child(this.actor);
        if (this._parent) {
            const index = Math.min(Math.max(this._index, 0), this._parent.get_n_children());
            this._parent.insert_child_at_index(this.actor, index);
        }
    }
}

export class CalendarPage {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this.id = 'calendar';
        this._settings = settings;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._calendar = null; // Borrowed
        this._clocks = null; // Borrowed
        this._eventSource = null;
        this._day = startOfDay(new Date());

        this.actor = new St.BoxLayout({style_class: 'aerotask-farol-calendar'});

        this._calendarSlot = new St.Bin({style_class: 'aerotask-farol-calendar-month'});
        this.actor.add_child(this._calendarSlot);
        // "Palco" do calendário: o calendário e, por cima, a camada da troca de
        // mês (calendarMotion.js) ficam empilhados (BinLayout). Ele recorta o
        // que passa da borda, para o deslize não vazar para fora do calendário.
        this._calendarStage = new St.Widget({
            style_class: 'aerotask-farol-calendar-stage',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this._calendarSlot.set_child(this._calendarStage);
        this._motion = null;

        const side = this._side = new St.BoxLayout({
            style_class: 'aerotask-farol-events',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.add_child(side);

        this._title = new St.Label({style_class: 'aerotask-farol-events-title'});
        side.add_child(this._title);

        this._list = new St.BoxLayout({
            style_class: 'aerotask-farol-events-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'aerotask-farol-events-scroll',
            child: this._list,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        side.add_child(this._scroll);

        this._clocksSlot = new St.Bin({
            style_class: 'aerotask-farol-world-clocks',
            x_expand: true,
        });
        side.add_child(this._clocksSlot);

        // Rede de segurança: se a página for destruída com o calendário
        // emprestado dentro, o GNOME perderia o calendário dele. O sinal
        // "destroy" roda ANTES de os filhos serem destruídos, então dá tempo
        // de devolver.
        this.actor.connect('destroy', () => this.hide());
    }

    get title() {
        return T.calendar;
    }

    /** A página "viva" é escolhida ao abrir; o calendário nunca é. */
    get isLive() {
        return false;
    }

    /** A página vai aparecer: pega o calendário emprestado e carrega os eventos. */
    show() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        try {
            // _calendar, _clocksItem e _eventSource são internos do Shell
            // (conferidos no GNOME 51). Se sumirem numa versão futura, a
            // página continua funcionando só com a lista de eventos.
            if (!this._calendar && dateMenu?._calendar) {
                this._calendar = new Borrowed(dateMenu._calendar);
                this._calendar.moveTo(this._calendarStage);
                this._motion = new CalendarMotion(this._calendar.actor, this._calendarStage);
                this._calendar.actor.connectObject('selected-date-changed',
                    (_cal, datetime) => this._setDay(new Date(datetime.to_unix() * 1000), true), this);
            }
            if (!this._clocks && dateMenu?._clocksItem && this._settings.get_boolean('farol-world-clocks')) {
                this._clocks = new Borrowed(dateMenu._clocksItem);
                this._clocks.moveTo(this._clocksSlot);
            }
        } catch (e) {
            logError(e, 'emprestando o calendário do GNOME');
        }

        this._eventSource?.disconnectObject(this);
        this._eventSource = dateMenu?._eventSource ?? null;
        this._eventSource?.connectObject('changed', () => {
            // Trocar de mês faz a agenda avisar "mudou" na mesma hora. Se o
            // painel está sumindo (crossfade), o texto novo espera ele sumir
            // (senão trocaria antes do fade-out); fora disso, atualiza já.
            if (this._sidePhase === 'out')
                this._sideUpdate = () => this._reload();
            else
                this._reload();
        }, this);

        // Como o GNOME faz ao abrir o relógio: volta para hoje.
        const today = new Date();
        if (this._calendar)
            this._calendar.actor.setDate(today);
        this._setDay(today);
    }

    /** O Farol fechou: devolve tudo ao relógio do GNOME. */
    hide() {
        this._eventSource?.disconnectObject(this);
        this._eventSource = null;
        if (this._calendar) {
            this._calendar.actor.disconnectObject(this);
            // Antes de devolver: termina a troca de mês e tira a nossa versão
            // do método do calendário (o GNOME o recebe como emprestou).
            this._motion?.destroy();
            this._motion = null;
            this._calendar.giveBack();
            this._calendar = null;
        }
        // Nada pendente ANTES de parar o fade (o callback dele veria a troca).
        this._sideUpdate = null;
        this._side.remove_all_transitions();
        this._side.opacity = 255;
        this._sideFading = false;
        this._sidePhase = null;
        this._clocks?.giveBack();
        this._clocks = null;
    }

    /**
     * @param {Date} date
     * @param {boolean} [fade] - troca de dia pelo calendário: crossfade no
     *   painel lateral (ao abrir a página, aparece direto)
     */
    _setDay(date, fade = false) {
        this._day = startOfDay(date);
        // Sem o calendário emprestado, nós mesmos pedimos o intervalo à fonte.
        if (!this._calendar) {
            const end = new Date(this._day);
            end.setDate(end.getDate() + 1);
            this._eventSource?.requestRange(this._day, end);
        }
        if (fade)
            this._crossfadeSide(() => this._reload());
        else
            this._reload();
    }

    /**
     * Crossfade rápido do painel lateral (~150 ms: some, troca, aparece).
     * Trocas seguidas durante o fade não acumulam: vale só a última.
     */
    _crossfadeSide(update) {
        if (!St.Settings.get().enable_animations || !this._side.mapped) {
            update();
            return;
        }
        this._sideUpdate = update;
        if (this._sideFading)
            return; // o fade em andamento aplica a mais recente
        this._sideFading = true;
        this._sidePhase = 'out';
        this._side.ease({
            opacity: 0,
            duration: SIDE_FADE_OUT,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                // Interrompido (página fechando): não continua.
                if (!finished) {
                    this._sideFading = false;
                    this._sidePhase = null;
                    return;
                }
                this._sideUpdate?.();
                this._sideUpdate = null;
                this._sidePhase = 'in';
                this._side.ease({
                    opacity: 255,
                    duration: SIDE_FADE_IN,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        this._sideFading = false;
                        this._sidePhase = null;
                        // Chegou outra troca enquanto aparecia: faz de novo.
                        if (this._sideUpdate)
                            this._crossfadeSide(this._sideUpdate);
                    },
                });
            },
        });
    }

    _reload() {
        this._title.text = formatDayTitle(this._day);
        this._list.destroy_all_children();

        const end = new Date(this._day);
        end.setDate(end.getDate() + 1);
        let events = [];
        try {
            if (this._eventSource && !this._eventSource.isLoading)
                events = this._eventSource.getEvents(this._day, end);
        } catch (e) {
            logError(e, 'lendo eventos');
        }

        const use24h = this._interface.get_string('clock-format') === '24h';
        for (const event of events) {
            const row = new St.BoxLayout({style_class: 'aerotask-farol-event'});
            const allDay = event.date <= this._day && event.end >= end;
            row.add_child(new St.Label({
                style_class: 'aerotask-farol-event-time',
                text: allDay ? T.allDay : formatTimeRange(event.date, event.end, use24h),
                y_align: Clutter.ActorAlign.START,
            }));
            const summary = new St.Label({
                style_class: 'aerotask-farol-event-summary',
                text: event.summary ?? '',
                x_expand: true,
            });
            row.add_child(summary);
            this._list.add_child(row);
        }

        if (events.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'aerotask-farol-placeholder',
                text: T.noEvents,
            }));
        }
    }

    destroy() {
        this.hide();
        this.actor.destroy();
    }
}

/**
 * @param {Date} date
 * @returns {Date} meia-noite do mesmo dia
 */
function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}
