// SPDX-License-Identifier: GPL-3.0-or-later
// "Estilo da barra" (chave panel-style), com três opções:
//
//   gnome  Padrão GNOME: o AeroTask não pinta nada. O tema e o Blur my Shell
//          (se estiver ligado) desenham a barra como sempre.
//   black  Preto absoluto: fundo #000 opaco.
//   glass  Vidro: papel de parede desfocado pelo PRÓPRIO AeroTask, com o
//          mesmo material de vidro da Orla Dock (lib/glass.js): sem camada
//          escura, cores vivas, reflexo e uma linha clara embaixo.
//
// Nos modos black e glass o visual é "absoluto": o Blur my Shell não pode
// somar o desfoque dele nem trocar o fundo. Sem mexer nas configurações
// dele (as chaves do schema dele ficam intactas), o BmsGuard abaixo
// neutraliza o que ele põe na barra e desfaz de novo se ele reaplicar:
//
//   1. o desfoque dele é um ator "bms-panel-backgroundgroup" dentro do
//      panelBox: escondemos o GRUPO (ele só mostra/esconde o filho de dentro,
//      então não há "briga" de visibilidade);
//   2. o fundo dele vem de classes CSS na barra (transparent-panel,
//      dark-panel…) e a cor do texto de classes no panelBox
//      (panel-light-text): tiramos as classes e, se ele as puser de novo,
//      tiramos outra vez (notify::style-class);
//   3. o nosso fundo é estilo EM LINHA (Main.panel.style): em linha vence
//      qualquer classe do tema ou do Blur my Shell.
//
// Ao voltar para "gnome" (ou desligar a extensão), tudo é devolvido: o grupo
// do Blur my Shell aparece de novo e as classes dele voltam.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    addPanelDeclaration, hasPanelDeclaration, removePanelDeclaration,
    unwatchPanelStyle, watchPanelStyle,
} from './panelStyle.js';
// Os valores do vidro (raio, brilho, saturação, cor, borda…) ficam todos no
// topo de lib/glass.js.
import {GLASS_BORDER, GLASS_TINT, GlassEffect} from './glass.js';

// ----- Blur my Shell -------------------------------------------------------------

const BMS_GROUP_NAME = 'bms-panel-backgroundgroup';
/** Classes de fundo que o Blur my Shell põe na barra (components/panel/panel_style.js). */
const BMS_PANEL_CLASSES = [
    'transparent-panel', 'light-panel', 'dark-panel', 'contrasted-panel',
    'gradient-panel', 'gradient-panel-reverse',
];
/** Classes de cor do texto que ele põe no panelBox. */
const BMS_BOX_CLASSES = ['panel-light-text', 'bms-panel-overview-light-theme'];

// Acham as nossas declarações (com ou sem ";": o Blur my Shell tira o ";"
// final do que não é dele ao reescrever o estilo).
const BACKGROUND_PATTERN = /background-color:\s*rgba\([^)]*\)\s*;?/g;
const BORDER_PATTERN = /box-shadow:\s*inset[^;]*;?/g;
/** Fundo da barra no Vidro: TRANSPARENTE (a cor vem do material do vidro). */
const GLASS_BACKGROUND = 'background-color: rgba(0, 0, 0, 0);';

/**
 * Enquanto existe, impede o Blur my Shell de desenhar na barra principal.
 * Não toca nas configurações dele: só esconde/tira o que ele pôs e devolve
 * tudo no destroy().
 */
class BmsGuard {
    constructor() {
        this._box = Main.layoutManager.panelBox;
        this._groups = new Set();
        // Classes que tiramos (para devolver no destroy).
        this._panelClasses = new Set();
        this._boxClasses = new Set();

        // O grupo do desfoque pode ser (re)criado depois: Blur my Shell
        // ativado mais tarde, monitores trocados…
        this._box.connectObject(
            'child-added', (_box, child) => this._adopt(child),
            'notify::style-class', () => this._strip(this._box, BMS_BOX_CLASSES, this._boxClasses),
            this);
        Main.panel.connectObject('notify::style-class',
            () => this._strip(Main.panel, BMS_PANEL_CLASSES, this._panelClasses), this);

        for (const child of this._box.get_children())
            this._adopt(child);
        this._strip(this._box, BMS_BOX_CLASSES, this._boxClasses);
        this._strip(Main.panel, BMS_PANEL_CLASSES, this._panelClasses);
    }

    _adopt(child) {
        if (child.name !== BMS_GROUP_NAME || this._groups.has(child))
            return;
        this._groups.add(child);
        child.hide();
        child.connectObject(
            'notify::visible', () => {
                if (child.visible)
                    child.hide();
            },
            'destroy', () => this._groups.delete(child),
            this);
    }

    /**
     * Tira as classes do Blur my Shell. Se ele trocou de classe (ex.: de
     * transparent para dark), guardamos só a mais recente: é a que ele quer.
     */
    _strip(actor, classes, removed) {
        const present = classes.filter(name => actor.has_style_class_name(name));
        if (!present.length)
            return;
        removed.clear();
        for (const name of present) {
            removed.add(name);
            actor.remove_style_class_name(name); // dispara notify de novo: sem efeito
        }
    }

    destroy() {
        this._box.disconnectObject(this);
        Main.panel.disconnectObject(this);
        for (const group of this._groups) {
            group.disconnectObject(this);
            group.show();
        }
        this._groups.clear();
        for (const name of this._panelClasses)
            Main.panel.add_style_class_name(name);
        for (const name of this._boxClasses)
            this._box.add_style_class_name(name);
    }
}

// ----- Desfoque do modo Vidro ------------------------------------------------------

/**
 * O vidro atrás da barra. Mesma montagem do vidro estático da Orla Dock:
 *
 *   painel de vidro (do tamanho da barra, recorta o que passa dele)
 *     └ papel de parede do monitor INTEIRO, posicionado de modo que o pedaço
 *       visível seja exatamente o que está atrás da barra
 *
 * O GlassEffect (lib/glass.js) desfoca o painel e aplica o material. Ele
 * fica no PAINEL (do tamanho da barra), e não no papel de parede: assim o
 * shader "enxerga" as bordas da barra (refração, reflexo de cima).
 *
 * Por que o papel de parede e não "o que está atrás" em tempo real? As
 * janelas nunca passam por trás da barra (a área dela é reservada), então o
 * que fica atrás é sempre o papel de parede; e o desfoque em tempo real
 * (modo BACKGROUND) não aceita o recorte da máscara da barra flutuante.
 */
class GlassBackground {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._box = Main.layoutManager.panelBox;
        this._later = 0;
        this._paintId = 0;

        // Contêiner de tamanho zero no começo do panelBox (atrás da barra):
        // não ocupa espaço no layout; o painel é posicionado à mão.
        this._root = new Clutter.Actor({name: 'aerotask-panel-glass', width: 0, height: 0});
        this._box.insert_child_at_index(this._root, 0);
        this._pane = null;
        this._wallpaper = null;
        this._bgManager = null;
        this._build();

        settings.connectObject(
            'changed::glass-blur-radius', () => this._syncEffect(),
            'changed::glass-opacity', () => this._syncEffect(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._build(), this);
        // A barra muda de lugar/tamanho (barra flutuante, escala, monitor).
        Main.panel.connectObject('notify::allocation', () => this._queuePlace(), this);
        this._box.connectObject('notify::allocation', () => this._queuePlace(), this);
    }

    _build() {
        this._destroyPane();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._monitor = monitor;
        // Escondido até ser posicionado (sem tamanho ainda, não há o que mostrar).
        this._pane = new St.Widget({clip_to_allocation: true, visible: false});
        this._effect = new GlassEffect(this._settings.get_int('glass-blur-radius'));
        this._pane.add_effect(this._effect);
        this._wallpaper = new St.Widget({width: monitor.width, height: monitor.height});
        this._bgManager = new Background.BackgroundManager({
            container: this._wallpaper,
            monitorIndex: monitor.index,
            controlPosition: false,
        });
        this._pane.add_child(this._wallpaper);
        this._root.add_child(this._pane);
        this._syncEffect();
        this._queuePlace();
    }

    _syncEffect() {
        if (!this._effect)
            return;
        // Em px, como na Orla Dock (sem multiplicar pela escala da tela), para
        // barra e dock ficarem com o mesmo desfoque.
        this._effect.radius = this._settings.get_int('glass-blur-radius');
        this._effect.tintOpacity = this._settings.get_int('glass-opacity') / 100;
    }

    /**
     * Posiciona no próximo quadro (ler a geometria agora forçaria o layout).
     * Se a barra ainda espera layout (acabamos de inserir um ator no
     * panelBox), espera o próximo quadro DESENHADO (after-paint: o layout já
     * terminou) e tenta de novo. O notify::allocation não serve: ele não vem
     * quando o tamanho final da barra não muda. Sem laço: só tenta de novo
     * quando um quadro de fato acontece.
     */
    _queuePlace() {
        if (this._later)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            if (!this._place())
                this._retryAfterPaint();
            return false;
        });
    }

    _retryAfterPaint() {
        if (this._paintId)
            return;
        this._paintId = global.stage.connect('after-paint', () => {
            global.stage.disconnect(this._paintId);
            this._paintId = 0;
            this._queuePlace();
        });
    }

    /** @returns {boolean} conseguiu posicionar (ou não há o que posicionar)? */
    _place() {
        // Criado antes de o monitor existir (ex.: logo no início da sessão):
        // monta agora, quando a barra já tem lugar na tela.
        if (!this._pane) {
            if (Main.layoutManager.primaryMonitor)
                this._build(); // ele mesmo agenda um novo posicionamento
            return true;
        }
        if (!Main.panel.has_allocation() || !this._box.has_allocation())
            return false;
        const [panelX, panelY] = Main.panel.get_position(); // dentro do panelBox
        const [width, height] = Main.panel.get_size();
        const [boxX, boxY] = this._box.get_position();
        const [parentX, parentY] = this._box.get_parent()?.get_position() ?? [0, 0];
        if (!width || !height)
            return false;
        // Onde a barra está, em coordenadas do monitor (= do papel de parede).
        const x = boxX + parentX - this._monitor.x + panelX;
        const y = boxY + parentY - this._monitor.y + panelY;
        this._pane.set_position(panelX, panelY);
        this._pane.set_size(width, height);
        this._wallpaper.set_position(-x, -y);
        this._pane.show();
        return true;
    }

    _destroyPane() {
        this._bgManager?.destroy();
        this._bgManager = null;
        this._pane?.destroy(); // leva junto o papel de parede (filho)
        this._pane = null;
        this._wallpaper = null;
        this._effect = null;
    }

    destroy() {
        if (this._later)
            global.compositor.get_laters().remove(this._later);
        this._later = 0;
        if (this._paintId)
            global.stage.disconnect(this._paintId);
        this._paintId = 0;
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._box.disconnectObject(this);
        this._destroyPane();
        this._root.destroy();
    }
}

// ----- O estilo em si ---------------------------------------------------------------

/**
 * A cor da barra, para as formas que saem dela (BarLook).
 *
 * @param {Gio.Settings} settings
 * @returns {number[]} [r, g, b (0–255), alfa (0–1)], ou null (gnome)
 */
export function panelTint(settings) {
    switch (settings.get_string('panel-style')) {
    case 'black':
        return [0, 0, 0, 1];
    case 'glass':
        return [...GLASS_TINT, settings.get_int('glass-opacity') / 100];
    default:
        return null;
    }
}

/**
 * As declarações em linha de cada estilo: [padrão que acha, declaração].
 *
 * @param {string} style
 * @returns {Array} pares [RegExp, string]
 */
function declarationsFor(style) {
    switch (style) {
    case 'black':
        return [[BACKGROUND_PATTERN, 'background-color: rgba(0, 0, 0, 1);']];
    case 'glass':
        // Transparente (nada de camada escura por cima do vidro) + a linha
        // clara embaixo. A sombra interna (inset) não muda o tamanho da
        // barra, ao contrário de uma borda (border) de 1 px.
        return [[BACKGROUND_PATTERN, GLASS_BACKGROUND], [BORDER_PATTERN, GLASS_BORDER]];
    default:
        return [];
    }
}

export class PanelLook {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._style = null; // estilo aplicado agora
        this._declarations = []; // nossas declarações no Main.panel.style
        this._guard = null;
        this._glass = null;

        settings.connectObject('changed::panel-style', () => this._sync(), this);
        // O GNOME apaga o estilo da barra no login e ao fechar a Visão Geral:
        // repomos as nossas declarações quando elas somem.
        watchPanelStyle(this, () => {
            for (const [pattern, declaration] of this._declarations) {
                if (!hasPanelDeclaration(pattern))
                    addPanelDeclaration(pattern, declaration);
            }
        });
        this._sync();
    }

    _sync() {
        const style = this._settings.get_string('panel-style');
        const absolute = style === 'black' || style === 'glass';

        // Guarda do Blur my Shell: só nos modos "absolutos".
        if (absolute && !this._guard)
            this._guard = new BmsGuard();
        else if (!absolute && this._guard)
            this._destroyGuard();

        // Desfoque próprio: só no Vidro.
        if (style === 'glass' && !this._glass)
            this._glass = new GlassBackground(this._settings);
        else if (style !== 'glass' && this._glass)
            this._destroyGlass();

        // Classe que deixa texto e ícones brancos (legíveis no fundo escuro).
        for (const name of ['black', 'glass']) {
            if (name === style)
                Main.panel.add_style_class_name(`aerotask-panel-${name}`);
            else
                Main.panel.remove_style_class_name(`aerotask-panel-${name}`);
        }

        // Fundo (e borda) em linha: vence classes do tema e do Blur my Shell.
        if (style !== this._style) {
            this._removeDeclarations();
            this._declarations = declarationsFor(style);
            for (const [pattern, declaration] of this._declarations)
                addPanelDeclaration(pattern, declaration);
        }
        this._style = style;
    }

    /** Tira SÓ as nossas declarações; o resto do estilo fica como estava. */
    _removeDeclarations() {
        // Esvazia ANTES de remover: a remoção dispara o vigia do estilo, que
        // poria as declarações de volta.
        const old = this._declarations;
        this._declarations = [];
        for (const [pattern] of old)
            removePanelDeclaration(pattern);
    }

    _destroyGuard() {
        this._guard.destroy();
        this._guard = null;
    }

    _destroyGlass() {
        this._glass.destroy();
        this._glass = null;
    }

    destroy() {
        this._settings.disconnectObject(this);
        unwatchPanelStyle(this);
        if (this._glass)
            this._destroyGlass();
        if (this._guard)
            this._destroyGuard();
        Main.panel.remove_style_class_name('aerotask-panel-black');
        Main.panel.remove_style_class_name('aerotask-panel-glass');
        this._removeDeclarations();
    }
}
