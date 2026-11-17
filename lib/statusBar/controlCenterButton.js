// SPDX-License-Identifier: GPL-3.0-or-later
// Botão do centro de controle (o ícone de dois interruptores do macOS), ao
// lado do relógio. Abre o MESMO menu de Configurações Rápidas do GNOME — com
// o layout do centro de controle quando essa opção está ligada.
//
// Como o menu passa a "sair" deste botão: o PopupMenu do GNOME posiciona o
// balão a partir de `menu.sourceActor` (BoxPointer.setPosition em
// PopupMenu.open) e o gerenciador de menus da barra usa o mesmo
// `sourceActor` para trocar de menu ao passar o mouse (`_findMenuForSource`).
// Apontando o `sourceActor` para este botão, as duas coisas funcionam aqui.
// No destroy() devolvemos o botão original.
//
// O menu continua registrado no gerenciador de menus da barra (grab,
// Esc, clique fora, troca com os outros menus): é o do GNOME.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {STATUS_BUTTON_CLASS} from './common.js';

export const ControlCenterButton = GObject.registerClass(
class AeroTaskControlCenterButton extends PanelMenu.Button {
    /**
     * @param {object} quickSettings - Main.panel.statusArea.quickSettings
     * @param {Gio.File} iconsDir - pasta icons/ da extensão
     */
    _init(quickSettings, iconsDir) {
        // true = sem menu próprio (o menu é o das Configurações Rápidas).
        super._init(0.5, _('Control Center'), true);
        this.add_style_class_name(STATUS_BUTTON_CLASS);
        this._quick = quickSettings;
        this._menu = quickSettings.menu;

        this.add_child(new St.Icon({
            style_class: 'system-status-icon',
            gicon: new Gio.FileIcon({
                file: iconsDir.get_child('control-center-symbolic.svg'),
            }),
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // Botão sem menu: o PanelMenu.Button desliga o gesto de clique dele.
        // Abrimos no APERTAR (como os outros botões da barra), não no soltar.
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => this._menu.toggle());
        this.add_action(click);

        // Teclado (barra focada com F10, setas até aqui): Enter/Espaço abrem.
        this.can_focus = true;
        this.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter ||
                key === Clutter.KEY_space || key === Clutter.KEY_Down) {
                this._menu.open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // O menu passa a sair deste botão (veja o topo do arquivo).
        this._originalSource = this._menu.sourceActor;
        this._originalFocus = this._menu.focusActor;
        this._menu.sourceActor = this;
        this._menu.focusActor = this;

        // Aceso enquanto o centro de controle está aberto. O PanelMenu.Button
        // do GNOME acende o botão DELE (classe :active) — e este handler
        // roda depois do dele, então apagamos lá e acendemos aqui.
        this._menu.connectObject('open-state-changed', (_m, open) => this._syncActive(open), this);
        this._syncActive(this._menu.isOpen);
    }

    _syncActive(open) {
        this._quick.remove_style_pseudo_class('active');
        if (open)
            this.add_style_pseudo_class('active');
        else
            this.remove_style_pseudo_class('active');
    }

    destroy() {
        this._menu.disconnectObject(this);
        // Fecha antes de devolver: o balão aberto está preso a este botão.
        if (this._menu.isOpen)
            this._menu.close({animate: false});
        if (this._menu.sourceActor === this) {
            this._menu.sourceActor = this._originalSource;
            this._menu.focusActor = this._originalFocus;
        }
        super.destroy();
    }
});
