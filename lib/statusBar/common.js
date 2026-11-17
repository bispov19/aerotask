// SPDX-License-Identifier: GPL-3.0-or-later
// Peças comuns dos botões de status da barra (Wi-Fi, Bluetooth, centro de
// controle).

import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AeroTaskMenu, MenuItem} from '../popup.js';

/** Classe que dá o MESMO espaçamento a todos os botões de ícone da barra. */
export const STATUS_BUTTON_CLASS = 'aerotask-status-button';

/**
 * Botão de ícone na barra com um pop-up do AeroTask (o mesmo visual dos
 * outros menus). A subclasse monta o conteúdo no construtor dela e o
 * atualiza em `_onMenuOpen()` a cada abertura.
 */
export const StatusMenuButton = GObject.registerClass(
class AeroTaskStatusMenuButton extends PanelMenu.Button {
    /**
     * @param {string} name - nome acessível (leitor de tela)
     * @param {() => object} getAppearance - aparência atual dos menus
     */
    _init(name, getAppearance) {
        super._init(0.5, name, true);
        this.add_style_class_name(STATUS_BUTTON_CLASS);
        this._getAppearance = getAppearance;

        // alinhamento 0,5: o balão fica centralizado no ícone, como no macOS.
        this.setMenu(new AeroTaskMenu(this, getAppearance(), 0.5));
        this.menu.box.add_style_class_name('aerotask-status-menu');
        this.menu.beforeOpen = () => {
            this.menu.setAppearance(this._getAppearance());
            this._onMenuOpen();
        };
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                this._onMenuClose();
        }, this);
    }

    _onMenuOpen() {}

    _onMenuClose() {}
});

/**
 * Item de texto dos pop-ups de status. Sem a coluna do ✓ dos outros menus
 * (aqui nada é marcável): o texto começa na mesma linha do "Wi-Fi" do título.
 *
 * @param {string} label
 * @param {boolean} [activatable] - false = texto informativo (título, aviso)
 */
export function plainItem(label, activatable = true) {
    const item = new MenuItem({label, activatable});
    item._check.visible = false;
    return item;
}

/** Separador fino, igual ao dos outros menus do AeroTask. */
export function separatorItem() {
    const sep = new PopupMenu.PopupSeparatorMenuItem();
    sep.add_style_class_name('aerotask-menu-separator');
    return sep;
}

/**
 * "Wi-Fi [interruptor]": a linha de título dos pop-ups. Diferente do
 * PopupSwitchMenuItem do GNOME, clicar NÃO fecha o menu (como no macOS: você
 * liga o Wi-Fi e já vê as redes aparecerem).
 */
export const SwitchHeaderItem = GObject.registerClass(
class AeroTaskStatusSwitchItem extends PopupMenu.PopupSwitchMenuItem {
    _init(text) {
        super._init(text, false);
        this.add_style_class_name('aerotask-menu-item');
        this.add_style_class_name('aerotask-status-switch');
    }

    activate(_event) {
        // Sem super.activate(): é ele que emite "activate" e fecha o menu.
        if (this._switch.mapped)
            this.toggle();
    }

    /** Muda o interruptor SEM emitir "toggled" para quem só quer exibir. */
    setStateQuietly(state) {
        this._quiet = true;
        this.setToggleState(state);
        this._quiet = false;
    }

    _onToggled() {
        if (!this._quiet) {
            super._onToggled();
            return;
        }
        this.notify('state');
        this._checkAccessibleState();
    }
});

/**
 * Mantém ESCONDIDO um ator do GNOME (ex.: o ícone de volume) enquanto
 * `shouldHide()` for verdadeiro, e devolve o controle ao dono depois.
 *
 * Por que não basta `actor.hide()`: o GNOME mostra o ícone de novo sempre
 * que o estado muda (ex.: outro dispositivo de som). Por isso vigiamos o
 * `notify::visible` e escondemos de novo. Ao soltar, não "chutamos" a
 * visibilidade: chamamos `restore()`, que pede ao próprio GNOME para
 * recalcular (ex.: `SystemIndicator._syncIndicatorsVisible()`).
 */
export class VisibilityGuard {
    /**
     * @param {Clutter.Actor} actor
     * @param {() => boolean} shouldHide
     * @param {() => void} restore
     * @param {string[]} [extraSignals] - outros sinais que mudam a decisão
     */
    constructor(actor, shouldHide, restore, extraSignals = []) {
        this._actor = actor;
        this._shouldHide = shouldHide;
        this._restore = restore;
        this._hidden = false;

        const args = ['notify::visible', () => this.check()];
        for (const signal of extraSignals)
            args.push(signal, () => this.check());
        actor.connectObject(...args, 'destroy', () => {
            this._actor = null;
        }, this);
        this.check();
    }

    check() {
        const actor = this._actor;
        if (!actor)
            return;
        if (this._shouldHide()) {
            if (actor.visible) {
                this._hidden = true;
                actor.visible = false; // dispara notify::visible → check (sem efeito)
            }
        } else if (this._hidden) {
            this._hidden = false;
            this._restore();
        }
    }

    destroy() {
        const actor = this._actor;
        this._actor = null;
        if (!actor)
            return;
        actor.disconnectObject(this);
        if (this._hidden)
            this._restore();
    }
}
