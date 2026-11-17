// SPDX-License-Identifier: GPL-3.0-or-later
// Página Clima do pop-up do relógio: o tempo agora, a previsão de hoje hora a
// hora e a dos próximos dias.
//
//    ☁  27°  Nublado                                   Salvador
//            Máx. 29°  Mín. 24°
//    ───────────────────────────────────────────────────────────
//    Agora   16:00   17:00   18:00   19:00   20:00   21:00   22:00
//     ☁       ☁       ☁       ☁      🌧      🌧      🌧       ☁
//    27°     27°     27°     26°     26°     26°     26°     25°
//    ───────────────────────────────────────────────────────────
//    Hoje           🌧  Chuva leve        24°  ━━━━━━━━━    29°
//    Quarta-feira   🌧  Chuva leve        24°    ━━━━━━━━━  29°
//    …
//
// Os dados vêm do WeatherService (a mesma leitura que põe a temperatura ao
// lado do relógio — nenhuma consulta extra). A página só se monta quando está
// na tela; fora dela, ignora as atualizações.
//
// A barrinha de cada dia mostra a faixa mín.–máx. dentro da faixa da SEMANA
// (como no macOS): dá para comparar os dias de relance.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {T, formatForecastHour, formatTemperature, formatWeekday} from '../strings.js';

/** Quantas horas cabem na faixa "hora a hora" (Agora + 7). */
const HOUR_SLOTS = 8;

export class WeatherPage {
    /**
     * @param {Gio.Settings} settings
     * @param {WeatherService} weather
     */
    constructor(settings, weather) {
        this.id = 'weather';
        this._settings = settings;
        this._weather = weather;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._visible = false;

        this.actor = new St.BoxLayout({
            style_class: 'aerotask-weather',
            orientation: Clutter.Orientation.VERTICAL,
        });
    }

    get title() {
        return T.weather;
    }

    /** O clima nunca "chama" o pop-up para si ao abrir. */
    get isLive() {
        return false;
    }

    show() {
        this._visible = true;
        this._weather.connectObject('changed', () => this._rebuild(), this);
        this._settings.connectObject(
            'changed::weather-show-hourly', () => this._rebuild(),
            'changed::weather-show-days', () => this._rebuild(),
            'changed::weather-forecast-days', () => this._rebuild(),
            this);
        this._rebuild();
    }

    hide() {
        this._visible = false;
        this._weather.disconnectObject(this);
        this._settings.disconnectObject(this);
    }

    _rebuild() {
        if (!this._visible)
            return;
        this.actor.destroy_all_children();

        const value = this._weather.value;
        if (!value) {
            this.actor.add_child(new St.Label({
                style_class: 'aerotask-farol-placeholder',
                text: T.noWeather,
            }));
            return;
        }
        const unit = this._weather.unit;
        const now = Math.floor(GLib.get_real_time() / 1e6);
        const days = value.days ?? [];
        const today = days[0] && days[0].time <= now ? days[0] : null;

        this.actor.add_child(this._buildNow(value, today, unit));

        if (this._settings.get_boolean('weather-show-hourly')) {
            const hours = (value.hours ?? []).filter(h => h.time > now);
            if (hours.length)
                this.actor.add_child(this._buildHours(value, hours, unit));
        }

        if (this._settings.get_boolean('weather-show-days')) {
            // Hoje + os próximos N dias.
            const count = this._settings.get_int('weather-forecast-days');
            const shown = days.filter(d => d.time + 24 * 3600 > now).slice(0, count + 1);
            if (shown.length)
                this.actor.add_child(this._buildDays(shown, unit));
        }

        const updated = GLib.DateTime.new_from_unix_local(value.time);
        this.actor.add_child(new St.Label({
            style_class: 'aerotask-weather-updated',
            text: T.weatherUpdated.replace('{time}', formatForecastHour(updated, this._use24h(), true)),
            x_align: Clutter.ActorAlign.END,
        }));
        this.actor.opacity = value.stale ? 150 : 255;
    }

    _use24h() {
        return this._interface.get_string('clock-format') === '24h';
    }

    /** Ícone grande + temperatura + condição; máx./mín. de hoje; cidade. */
    _buildNow(value, today, unit) {
        const box = new St.BoxLayout({style_class: 'aerotask-weather-now'});
        box.add_child(new St.Icon({
            style_class: 'aerotask-weather-now-icon',
            icon_name: value.icon,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'aerotask-weather-now-temp',
            text: formatTemperature(value.celsius, unit),
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        text.add_child(new St.Label({
            style_class: 'aerotask-weather-now-condition',
            text: value.condition ?? '',
        }));
        if (today) {
            text.add_child(new St.Label({
                style_class: 'aerotask-weather-dim',
                text: T.weatherHighLow
                    .replace('{max}', formatTemperature(today.max, unit))
                    .replace('{min}', formatTemperature(today.min, unit)),
            }));
        }
        box.add_child(text);

        if (value.place) {
            box.add_child(new St.Label({
                style_class: 'aerotask-weather-dim',
                text: value.place,
                y_align: Clutter.ActorAlign.START,
            }));
        }
        return box;
    }

    /** "Agora" + as próximas horas, lado a lado. */
    _buildHours(value, hours, unit) {
        const row = new St.BoxLayout({style_class: 'aerotask-weather-hours'});
        const slot = (label, icon, celsius) => {
            const col = new St.BoxLayout({
                style_class: 'aerotask-weather-hour',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            col.add_child(new St.Label({
                style_class: 'aerotask-weather-dim',
                text: label,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            col.add_child(new St.Icon({
                style_class: 'aerotask-weather-hour-icon',
                icon_name: icon,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            col.add_child(new St.Label({
                style_class: 'aerotask-weather-temp',
                text: formatTemperature(celsius, unit),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(col);
        };
        slot(T.now, value.icon, value.celsius);
        const use24h = this._use24h();
        for (const h of hours.slice(0, HOUR_SLOTS - 1))
            slot(formatForecastHour(GLib.DateTime.new_from_unix_local(h.time), use24h), h.icon, h.celsius);
        return row;
    }

    /** Uma linha por dia: nome, ícone, condição, mín., barrinha, máx. */
    _buildDays(days, unit) {
        const list = new St.BoxLayout({
            style_class: 'aerotask-weather-days',
            orientation: Clutter.Orientation.VERTICAL,
        });
        // Faixa da semana inteira (a escala das barrinhas).
        const low = Math.min(...days.map(d => d.min));
        const high = Math.max(...days.map(d => d.max));
        const now = Math.floor(GLib.get_real_time() / 1e6);

        for (const day of days) {
            const row = new St.BoxLayout({style_class: 'aerotask-weather-day'});
            const isToday = day.time <= now;
            row.add_child(new St.Label({
                style_class: 'aerotask-weather-day-name',
                text: isToday ? T.today : formatWeekday(GLib.DateTime.new_from_unix_local(day.time)),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Icon({
                style_class: 'aerotask-weather-day-icon',
                icon_name: day.icon,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                style_class: 'aerotask-weather-dim aerotask-weather-day-condition',
                text: day.condition ?? '',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                style_class: 'aerotask-weather-dim aerotask-weather-day-temp',
                text: formatTemperature(day.min, unit),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(rangeBar(day.min, day.max, low, high));
            row.add_child(new St.Label({
                style_class: 'aerotask-weather-day-temp',
                text: formatTemperature(day.max, unit),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            list.add_child(row);
        }
        return list;
    }

    destroy() {
        this.hide();
        this.actor.destroy();
    }
}

/**
 * Barrinha mín.–máx. do dia dentro da faixa da semana. Desenhada com Cairo
 * no tamanho REAL da área (já com a escala da tela): nítida em qualquer
 * escala, sem contas de pixel no JS.
 */
function rangeBar(min, max, low, high) {
    const area = new St.DrawingArea({
        style_class: 'aerotask-weather-bar',
        y_align: Clutter.ActorAlign.CENTER,
    });
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const color = area.get_theme_node().get_foreground_color();
        const span = Math.max(high - low, 1);
        const r = height / 2;
        const pill = (x0, x1) => {
            const w = Math.max(x1 - x0, height);
            cr.newSubPath();
            cr.arc(x0 + r, r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(x0 + w - r, r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.fill();
        };
        // Trilho (a semana) em cinza; a faixa do dia na cor do texto.
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.25);
        pill(0, width);
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 0.9);
        const x0 = (min - low) / span * (width - height);
        const x1 = (max - low) / span * (width - height) + height;
        pill(x0, x1);
        cr.$dispose();
    });
    return area;
}
