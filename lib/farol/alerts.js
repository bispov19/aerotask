// SPDX-License-Identifier: GPL-3.0-or-later
// Alertas que saem de baixo do relógio, no canto direito — no PADRÃO DO
// GNOME: o mesmo pop-up (PopupMenu + BoxPointer) do relógio e dos menus da
// barra, com a mesma animação, as mesmas margens e o desfoque do Blur my
// Shell. Mensagens — bateria, Caps Lock, Bluetooth, rede, foco, eventos:
//
//             🔋 Bateria fraca                         [Entrar] ×
//                Conecte o carregador
//
// (Os NÍVEIS — volume, brilho, luz do teclado — ficam no HUD do centro da
// tela, lib/osdHud.js, todos no mesmo padrão.)
//
// O pop-up do alerta abre SEM o gerenciador de menus do painel: assim ele não
// "prende" o teclado e o mouse (você continua digitando no app) e não fecha
// sozinho com um clique fora — some depois de alguns segundos.
//
// Regras:
//   - um de cada vez; mensagens novas esperam numa FILA;
//   - o mesmo alerta (mesma chave) não se repete em pouco tempo;
//   - Não Perturbe silencia tudo, menos alertas urgentes (bateria em 10%);
//   - com uma janela em tela cheia, mensagens esperam e aparecem depois;
//   - ponteiro em cima segura o alerta; × ou clique fecha.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AeroMenu} from '../popup.js';
import {T} from './strings.js';
import {TimeoutRegistry} from '../util.js';

/** Mensagens comuns ficam 4 s (o ponteiro em cima segura). */
const MESSAGE_DURATION = 4000;
/** O mesmo alerta não se repete dentro deste tempo (ms). */
const DEDUPE_WINDOW = 10000;

export class AlertPresenter {
    /**
     * @param {Gio.Settings} settings
     * @param {ClockButton} clock - o relógio: o pop-up sai de baixo dele
     * @param {object} appearance - a mesma aparência dos menus ({opacity, radius})
     * @param {Function} canShow - () => boolean: pop-up do relógio fechado etc.
     */
    constructor(settings, clock, appearance, canShow = () => true) {
        this._settings = settings;
        this._clock = clock;
        this._canShow = canShow;
        this._timers = new TimeoutRegistry();
        this._hideTimer = 0;
        this._current = null; // alerta na tela
        this._closing = false; // animação de fechar em andamento
        this._queue = [];
        this._recent = new Map(); // chave → quando apareceu (ms)
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        // O MESMO pop-up do relógio (alinhado pela direita, no canto da tela).
        // Sem a forma de vidro: só o padrão do GNOME.
        this._menu = new AeroMenu(clock, appearance, 1.0);
        this._menu.boxPointer.setSourceAlignment(1.0);
        this._menu.afterOpen = () => clock.alignToEdge(this._menu);
        this._menu.boxPointer.add_style_class_name('aero-alert-boxpointer');
        // O PopupMenu do GNOME liga Espaço/Enter/↓ no relógio para abrir ESTE
        // menu; quem abre pelo teclado é o pop-up do relógio, não o alerta.
        this._menu._onKeyPress = () => Clutter.EVENT_PROPAGATE;
        this._menu.connect('menu-closed', () => {
            this._closing = false;
            this._showNext();
        });
        this._buildContent();
        // Como o pop-up do relógio: filho do uiGroup, escondido até abrir.
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();

        // Saiu da tela cheia: mostra o que estava esperando.
        global.display.connectObject('in-fullscreen-changed', () => this._showNext(), this);
        // Banners de notificação do GNOME saem no MESMO canto. O MessageTray
        // só fica visível enquanto há um banner na tela: o alerta dá a vez a
        // ele e volta quando ele sai.
        Main.messageTray.connectObject('notify::visible', () => this._onBannerChanged(), this);
    }

    /** Há um banner de notificação do GNOME no canto agora? */
    get _bannerShowing() {
        return Main.messageTray.visible;
    }

    _onBannerChanged() {
        if (!this._bannerShowing) {
            this._showNext();
            return;
        }
        // Chegou um banner com um alerta aberto: a mensagem volta para a
        // frente da fila (reaparece depois).
        const current = this._current;
        if (!current)
            return;
        this._queue.unshift(current);
        this.dismiss();
    }

    // ----- Construção -------------------------------------------------------------

    _buildContent() {
        // Um item de menu do GNOME (mesmas margens e fonte dos outros pop-ups),
        // sem destaque ao passar o mouse.
        // O alerta é informação, não um item desabilitado. Um widget com
        // reactive:false fica ":insensitive" (o tema e o Blur my Shell o
        // pintam apagado) e o GNOME marca item sem ação como "inativo". Então:
        // reativo, mas sem ativar ao clicar e sem destaque ao passar o mouse.
        const item = new PopupMenu.PopupBaseMenuItem({
            style_class: 'aero-alert',
            reactive: true,
            can_focus: false,
            activate: false,
            hover: false,
        });
        item.track_hover = false;
        item.remove_style_class_name('popup-inactive-menu-item');
        this._menu.addMenuItem(item);

        // A linha inteira recebe o mouse (para "segurar" e clicar).
        this._row = new St.BoxLayout({
            style_class: 'aero-alert-row',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._row.connect('notify::hover', () => {
            if (this._row.hover)
                this._timers.remove(this._hideTimer);
            else if (this._current)
                this._scheduleHide();
        });
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => {
            const alert = this._current;
            if (!alert)
                return;
            alert.onActivate?.();
            this.dismiss();
        });
        this._row.add_action(click);
        item.add_child(this._row);

        this._icon = new St.Icon({
            style_class: 'aero-alert-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._row.add_child(this._icon);

        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aero-alert-text',
        });
        this._row.add_child(column);
        this._title = new St.Label({style_class: 'aero-alert-title'});
        this._subtitle = new St.Label({style_class: 'aero-alert-subtitle'});
        column.add_child(this._title);
        column.add_child(this._subtitle);

        // Botão do tema do GNOME (o mesmo das notificações e diálogos).
        this._action = new St.Button({
            style_class: 'button aero-alert-action',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._action.connect('clicked', () => {
            this._current?.onAction?.();
            this.dismiss();
        });
        this._row.add_child(this._action);

        this._close = new St.Button({
            style_class: 'aero-alert-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: T.close,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._close.connect('clicked', () => this.dismiss());
        this._row.add_child(this._close);
    }

    /** Mesma opacidade/arredondamento dos menus (preferências ao vivo). */
    setAppearance(appearance) {
        this._menu.setAppearance(appearance);
    }

    // ----- Mensagens ----------------------------------------------------------------

    /**
     * Enfileira uma mensagem.
     *
     * @param {object} m
     * @param {string} m.key - mesma chave = mesmo alerta (não repete)
     * @param {string} m.iconName
     * @param {string} m.title
     * @param {string} [m.subtitle]
     * @param {string} [m.actionLabel] - botão (ex.: "Entrar")
     * @param {Function} [m.onAction]
     * @param {Function} [m.onActivate] - clique no alerta
     * @param {number} [m.duration] - ms (0 = fica até fechar)
     * @param {boolean} [m.urgent] - aparece mesmo no Não Perturbe
     * @param {boolean} [m.dedupe] - false = pode repetir logo (Caps Lock)
     */
    showMessage(m) {
        const now = Date.now();
        if (m.dedupe !== false && now - (this._recent.get(m.key) ?? -Infinity) < DEDUPE_WINDOW)
            return;
        if (this._current?.key === m.key || this._queue.some(q => q.key === m.key))
            return;
        // Não Perturbe: só o urgente passa.
        if (!m.urgent && !this._notifications.get_boolean('show-banners'))
            return;
        this._queue.push({kind: 'message', duration: MESSAGE_DURATION, ...m});
        this._showNext();
    }

    /** Tira da fila/tela os alertas com esta chave (ex.: a rede voltou). */
    withdraw(key) {
        this._queue = this._queue.filter(q => q.key !== key);
        if (this._current?.key === key)
            this.dismiss();
    }

    _showNext() {
        if (this._current || this._menu.isOpen || this._closing)
            return;
        if (this._queue.length === 0 || !this._canShow() || this._bannerShowing)
            return;
        // Tela cheia: espera (o "in-fullscreen-changed" chama de novo).
        if (Main.layoutManager.primaryMonitor?.inFullscreen)
            return;
        const m = this._queue.shift();
        this._current = m;
        this._recent.set(m.key, Date.now());

        this._icon.icon_name = m.iconName;
        this._title.text = m.title;
        this._subtitle.text = m.subtitle ?? '';
        this._subtitle.visible = Boolean(m.subtitle);
        this._action.visible = Boolean(m.actionLabel);
        this._action.label = m.actionLabel ?? '';

        this._open();
        this._scheduleHide(m.duration);
    }

    _open() {
        if (this._menu.isOpen)
            return;
        // Abrir no meio da animação de FECHAR interrompe essa animação, e o
        // "menu-closed" dela nunca chega: sem isto a fila travaria.
        this._closing = false;
        if (!this._menu.open())
            this._current = null; // relógio ainda sem posição: desiste
    }

    _scheduleHide(duration = this._current?.duration ?? MESSAGE_DURATION) {
        this._timers.remove(this._hideTimer);
        this._hideTimer = 0;
        this._pendingDuration = duration;
        if (this._row.hover || !duration)
            return;
        this._hideTimer = this._timers.add(duration, () => {
            this._hideTimer = 0;
            this.dismiss();
        });
    }

    /** Fecha o alerta da tela (o próximo da fila vem depois). */
    dismiss() {
        this._timers.remove(this._hideTimer);
        this._hideTimer = 0;
        this._current = null;
        if (this._menu.isOpen) {
            this._closing = true;
            this._menu.close(); // "menu-closed" (fim da animação) chama _showNext
        } else {
            this._showNext();
        }
    }

    /** Algo que impedia os alertas mudou (ex.: o pop-up fechou): tenta de novo. */
    flush() {
        this._showNext();
    }

    get isShowing() {
        return this._menu.isOpen;
    }

    destroy() {
        this._timers.clear();
        this._queue = [];
        this._current = null;
        global.display.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        // destroy() fecha sem animação e tira o pop-up do uiGroup.
        this._menu.destroy();
    }
}
