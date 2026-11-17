// SPDX-License-Identifier: GPL-3.0-or-later
// Temperatura atual para o relógio, via libgweather (a mesma biblioteca que o
// relógio e o app Clima do GNOME usam). Sem chave de API.
//
// Por que um cliente nosso e não o do Shell (misc/weather.js)? O do Shell não
// tem destroy(): criá-lo numa extensão vazaria sinais a cada desativação.
//
// Localização (nesta ordem):
//   - "manual" nas preferências: a cidade escolhida (latitude/longitude);
//   - "automática": a do GNOME — se a localização automática do Clima estiver
//     ligada, o Geoclue (só a CIDADE, precisão baixa); senão, a primeira
//     cidade salva em org.gnome.shell.weather (Salvador, no seu caso).
// Só coordenadas aproximadas da cidade vão para o serviço de clima.
//
// Atualização: ao ativar, depois a cada 30 min (UM timeout, rearmado) e
// quando a rede volta. Offline ou com erro, fica o último valor, marcado como
// "velho" (o relógio o mostra esmaecido).
//
// Previsão (página Clima): a MESMA leitura traz a lista de previsões
// (get_forecast_list). Com o MET Norway ela vem de hora em hora nos primeiros
// ~3 dias e depois de 6 em 6 horas, até ~10 dias, começando na hora atual.
// O serviço NÃO dá mínima/máxima do dia (get_value_temp_min/max devolvem
// false): calculamos juntando as previsões de cada dia.

import Geoclue from 'gi://Geoclue';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather?version=4.0';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {TimeoutRegistry, debug, logError} from '../../util.js';

Gio._promisify(Geoclue.Simple, 'new');

const UPDATE_INTERVAL = 30 * 60 * 1000; // ms
/** Depois disso sem atualizar, o valor guardado é "velho". */
const STALE_AFTER = 2 * 60 * 60; // s
/** Quantas horas da previsão por hora guardar (a página mostra menos). */
const HOURS_KEPT = 24;
/** No máximo hoje + 9 dias (o limite da preferência). */
const DAYS_KEPT = 10;
/** Hora "representativa" do dia, para o ícone quando não há chuva etc. */
const MIDDAY = 13;
const CONTACT = 'https://github.com/viniciusbispo19/aerotask';

export class WeatherService extends Signals.EventEmitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._timers = new TimeoutRegistry();
        this._updateTimer = 0;
        this._destroyed = false;
        this._failed = false;
        this._value = this._loadCache();

        this._shellWeather = new Gio.Settings({schema_id: 'org.gnome.shell.weather'});
        this._info = new GWeather.Info({
            application_id: 'org.gnome.Shell',
            contact_info: CONTACT,
            enabled_providers: GWeather.Provider.METAR | GWeather.Provider.MET_NO,
        });
        this._info.connectObject('updated', () => this._onUpdated(), this);

        this._network = Gio.NetworkMonitor.get_default();
        this._wasOnline = this._network.network_available;
        this._network.connectObject('network-changed', (_m, available) => {
            // A rede VOLTOU: atualiza na hora (só na volta, não a cada mudança).
            if (available && !this._wasOnline)
                this.refresh();
            this._wasOnline = available;
        }, this);

        settings.connectObject(
            'changed::weather-enabled', () => this._restart(),
            'changed::weather-location-mode', () => this._restart(),
            'changed::weather-manual-coords', () => this._restart(),
            'changed::weather-unit', () => this.emit('changed'),
            this);
        this._shellWeather.connectObject('changed::locations', () => this._restart(), this);

        this._restart();
    }

    /**
     * @returns {object|null} {celsius, icon, condition, place, time, stale,
     *   hours, days}; null = sem dado (ou desligado nas preferências).
     *   hours = [{time, celsius, icon}] (time em segundos Unix);
     *   days = [{time (meia-noite local), min, max, icon, condition}]
     */
    get value() {
        if (!this._settings.get_boolean('weather-enabled') || !this._value)
            return null;
        const age = GLib.get_real_time() / 1e6 - this._value.time;
        return {...this._value, stale: this._failed || age > STALE_AFTER};
    }

    get unit() {
        return this._settings.get_string('weather-unit');
    }

    async _restart() {
        this._timers.remove(this._updateTimer);
        this._updateTimer = 0;
        this._info.abort();
        this.emit('changed');
        if (!this._settings.get_boolean('weather-enabled'))
            return;
        try {
            const location = await this._findLocation();
            if (this._destroyed)
                return;
            if (!location) {
                debug('clima: sem localização');
                return;
            }
            this._info.set_location(location);
            this.refresh();
        } catch (e) {
            logError(e, 'clima: procurando a localização');
        }
    }

    /** Pede dados novos agora (e reprograma o próximo para daqui a 30 min). */
    refresh() {
        if (this._destroyed || !this._info.location)
            return;
        this._timers.remove(this._updateTimer);
        this._updateTimer = this._timers.add(UPDATE_INTERVAL, () => {
            this._updateTimer = 0;
            this.refresh();
        });
        this._info.update();
    }

    async _findLocation() {
        const world = GWeather.Location.get_world();
        if (this._settings.get_string('weather-location-mode') === 'manual') {
            const [lat, lon] = this._settings.get_value('weather-manual-coords').deepUnpack();
            return lat || lon ? world.find_nearest_city(lat, lon) : null;
        }

        // Automática: a mesma escolha do relógio do GNOME.
        const auto = this._shellWeather.get_boolean('automatic-location');
        const locationOn = new Gio.Settings({schema_id: 'org.gnome.system.location'})
            .get_boolean('enabled');
        if (auto && locationOn) {
            try {
                const simple = await Geoclue.Simple.new('org.gnome.Shell',
                    Geoclue.AccuracyLevel.CITY, null);
                const where = simple.get_location();
                if (where)
                    return world.find_nearest_city(where.latitude, where.longitude);
            } catch (e) {
                debug('clima: Geoclue indisponível, usando a cidade salva:', e.message);
            }
        }
        const saved = this._shellWeather.get_value('locations').deepUnpack();
        return saved.length ? world.deserialize(saved[0]) : null;
    }

    _onUpdated() {
        const info = this._info;
        const [ok, celsius] = info.get_value_temp(GWeather.TemperatureUnit.CENTIGRADE);
        if (!info.is_valid() || !ok) {
            // Offline ou erro: fica o último valor, esmaecido. Sem alerta.
            this._failed = true;
            this.emit('changed');
            return;
        }
        this._failed = false;
        // A condição vem traduzida pelo próprio libgweather ("Parcialmente
        // nublado"). "-" = sem fenômeno; aí usamos o céu.
        let forecast = {hours: [], days: []};
        try {
            forecast = readForecast(info, celsius);
        } catch (e) {
            logError(e, 'clima: lendo a previsão');
        }
        this._value = {
            celsius,
            icon: info.get_symbolic_icon_name(), // já tem variante dia/noite
            condition: conditionOf(info),
            place: info.get_location_name() ?? '',
            time: Math.floor(GLib.get_real_time() / 1e6),
            ...forecast,
        };
        this._saveCache();
        this.emit('changed');
    }

    _loadCache() {
        try {
            const json = this._settings.get_string('weather-cache');
            const value = json ? JSON.parse(json) : null;
            if (!Number.isFinite(value?.celsius))
                return null;
            // Cache de versões antigas (sem previsão).
            value.hours = Array.isArray(value.hours) ? value.hours : [];
            value.days = Array.isArray(value.days) ? value.days : [];
            return value;
        } catch {
            return null;
        }
    }

    _saveCache() {
        this._settings.set_string('weather-cache', JSON.stringify(this._value));
    }

    destroy() {
        this._destroyed = true;
        this._timers.clear();
        this._info.disconnectObject(this);
        this._info.abort();
        this._network.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._shellWeather.disconnectObject(this);
    }
}

/**
 * A condição por extenso, já traduzida pelo libgweather ("Chuva leve").
 * "-" = sem fenômeno (chuva, neblina…); aí vale o céu ("Nublado").
 *
 * @param {GWeather.Info} info
 * @returns {string}
 */
function conditionOf(info) {
    const conditions = info.get_conditions();
    return conditions && conditions !== '-' ? conditions : info.get_sky();
}

/**
 * Junta a lista de previsões em "próximas horas" e "dias".
 *
 * Ícone do dia: se alguma previsão DE DIA tem fenômeno (chuva, trovoada…), o
 * dia leva esse ícone — como no macOS, o que importa é saber que vai chover;
 * senão, o da previsão mais perto das 13 h.
 *
 * @param {GWeather.Info} info - já atualizado
 * @param {number} nowCelsius - temperatura agora (entra na mín./máx. de hoje)
 * @returns {{hours: object[], days: object[]}}
 */
function readForecast(info, nowCelsius) {
    const C = GWeather.TemperatureUnit.CENTIGRADE;
    const now = Math.floor(GLib.get_real_time() / 1e6);
    const entries = [];
    for (const f of info.get_forecast_list() ?? []) {
        const [hasTime, time] = f.get_value_update();
        const [hasTemp, celsius] = f.get_value_temp(C);
        if (!hasTime || !hasTemp)
            continue;
        const conditions = f.get_conditions();
        entries.push({
            time,
            celsius,
            icon: f.get_symbolic_icon_name(),
            condition: conditionOf(f),
            phenomenon: Boolean(conditions && conditions !== '-'),
            daytime: f.is_daytime(),
        });
    }
    entries.sort((a, b) => a.time - b.time);

    const hours = entries
        .filter(e => e.time > now)
        .slice(0, HOURS_KEPT)
        .map(({time, celsius, icon}) => ({time, celsius, icon}));

    // Agrupa por dia LOCAL (meia-noite no fuso do computador).
    const groups = new Map();
    const today = midnight(now);
    for (const e of entries) {
        const day = midnight(e.time);
        if (day < today)
            continue;
        if (!groups.has(day))
            groups.set(day, []);
        groups.get(day).push(e);
    }

    const days = [];
    for (const [day, list] of groups) {
        // Um dia com uma previsão só (o fim da lista) não diz mín./máx.
        if (day !== today && list.length < 2)
            continue;
        const temps = list.map(e => e.celsius);
        if (day === today)
            temps.push(nowCelsius);
        const daytime = list.filter(e => e.daytime);
        const pool = daytime.length ? daytime : list;
        const pick = pool.find(e => e.phenomenon) ??
            pool.reduce((best, e) => (Math.abs(hourOf(e.time) - MIDDAY) <
                Math.abs(hourOf(best.time) - MIDDAY) ? e : best));
        days.push({
            time: day,
            min: Math.min(...temps),
            max: Math.max(...temps),
            // O ícone do dia é sempre a versão "de dia" (sem -night).
            icon: pick.icon.replace('-night-symbolic', '-symbolic'),
            condition: pick.condition,
        });
        if (days.length >= DAYS_KEPT)
            break;
    }
    return {hours, days};
}

/** @returns {number} meia-noite local do dia de `time` (segundos Unix) */
function midnight(time) {
    const dt = GLib.DateTime.new_from_unix_local(time);
    return GLib.DateTime.new_local(dt.get_year(), dt.get_month(), dt.get_day_of_month(), 0, 0, 0)
        .to_unix();
}

/** @returns {number} hora local (0–23) de `time` (segundos Unix) */
function hourOf(time) {
    return GLib.DateTime.new_from_unix_local(time).get_hour();
}
