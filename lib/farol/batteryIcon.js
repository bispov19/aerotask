// SPDX-License-Identifier: GPL-3.0-or-later
// Ícone de bateria no estilo do MacBook, na barra de status do GNOME.
//
// Desenhado do zero com Cairo (nenhum arquivo ou símbolo da Apple):
//
//    ╭──────────────╮
//    │▇▇▇▇ 90 ▇▇▇▇░░│▌   ← corpo maciço: a parte cheia na cor do texto, a
//    ╰──────────────╯       vazia apagada; a PORCENTAGEM vai dentro, "vazada"
//                            (recortada: aparece a cor da barra por trás);
//                            "tampa" (terminal) à direita, mais apagada
//
// Monocromático, como os outros ícones da barra (pedido do usuário): tudo usa
// a cor do texto da barra (tema claro ou escuro). Na tomada, um raio vazado
// ao lado do número (ou no meio, sem número).
//
// Por que "vazar" o número em vez de pintá-lo de preto? Assim ele fica com a
// cor da barra que estiver atrás (preta, fumê com desfoque ou a do tema) —
// sempre combina, sem escolher uma cor.
//
// O ícone original do GNOME (dentro do menu de status) é escondido enquanto
// o nosso está ativo e volta no destroy().
//
// Onde o ícone fica: por padrão, DENTRO do botão do menu de status do GNOME
// (ao lado do ícone original, escondido). No layout do macOS, o botão da
// bateria (lib/statusBar/batteryButton.js) o "adota" com setContainer(): o
// mesmo ator passa para o botão dele, que tem o pop-up da bateria.
//
// FIXO na barra: o ícone entra assim que o indicador de energia do GNOME
// existe e fica visível o tempo todo — se o UPower ainda não respondeu (no
// login), aparece num estado neutro (só o contorno) e se atualiza quando os
// dados chegam. Só some num computador SEM bateria: o UPower diz que não há
// bateria E o chassi (systemd-hostnamed) não é portátil.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PowerService} from './services/power.js';
import {formatBatteryStatus, T} from './strings.js';
import {TimeoutRegistry, getDBusProperty} from '../util.js';

/** Chassis do systemd-hostnamed que têm bateria. */
const PORTABLE_CHASSIS = ['laptop', 'convertible', 'tablet', 'handset', 'watch'];

/** Mudanças de carga deslizam (ms). Nada roda parado. */
const TRANSITION_TIME = 250;
/** A dica aparece depois de o ponteiro parar sobre o ícone (ms). */
const TOOLTIP_DELAY = 400;
/** Opacidade da parte vazia do corpo e da tampa. */
const EMPTY_ALPHA = 0.38;
/** Altura do número em relação à altura do corpo. */
const TEXT_HEIGHT = 0.78;
/** Largura do raio em relação à altura dele. */
const BOLT_RATIO = 0.62;

const BatteryDrawing = GObject.registerClass(
class AeroTaskBatteryDrawing extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'aerotask-battery-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Valores desenhados agora (animados) e os de destino.
        this._shown = {fill: 0, color: null};
        this._from = {fill: 0, color: null};
        this._to = {fill: 0, color: null, bolt: false};
        this._timeline = new Clutter.Timeline({actor: this, duration: TRANSITION_TIME});
        this._timeline.connect('new-frame', () => {
            const t = this._timeline.get_progress();
            this._shown.fill = this._from.fill + (this._to.fill - this._from.fill) * t;
            this._shown.color = mix(this._from.color, this._to.color, t);
            this.queue_repaint();
        });
        this.connect('destroy', () => this._timeline.stop());
    }

    /**
     * @param {number} fill - 0 a 1
     * @param {number[]|null} color - RGB, ou null = cor do texto da barra
     * @param {boolean} bolt - desenhar o raio (carregando/na tomada)
     * @param {string|null} [text] - o número dentro da bateria ("90"), ou null
     */
    setState(fill, color, bolt, text = null) {
        const firstTime = this._to.color === null && this._shown.fill === 0;
        this._from = {fill: this._shown.fill, color: this._shown.color ?? color};
        this._to = {fill, color, bolt};
        this._text = text;
        // Nada mudou na carga nem na cor: só redesenha (número, raio).
        const same = fill === this._shown.fill && color === this._shown.color;
        if (firstTime || same || !St.Settings.get().enable_animations) {
            this._timeline.stop();
            this._shown = {fill, color};
            this.queue_repaint();
            return;
        }
        this._timeline.stop();
        this._timeline.start();
    }

    /**
     * Pula para o fim da animação. Chamado antes de trocar o ícone de lugar:
     * uma Timeline rodando num ator fora do palco gera aviso do Clutter.
     */
    finishTransition() {
        if (!this._timeline.is_playing())
            return;
        this._timeline.stop();
        this._shown = {fill: this._to.fill, color: this._to.color};
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = this.get_theme_node().get_foreground_color();
        const text = [fg.red, fg.green, fg.blue];
        const c = (this._shown.color ?? text).map(v => v / 255);

        // Proporção ~2:1. A tampa ocupa um pedacinho à direita.
        const capW = Math.max(1.5, w * 0.06);
        const bodyW = w - capW - 1;
        const bodyH = h;
        const radius = bodyH * 0.3;

        // Tampa (terminal), apagada como a parte vazia.
        const capH = bodyH * 0.38;
        roundedRect(cr, bodyW + 1, (bodyH - capH) / 2, capW, capH, capW / 2);
        cr.setSourceRGBA(c[0], c[1], c[2], EMPTY_ALPHA);
        cr.fill();

        // Corpo: tudo apagado, e a parte cheia por cima (recortada pela forma
        // do corpo, então a ponta da carga acompanha os cantos arredondados).
        cr.save();
        roundedRect(cr, 0, 0, bodyW, bodyH, radius);
        cr.clip();
        cr.setSourceRGBA(c[0], c[1], c[2], EMPTY_ALPHA);
        cr.paint();
        const fillW = bodyW * this._shown.fill;
        if (fillW > 0) {
            cr.rectangle(0, 0, fillW, bodyH);
            cr.setSourceRGBA(c[0], c[1], c[2], 1);
            cr.fill();
        }

        // Número e raio VAZADOS (CLEAR = transparente: aparece a barra).
        cr.setOperator(Cairo.Operator.CLEAR);
        // Folga nas pontas; se "100" + raio não cabe, tudo encolhe junto.
        const room = bodyW - 2 * bodyH * 0.16;
        let scale = 1;
        let layout = null, textW = 0, textH = 0, boltH = 0, boltW = 0, between = 0;
        for (let tries = 0; tries < 2; tries++) {
            layout = this._text ? this._textLayout(cr, bodyH * scale) : null;
            [textW, textH] = layout ? layout.get_pixel_size() : [0, 0];
            boltH = bodyH * (layout ? 0.66 : 0.8) * scale;
            boltW = this._to.bolt ? boltH * BOLT_RATIO : 0;
            between = layout && this._to.bolt ? bodyH * 0.04 : 0;
            const needed = textW + between + boltW;
            if (needed <= room)
                break;
            scale *= room / needed;
        }
        const x = (bodyW - textW - between - boltW) / 2;
        if (layout) {
            cr.moveTo(x, (bodyH - textH) / 2);
            PangoCairo.layout_path(cr, layout);
            cr.fill();
        }
        if (this._to.bolt)
            boltPath(cr, x + textW + between + boltW / 2, bodyH / 2, boltH);
        cr.fill();
        cr.restore();
        cr.$dispose();
    }

    /** Texto em negrito, na fonte do tema, com altura proporcional ao corpo. */
    _textLayout(cr, bodyH) {
        const layout = PangoCairo.create_layout(cr);
        const font = this.get_theme_node().get_font().copy();
        font.set_weight(Pango.Weight.BOLD);
        font.set_absolute_size(Math.round(bodyH * TEXT_HEIGHT * Pango.SCALE));
        layout.set_font_description(font);
        layout.set_text(this._text, -1);
        // Dígitos tabulares: "89" e "90" com a mesma largura.
        const attrs = new Pango.AttrList();
        attrs.insert(Pango.attr_font_features_new('tnum'));
        layout.set_attributes(attrs);
        return layout;
    }
});

/** Retângulo de cantos arredondados (caminho do Cairo). */
function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * Caminho de um raio centrado em (cx, cy), com a altura `size` (desenho
 * próprio, num quadrado 1×1). Quem chama decide como pintar.
 */
function boltPath(cr, cx, cy, size) {
    // Traço grosso o bastante para o raio aparecer mesmo pequeno, ao lado do número.
    const pts = [[0.62, 0], [0.04, 0.58], [0.44, 0.58], [0.36, 1], [0.96, 0.40], [0.56, 0.40], [0.66, 0]];
    const w = size * BOLT_RATIO;
    cr.newSubPath();
    pts.forEach(([px, py], i) => {
        const x = cx - w / 2 + px * w;
        const y = cy - size / 2 + py * size;
        if (i === 0)
            cr.moveTo(x, y);
        else
            cr.lineTo(x, y);
    });
    cr.closePath();
}

function mix(a, b, t) {
    if (!a || !b)
        return b ?? a;
    return a.map((v, i) => v + (b[i] - v) * t);
}

/**
 * O indicador completo: o ícone (com a porcentagem dentro, se ligada), no
 * lugar do ícone de bateria do GNOME, com uma dica ao passar o ponteiro.
 */
export class BatteryIndicator {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._system = null; // indicador de energia do GNOME (escondido)
        this._container = null; // botão que adotou o ícone (null = menu de status)
        this._tooltipEnabled = true;
        this._hiddenByUs = false;
        this._timers = new TimeoutRegistry();
        this._tooltipTimer = 0;
        this._originalSubtitle = undefined;
        this._portable = null; // chassi portátil? (null = ainda não sabemos)
        this._cancellable = new Gio.Cancellable();

        this.actor = new St.BoxLayout({
            style_class: 'aerotask-battery',
            reactive: true,
            track_hover: true,
        });
        this._drawing = new BatteryDrawing();
        this.actor.add_child(this._drawing);

        this._tooltip = new St.Label({style_class: 'aerotask-battery-tooltip', visible: false});
        Main.layoutManager.addTopChrome(this._tooltip);
        this.actor.connect('notify::hover', () => this._syncTooltip());

        this._power = new PowerService();
        this._power.connectObject('changed', () => this._sync(), this);
        settings.connectObject(
            'changed::battery-icon-enabled', () => this._sync(),
            'changed::battery-show-percentage', () => this._sync(),
            this);

        this._readChassis();
        this._attach();
    }

    /** Notebook/tablet ou desktop? (assíncrono; nunca trava o Shell) */
    async _readChassis() {
        const chassis = await getDBusProperty(Gio.BusType.SYSTEM,
            'org.freedesktop.hostname1', '/org/freedesktop/hostname1',
            'org.freedesktop.hostname1', 'Chassis', this._cancellable);
        if (this._cancellable.is_cancelled())
            return;
        // Sem resposta: na dúvida, tratamos como portátil (nunca some).
        this._portable = chassis ? PORTABLE_CHASSIS.includes(chassis) : true;
        this._sync();
    }

    /**
     * O menu de status do GNOME cria os indicadores de forma assíncrona: se o
     * de energia ainda não está NA BARRA, esperamos ele entrar.
     *
     * Causa do bug "o ícone some ao logar": no login o GNOME cria o
     * indicador (qs._system) e só algumas linhas depois o põe na barra; no
     * meio disso ele insere OUTROS indicadores, o "child-added" chegava, o
     * _system já existia mas ainda sem pai → erro ("box is null") e, como já
     * tínhamos desconectado o sinal, o ícone nunca mais entrava. Agora só
     * seguimos quando o _system tem pai, e o sinal continua até lá.
     */
    _attach() {
        const qs = Main.panel.statusArea.quickSettings;
        const system = qs?._system;
        const box = system?.get_parent();
        if (!box) {
            if (qs?._indicators && !this._waitingIndicators) {
                this._waitingIndicators = true;
                qs._indicators.connectObject('child-added', () => this._attach(), this);
            }
            return;
        }
        if (this._waitingIndicators) {
            this._waitingIndicators = false;
            qs._indicators.disconnectObject(this);
        }
        this._system = system;
        this._place();
        // Se o GNOME mostrar o ícone dele de novo, escondemos (só enquanto o
        // nosso estiver visível).
        system.connectObject('notify::visible', () => {
            if (system.visible && this.actor.visible) {
                system.hide();
                this._hiddenByUs = true;
            }
        }, this);
        this._sync();
    }

    /** O PowerService (o pop-up da bateria lê o mesmo estado). */
    get power() {
        return this._power;
    }

    /**
     * Põe o ícone dentro de outro botão da barra (o da bateria, com pop-up)
     * ou, com null, de volta no menu de status do GNOME.
     *
     * @param {Clutter.Actor|null} container
     */
    setContainer(container) {
        this._container = container;
        this._place();
    }

    /** Liga/desliga a dica (o pop-up aberto já mostra tudo). */
    setTooltipEnabled(enabled) {
        this._tooltipEnabled = enabled;
        this._syncTooltip();
    }

    _place() {
        if (!this._system)
            return; // ainda esperando o GNOME (_attach chama de novo)
        const target = this._container ?? this._system.get_parent();
        const parent = this.actor.get_parent();
        if (!target || parent === target)
            return;
        this._drawing.finishTransition();
        parent?.remove_child(this.actor);
        if (this._container)
            target.add_child(this.actor);
        else
            target.insert_child_above(this.actor, this._system);
    }

    _sync() {
        if (!this._system)
            return; // ainda fora da barra (_attach chama de novo)
        const state = this._power.state;
        const enabled = this._settings.get_boolean('battery-icon-enabled');
        // Desktop: o UPower JÁ respondeu que não há bateria e o chassi não é
        // portátil. Em qualquer dúvida, o ícone fica.
        const desktop = this._power.noBattery && this._portable === false;
        const show = enabled && !desktop;
        this.actor.visible = show;

        // Ícone do GNOME: escondido só quando o nosso aparece; volta senão.
        if (this._system) {
            if (show && this._system.visible) {
                this._system.hide();
                this._hiddenByUs = true;
            } else if (!show && this._hiddenByUs) {
                this._hiddenByUs = false;
                this._system.show();
            }
        }
        this._syncSubtitle(show ? state : null);
        if (!show)
            return;

        if (!state) {
            // Estado neutro (UPower ainda sem dados): só o contorno, sem
            // número; atualiza sozinho quando o UPower responder.
            this._drawing.setState(0, null, false);
            this.actor.accessible_name = T.battery;
            this._tooltip.text = T.battery;
            return;
        }

        const fraction = Math.max(0, Math.min(1, state.percentage / 100));
        // O número vai DENTRO da bateria, sem "%" (não caberia; como no iPhone).
        const number = this._settings.get_boolean('battery-show-percentage')
            ? String(Math.round(fraction * 100)) : null;
        // null = cor do texto da barra (monocromático).
        this._drawing.setState(fraction, null, state.pluggedIn, number);
        this.actor.accessible_name = `${T.battery}: ${formatBatteryStatus(state)}`;
        this._tooltip.text = formatBatteryStatus(state);
    }

    /** No menu de status do GNOME, o botão de energia ganha o mesmo texto. */
    _syncSubtitle(state) {
        const toggle = this._system?._systemItem?.powerToggle;
        if (!toggle || !('subtitle' in toggle))
            return;
        if (state) {
            if (this._originalSubtitle === undefined)
                this._originalSubtitle = toggle.subtitle;
            toggle.subtitle = formatBatteryStatus(state);
        } else if (this._originalSubtitle !== undefined) {
            toggle.subtitle = this._originalSubtitle;
            this._originalSubtitle = undefined;
        }
    }

    _syncTooltip() {
        this._timers.remove(this._tooltipTimer);
        this._tooltipTimer = 0;
        if (!this.actor.hover || !this._tooltipEnabled) {
            this._tooltip.hide();
            return;
        }
        this._tooltipTimer = this._timers.add(TOOLTIP_DELAY, () => {
            this._tooltipTimer = 0;
            const [x, y] = this.actor.get_transformed_position();
            const [w, h] = this.actor.get_transformed_size();
            this._tooltip.show();
            const [, tw] = this._tooltip.get_preferred_width(-1);
            const monitor = Main.layoutManager.primaryMonitor;
            const tx = Math.min(x + w / 2 - tw / 2, monitor.x + monitor.width - tw - 6);
            this._tooltip.set_position(Math.round(Math.max(monitor.x + 6, tx)), Math.round(y + h + 6));
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._timers.clear();
        this._settings.disconnectObject(this);
        this._power.disconnectObject(this);
        this._power.destroy();
        Main.panel.statusArea.quickSettings?._indicators?.disconnectObject(this);
        this._syncSubtitle(null);
        if (this._system) {
            this._system.disconnectObject(this);
            if (this._hiddenByUs)
                this._system.show();
        }
        this._hiddenByUs = false;
        Main.layoutManager.removeChrome(this._tooltip);
        this._tooltip.destroy();
        this.actor.destroy();
    }
}
