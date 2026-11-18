// SPDX-License-Identifier: GPL-3.0-or-later
// Estado da bateria (UPower) e do modo de economia (power-profiles-daemon ou
// tuned-ppd), só por SINAIS do D-Bus — nada de perguntar a cada X segundos.
//
// UPower expõe um "DisplayDevice": a bateria combinada do notebook, a mesma
// que o ícone do GNOME usa. Quando algo muda (porcentagem, carregando, tempo
// restante), ele emite PropertiesChanged; o proxy do Gio guarda os valores
// e emite "g-properties-changed".

import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {TimeoutRegistry, isExpectedDBusError, logError} from '../../util.js';

/** Novas tentativas de falar com o UPower: 2 s, 4 s, 8 s… até 30 s. */
const RETRY_FIRST = 2000;
const RETRY_MAX = 30000;

// As mesmas interfaces que o GNOME Shell usa (ui/status/system.js e
// ui/status/powerProfiles.js), vindas dos recursos do próprio Shell.
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.Device'));
const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.PowerProfiles'));
// O objeto principal do UPower: só precisamos de "OnBattery" (o computador
// está ou não na tomada). Interface escrita aqui (o Shell não traz o XML).
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
  </interface>
</node>`);

// Estados do UPower (org.freedesktop.UPower.Device, propriedade State).
const State = {
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
};

export class PowerService extends Signals.EventEmitter {
    constructor() {
        super();
        this._device = null;
        this._profiles = null;
        this._upower = null;
        this._cancellable = new Gio.Cancellable();
        this._timers = new TimeoutRegistry();
        this._retryDelay = RETRY_FIRST;

        this._connectDevice();

        new UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            (proxy, error) => {
                if (error || this._cancellable.is_cancelled())
                    return; // sem ele, vale só o estado da bateria
                this._upower = proxy;
                proxy.connectObject(
                    'g-properties-changed', () => this.emit('changed'),
                    'notify::g-name-owner', () => this.emit('changed'),
                    this);
                this.emit('changed');
            }, this._cancellable);

        new PowerProfilesProxy(Gio.DBus.system, 'org.freedesktop.UPower.PowerProfiles',
            '/org/freedesktop/UPower/PowerProfiles',
            (proxy, error) => {
                if (error) {
                    // Sem power-profiles-daemon/tuned-ppd: só não há "economia".
                    return;
                }
                this._profiles = proxy;
                proxy.connectObject(
                    'g-properties-changed', () => this.emit('changed'),
                    'notify::g-name-owner', () => this.emit('changed'),
                    this);
                this.emit('changed');
            }, this._cancellable);
    }

    /**
     * Proxy do "DisplayDevice" do UPower. O construtor com callback é
     * ASSÍNCRONO (não trava o Shell). Se falhar (ex.: no login o UPower ainda
     * não respondeu), tenta de novo com espera crescente.
     */
    _connectDevice() {
        new UPowerDeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (this._cancellable.is_cancelled())
                    return;
                if (error) {
                    if (!isExpectedDBusError(error))
                        logError(error, 'conectando ao UPower');
                    this._timers.add(this._retryDelay, () => this._connectDevice());
                    this._retryDelay = Math.min(this._retryDelay * 2, RETRY_MAX);
                    return;
                }
                this._device = proxy;
                this._retryDelay = RETRY_FIRST;
                proxy.connectObject(
                    'g-properties-changed', () => this.emit('changed'),
                    // O UPower reiniciou (ou caiu): o proxy segue o novo dono
                    // do nome e recarrega as propriedades.
                    'notify::g-name-owner', () => this.emit('changed'),
                    this);
                this.emit('changed');
            }, this._cancellable);
    }

    /** O UPower já respondeu (sabemos se há bateria ou não)? */
    get ready() {
        return Boolean(this._device?.g_name_owner);
    }

    /** UPower respondeu e diz que NÃO há bateria (desktop)? */
    get noBattery() {
        return this.ready && !this._device.IsPresent;
    }

    /**
     * @returns {object|null} null se não há bateria (desktop) ou ainda não leu
     */
    get state() {
        const d = this._device;
        if (!d || !d.IsPresent)
            return null;
        const state = d.State;
        const charging = state === State.CHARGING;
        const full = state === State.FULLY_CHARGED;
        // Na tomada? Quem sabe de verdade é o UPower ("OnBattery"): com um
        // limite de carga, a bateria fica "descarregando" bem devagar mesmo
        // com o carregador ligado. Sem essa resposta, deduzimos do estado.
        const onBattery = this._upower?.g_name_owner ? this._upower.OnBattery : null;
        const pluggedIn = onBattery === null
            ? charging || full || state === State.PENDING_CHARGE
            : !onBattery;
        return {
            percentage: d.Percentage,
            charging,
            full,
            // Na tomada mas sem carregar: cheia, ou segurando a carga.
            pluggedIn,
            timeToEmpty: Number(d.TimeToEmpty ?? 0),
            timeToFull: Number(d.TimeToFull ?? 0),
            powerSaver: this._profiles?.ActiveProfile === 'power-saver',
        };
    }

    /**
     * Modos de energia que o computador oferece (power-profiles-daemon ou
     * tuned-ppd), do mais econômico ao mais rápido: 'power-saver',
     * 'balanced', 'performance'. Vazio se o serviço não existe.
     *
     * @returns {string[]}
     */
    get profiles() {
        const p = this._profiles;
        if (!p?.g_name_owner)
            return [];
        // "Profiles" é aa{sv}: só o primeiro nível vem "desembrulhado" (como
        // em ui/status/powerProfiles.js do GNOME).
        return (p.Profiles ?? []).map(profile => profile.Profile?.unpack())
            .filter(Boolean);
    }

    /** @returns {string|null} o modo ativo agora */
    get activeProfile() {
        return this._profiles?.g_name_owner ? this._profiles.ActiveProfile : null;
    }

    /**
     * Troca o modo de energia. O "setter" do proxy grava a propriedade no
     * D-Bus de forma assíncrona (o mesmo que o GNOME faz); a mudança volta
     * como "g-properties-changed" → "changed".
     *
     * @param {string} profile
     */
    setProfile(profile) {
        if (this._profiles?.g_name_owner && this.profiles.includes(profile))
            this._profiles.ActiveProfile = profile;
    }

    destroy() {
        this._cancellable.cancel();
        this._timers.clear();
        this._device?.disconnectObject(this);
        this._profiles?.disconnectObject(this);
        this._upower?.disconnectObject(this);
        this._upower = null;
        this._device = null;
        this._profiles = null;
    }
}
