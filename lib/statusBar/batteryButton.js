// SPDX-License-Identifier: GPL-3.0-or-later
// Botão da bateria na barra, com o pop-up do macOS:
//
//   Bateria                                 75%
//   Fonte de Energia: Bateria
//   3 h 20 min restantes      (ou "Carregada", "A Bateria Não Está Carregando")
//   ─────────────────────────────────────────
//   MODO DE ENERGIA
//   (●) Pouca Energia
//   (○) Automático
//   (○) Alto Desempenho
//   ─────────────────────────────────────────
//   Nenhum App Usando Muita Energia
//   ─────────────────────────────────────────
//   Configurações da Bateria…
//
// O ÍCONE é o mesmo BatteryIndicator de lib/farol/batteryIcon.js (desenhado
// com Cairo): este botão só o "adota" (setContainer) e devolve no destroy.
// Assim o desenho, a porcentagem e as preferências continuam num lugar só.
//
// Os dados vêm do PowerService do ícone (UPower + modos de energia do
// power-profiles-daemon/tuned-ppd, só por sinais do D-Bus). "Modo de Energia"
// usa os nomes do macOS: Pouca Energia = power-saver, Automático = balanced,
// Alto Desempenho = performance (só os modos que o computador oferece).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {openSettingsPanel} from '../actions.js';
import {formatDuration, formatPercent} from '../farol/strings.js';
import {appDisplayName} from '../windowTracker.js';
import {EnergyMonitor} from './energyUsage.js';
import {StatusMenuButton, plainItem, separatorItem} from './common.js';

/** Modos na ordem do macOS (do mais econômico ao mais rápido). */
const PROFILES = {
    'power-saver': {
        label: () => pgettext('Power mode', 'Low Power'),
        iconName: 'power-profile-power-saver-symbolic',
    },
    'balanced': {
        label: () => pgettext('Power mode', 'Automatic'),
        iconName: 'power-profile-balanced-symbolic',
    },
    'performance': {
        label: () => pgettext('Power mode', 'High Power'),
        iconName: 'power-profile-performance-symbolic',
    },
};

/**
 * Linha só de texto que NÃO fica cinza nem azul (título "Bateria").
 *
 * Por que não `activatable: false`: o St marca widgets com reactive=false
 * como :insensitive, e o Blur my Shell pinta esses itens com branco 50%. Aqui
 * o item é reativo, mas não ativa, não acende e não recebe foco.
 */
const InfoItem = GObject.registerClass(
class AeroTaskBatteryInfoItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, styleClass) {
        super._init({
            style_class: `aerotask-menu-item ${styleClass}`,
            reactive: true,
            activate: false,
            hover: false,
            can_focus: false,
        });
        this.track_hover = false;
        this.remove_style_class_name('popup-inactive-menu-item');

        this.label = new St.Label({
            text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;

        this.side = new St.Label({
            style_class: 'aerotask-battery-menu-percent',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.side);
    }
});

/**
 * Uma linha com ícone num círculo (azul = ativo), como os aparelhos do
 * Bluetooth. Clicar NÃO fecha o pop-up (você vê o modo trocar, como no macOS).
 */
const CircleItem = GObject.registerClass(
class AeroTaskBatteryCircleItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, onActivate) {
        super._init({style_class: 'aerotask-menu-item aerotask-status-device'});
        this._onActivate = onActivate;

        this.icon = new St.Icon({
            style_class: 'aerotask-status-device-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.icon);

        this.label = new St.Label({
            text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;
    }

    /** @param {boolean} active - círculo azul */
    setActive(active) {
        if (active)
            this.icon.add_style_pseudo_class('checked');
        else
            this.icon.remove_style_pseudo_class('checked');
    }

    activate(_event) {
        // Sem super.activate(): é ele que emite "activate" e fecha o menu.
        this._onActivate();
    }
});

/** Um app da lista "Usando Muita Energia": ícone do app e nome. */
const AppItem = GObject.registerClass(
class AeroTaskBatteryAppItem extends PopupMenu.PopupBaseMenuItem {
    _init(app) {
        super._init({style_class: 'aerotask-menu-item aerotask-battery-app'});
        this.app = app;
        const icon = app.create_icon_texture(16);
        icon.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(icon);
        this.label = new St.Label({
            // Nome amigável também para apps sem .desktop ("CpuHog", não
            // "dev.aerotask.CpuHog").
            text: appDisplayName(app, app.get_windows()[0] ?? null),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;
    }

    activate(event) {
        // Mostra o app (traz a janela dele para a frente) e fecha o menu.
        this.app.activate();
        super.activate(event);
    }
});

export const BatteryButton = GObject.registerClass(
class AeroTaskBatteryButton extends StatusMenuButton {
    /**
     * @param {object} battery - o BatteryIndicator (lib/farol/batteryIcon.js)
     * @param {() => object} getAppearance
     */
    _init(battery, getAppearance) {
        super._init(_('Battery'), getAppearance);
        this._battery = battery;
        this._power = battery.power;
        this._energy = new EnergyMonitor();
        this._profileItems = new Map(); // nome do modo → CircleItem
        this._appKey = null; // apps da lista atual (evita refazer à toa)

        // O ícone de bateria do AeroTask passa para dentro deste botão; o
        // botão aparece e some junto com ele (opção desligada, desktop…).
        battery.setContainer(this);
        this._bindings = [
            battery.actor.bind_property('visible', this, 'visible',
                GObject.BindingFlags.SYNC_CREATE),
        ];

        // Conteúdo pronto desde já (o Blur my Shell mede o pop-up ao abrir).
        this._buildMenu();
        this._power.connectObject('changed', () => this._sync(), this);

        // Ponteiro sobre o ícone: começa a medir o uso de CPU (lista pronta
        // no clique). Com o pop-up aberto, a dica do ícone não aparece.
        this.connect('notify::hover', () => {
            if (this.hover)
                this._energy.prime();
        });
        this._sync();
    }

    _buildMenu() {
        this._title = new InfoItem(_('Battery'), 'aerotask-battery-menu-title');
        this.menu.addMenuItem(this._title);

        this._source = plainItem('', false);
        this._source.add_style_class_name('aerotask-status-placeholder');
        this.menu.addMenuItem(this._source);

        this._time = plainItem('', false);
        this._time.add_style_class_name('aerotask-status-placeholder');
        this.menu.addMenuItem(this._time);

        // Modo de energia (some se o computador não tem o serviço).
        this._profilesSeparator = separatorItem();
        this.menu.addMenuItem(this._profilesSeparator);
        this._profilesHeader = plainItem(_('Power Mode'), false);
        this._profilesHeader.add_style_class_name('aerotask-menu-header');
        this.menu.addMenuItem(this._profilesHeader);
        this._profiles = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profiles);

        // Apps usando muita energia.
        this.menu.addMenuItem(separatorItem());
        this._appsHeader = plainItem(_('Using Significant Energy'), false);
        this._appsHeader.add_style_class_name('aerotask-menu-header');
        this.menu.addMenuItem(this._appsHeader);
        this._apps = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._apps);
        this._noApps = plainItem(_('No Apps Using Significant Energy'), false);
        this._noApps.add_style_class_name('aerotask-status-placeholder');
        this.menu.addMenuItem(this._noApps);
        this._showApps([]);

        this.menu.addMenuItem(separatorItem());
        const settings = plainItem(_('Battery Settings…'));
        settings.connect_after('activate', () => openSettingsPanel('power'));
        this.menu.addMenuItem(settings);
    }

    _onMenuOpen() {
        this._battery.setTooltipEnabled(false);
        this._sync();
        this._energy.start(apps => this._showApps(apps));
    }

    _onMenuClose() {
        this._battery.setTooltipEnabled(true);
        this._energy.stop();
    }

    _sync() {
        const state = this._power.state;
        this._title.side.text = state ? formatPercent(state.percentage / 100) : '';

        // "Fonte de Energia": na tomada (carregando ou não) ou bateria.
        this._source.visible = Boolean(state);
        if (state) {
            this._source.label.text = state.pluggedIn
                ? _('Power Source: Power Adapter')
                : _('Power Source: Battery');
        }

        // Tempo: só quando o UPower sabe (no começo da descarga ele ainda
        // está calculando e manda 0).
        const time = this._timeText(state);
        this._time.visible = Boolean(time);
        this._time.label.text = time;

        this._syncProfiles();
    }

    _timeText(state) {
        if (!state)
            return '';
        if (state.full)
            return _('Charged');
        if (state.charging && state.timeToFull > 0) {
            /* Translators: battery, e.g. "1 h 05 min until full". */
            return _('{time} until full').replace('{time}', formatDuration(state.timeToFull));
        }
        // Na tomada, mas sem carregar (ex.: limite de carga): como no macOS.
        if (state.pluggedIn && !state.charging)
            return _('Battery Is Not Charging');
        if (!state.pluggedIn && state.timeToEmpty > 0) {
            /* Translators: battery, e.g. "3 h 20 min left". */
            return _('{time} left').replace('{time}', formatDuration(state.timeToEmpty));
        }
        return '';
    }

    _syncProfiles() {
        const available = this._power.profiles;
        const wanted = Object.keys(PROFILES).filter(p => available.includes(p));

        // Lista de modos mudou (serviço apareceu/sumiu): refaz.
        if (wanted.join() !== [...this._profileItems.keys()].join()) {
            this._profiles.removeAll();
            this._profileItems.clear();
            for (const profile of wanted) {
                const {label, iconName} = PROFILES[profile];
                const item = new CircleItem(label(), () => this._power.setProfile(profile));
                item.icon.icon_name = iconName;
                this._profileItems.set(profile, item);
                this._profiles.addMenuItem(item);
            }
        }

        const active = this._power.activeProfile;
        for (const [profile, item] of this._profileItems)
            item.setActive(profile === active);

        const any = this._profileItems.size > 0;
        this._profilesSeparator.visible = any;
        this._profilesHeader.visible = any;
        this._profiles.actor.visible = any;
    }

    /** @param {{app: Shell.App, cpu: number}[]} heavy */
    _showApps(heavy) {
        const key = heavy.map(h => h.app.get_id()).join('\n');
        if (key !== this._appKey) {
            this._appKey = key;
            this._apps.removeAll();
            for (const {app} of heavy)
                this._apps.addMenuItem(new AppItem(app));
        }
        const any = heavy.length > 0;
        this._appsHeader.visible = any;
        this._apps.actor.visible = any;
        this._noApps.visible = !any;
    }

    destroy() {
        this._energy.destroy();
        this._power.disconnectObject(this);
        this._bindings.forEach(b => b.unbind());
        this._bindings = [];
        // Devolve o ícone ao menu de status do GNOME ANTES de destruir o
        // botão (senão ele seria destruído junto, como filho).
        this._battery.setTooltipEnabled(true);
        this._battery.setContainer(null);
        super.destroy();
    }
});
