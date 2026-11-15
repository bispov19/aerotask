// SPDX-License-Identifier: GPL-3.0-or-later
// Declarações no estilo em linha da barra (Main.panel.style), que é
// DIVIDIDO: a barra preta (PanelLayout), a margem da barra flutuante
// (FloatingPanel) e o raio dos cantos do Blur my Shell escrevem nele.
//
// Regras para não estragar o que é dos outros:
//   - Remover só a nossa declaração (por padrão/regex: o Blur my Shell tira
//     o ";" do fim do que não é dele ao reescrever).
//   - NUNCA tirar o ";" final do resto: o Blur my Shell acha a regra dele
//     pelo texto exato ("border-radius: …;"); sem o ";" ele não a encontra e
//     a escreve de novo (duplicada).
//   - Ao acrescentar, garantir o ";" antes da nossa declaração: sem ele as
//     duas viram uma declaração inválida e o St ignora as duas.
//   - O PRÓPRIO GNOME troca o estilo inteiro (ui/overview.js): no login
//     ('transition-duration: 0ms;' e depois null) e toda vez que a Visão
//     Geral fecha (null). Quem tem uma declaração aqui precisa vigiar o
//     "notify::style" e pô-la de volta (watchPanelStyle).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * @param {RegExp} pattern - acha a nossa declaração (com flag g)
 * @returns {string} o estilo atual sem ela
 */
function styleWithout(pattern) {
    return (Main.panel.style ?? '').replace(pattern, '').replace(/\s+/g, ' ').trim();
}

function setStyle(style) {
    if (style !== Main.panel.style)
        Main.panel.style = style;
}

/**
 * Põe a declaração no fim do estilo (trocando a nossa anterior, se houver).
 *
 * @param {RegExp} pattern - acha a nossa declaração (com flag g)
 * @param {string} declaration - ex.: "margin: 6px 8px 0 8px;"
 */
export function addPanelDeclaration(pattern, declaration) {
    let rest = styleWithout(pattern);
    if (rest && !rest.endsWith(';'))
        rest += ';';
    setStyle(`${rest} ${declaration}`.trim());
}

/**
 * @param {RegExp} pattern - acha a nossa declaração
 * @returns {boolean} a declaração está no estilo agora?
 */
export function hasPanelDeclaration(pattern) {
    // search() ignora o lastIndex de regex com flag g (test() não ignora).
    return (Main.panel.style ?? '').search(pattern) >= 0;
}

/**
 * Chama `callback` sempre que o estilo da barra mudar (por nós, pelo Blur
 * my Shell ou pelo GNOME). O callback deve só repor a própria declaração se
 * ela sumiu: repor dispara o sinal de novo, mas aí ela já está lá e para.
 * Síncrono de propósito: adiar para o próximo quadro mostraria um quadro com
 * a barra sem a margem (um "pulo").
 *
 * @param {object} owner - dono da conexão (para disconnectObject)
 * @param {Function} callback - repõe a declaração, se for o caso
 */
export function watchPanelStyle(owner, callback) {
    Main.panel.connectObject('notify::style', callback, owner);
}

/** @param {object} owner - o mesmo passado a watchPanelStyle */
export function unwatchPanelStyle(owner) {
    Main.panel.disconnectObject(owner);
}

/**
 * Tira só a nossa declaração; o resto fica como estava.
 *
 * @param {RegExp} pattern - acha a nossa declaração (com flag g)
 */
export function removePanelDeclaration(pattern) {
    setStyle(styleWithout(pattern) || null);
}
