// SPDX-License-Identifier: GPL-3.0-or-later
//
// Espaçamento uniforme entre os ícones das Configurações Rápidas na barra.
//
// Por que existe: cada indicador do menu de status (`SystemIndicator`) é uma
// caixa com ícones `St.Icon` (classe `system-status-icon`). O tema dá a cada
// ícone uma margem (4 px de cada lado no tema padrão) e a caixa de fora soma
// o espaçamento entre indicadores. Um ícone VISÍVEL mas SEM IMAGEM (gicon
// nulo) tem largura 0, porém continua ocupando as margens e o espaçamento —
// vira um "buraco" de ~12 px entre dois ícones.
//
// Caso real: o gnome-mosaic cria o ícone dele vazio e só o esconde quando a
// organização em mosaico é ligada/desligada pela primeira vez. Até lá, sobra
// um espaço maior entre o ícone anterior e o Wi-Fi.
//
// O que fazemos: esconder qualquer ícone visível sem imagem e mostrá-lo de
// novo quando o dono der uma imagem a ele. O `SystemIndicator` do GNOME
// escuta o `notify::visible` dos ícones e esconde a caixa inteira quando
// nenhum fica visível, então o espaçamento da caixa também some.
// No destroy() devolvemos a visibilidade de tudo o que escondemos.

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class IndicatorSpacing {
    constructor() {
        /** Ícones que NÓS escondemos (só esses voltam a aparecer). */
        this._hidden = new Set();
        /** Atores que já estamos vigiando (evita conectar duas vezes). */
        this._watched = new Set();

        // `_indicators` é a caixa com os ícones do menu de status (privada
        // do Shell; existe no GNOME 51, conferido no panel.js extraído).
        this._box = Main.panel.statusArea.quickSettings?._indicators ?? null;
        if (!this._box)
            return;

        this._box.connectObject('child-added', (_box, child) => this._watchIndicator(child), this);
        for (const child of this._box.get_children())
            this._watchIndicator(child);
    }

    /** Um indicador (caixa) da barra: vigia os ícones dele, atuais e futuros. */
    _watchIndicator(indicator) {
        // Só as caixas de indicadores do GNOME/extensões (a nossa bateria e
        // outros atores soltos não têm essa classe).
        if (!indicator.has_style_class_name?.('panel-status-indicators-box'))
            return;
        if (this._watched.has(indicator)) {
            // Recolocada na barra (outra extensão reordenando): o Clutter a
            // mostra de novo ao ganhar pai (`show-on-set-parent`).
            this._checkIndicator(indicator);
            return;
        }
        this._watched.add(indicator);

        indicator.connectObject(
            'child-added', (_ind, child) => this._watchIcon(child),
            'notify::visible', () => this._checkIndicator(indicator),
            'destroy', () => this._watched.delete(indicator),
            this);
        for (const child of indicator.get_children())
            this._watchIcon(child);
        this._checkIndicator(indicator);
    }

    /**
     * A caixa só fica visível se tiver algum ícone visível — a mesma regra do
     * `SystemIndicator._syncIndicatorsVisible()` do GNOME. Precisamos repeti-la
     * porque a caixa pode ser mostrada de novo SEM passar por essa função
     * (visto no login: o ícone vazio continuava escondido, mas a caixa voltava
     * a aparecer e o espaçamento dela sobrava). Só agimos em caixas onde NÓS
     * escondemos algum ícone; as outras seguem as regras do dono.
     */
    _checkIndicator(indicator) {
        if (!indicator.visible)
            return;
        const children = indicator.get_children();
        if (children.some(c => this._hidden.has(c)) && !children.some(c => c.visible))
            indicator.visible = false;
    }

    _watchIcon(icon) {
        if (this._watched.has(icon) || !(icon instanceof St.Icon))
            return;
        this._watched.add(icon);

        icon.connectObject(
            'notify::gicon', () => this._check(icon),
            'notify::icon-name', () => this._check(icon),
            'notify::visible', () => this._check(icon),
            'destroy', () => {
                this._watched.delete(icon);
                this._hidden.delete(icon);
            },
            this);
        this._check(icon);
    }

    /** Visível e vazio → esconde; escondido por nós e com imagem → mostra. */
    _check(icon) {
        const empty = !icon.gicon && !icon.icon_name;
        if (empty && icon.visible) {
            this._hidden.add(icon);
            icon.visible = false; // dispara notify::visible → _check de novo (sem efeito)
            const indicator = icon.get_parent();
            if (indicator)
                this._checkIndicator(indicator);
        } else if (!empty && this._hidden.has(icon)) {
            this._hidden.delete(icon);
            icon.visible = true; // o SystemIndicator do dono mostra a caixa
        }
    }

    destroy() {
        for (const actor of this._watched)
            actor.disconnectObject(this);
        this._box?.disconnectObject(this);
        // Devolve como estava (o dono decide a partir daqui). Mostrar o ícone
        // faz o SystemIndicator do dono mostrar a caixa de novo.
        for (const icon of this._hidden)
            icon.visible = true;
        this._hidden.clear();
        this._watched.clear();
        this._box = null;
    }
}
