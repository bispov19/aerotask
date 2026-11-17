// SPDX-License-Identifier: GPL-3.0-or-later
// Ícones pequenos ao lado dos itens dos menus, como nos menus do macOS.
//
// Os menus dizem só o NOME do ícone (o campo "iconName" do nó; ver
// lib/popup.js). Aqui o nome vira um Gio.Icon:
//
//   1. o ícone próprio da extensão, icons/menu/<nome>-symbolic.svg, se
//      existir: um conjunto desenhado como UMA família (contorno de 1,5 px,
//      pontas redondas), gerado por scripts/make-menu-icons.py. Os do tema
//      (o Vitral herda os simbólicos do Adwaita) têm traço de ~2 px e vários
//      são preenchidos (impressora, emoji, lupa com +, ajuda, teclado):
//      lado a lado com o estilo dos menus, destoariam;
//   2. senão, o ícone simbólico do tema de ícones, se o tema tiver;
//   3. senão, nenhum (o item fica só com o espaço reservado, se o grupo dele
//      tiver ícones).
//
// Todos são "-symbolic": o St os pinta com a cor do texto do item — escuro
// no tema claro, claro no escuro, cinza no item desabilitado — sem precisar
// de duas versões.

import Gio from 'gi://Gio';
import St from 'gi://St';

/** icons/menu/ da extensão (este arquivo está em lib/). */
const OWN_DIR = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('icons').get_child('menu');

/** Nome → Gio.Icon (ou null): cada nome é resolvido uma vez só. */
const cache = new Map();
let theme = null;

/**
 * @param {string|null|undefined} name - ex.: 'copy' (próprio) ou 'edit-copy' (tema)
 * @returns {Gio.Icon|null}
 */
export function menuIcon(name) {
    if (!name)
        return null;
    if (cache.has(name))
        return cache.get(name);

    let icon = null;
    const own = OWN_DIR.get_child(`${name}-symbolic.svg`);
    if (own.query_exists(null)) {
        icon = new Gio.FileIcon({file: own});
    } else {
        const themed = name.endsWith('-symbolic') ? name : `${name}-symbolic`;
        theme ??= new St.IconTheme();
        if (theme.lookup_icon(themed, 16, 0))
            icon = new Gio.ThemedIcon({name: themed});
    }
    cache.set(name, icon);
    return icon;
}

/** Esquece o cache (o tema de ícones pode mudar entre ativações). */
export function clearMenuIcons() {
    cache.clear();
    theme = null;
}

/**
 * Ícone de cada comando dos menus padrão (Arquivo, Editar, Visualizar,
 * Janela, Ajuda). Sem ícone: comandos que o macOS também deixa sem
 * ("Fechar Todas", "Colar sem Formatação"…).
 */
export const COMMAND_ICONS = {
    newWindow: 'window-new',
    newTab: 'tab-new',
    open: 'open',
    save: 'save',
    saveAs: 'save-as',
    print: 'print',
    undo: 'undo',
    redo: 'redo',
    cut: 'cut',
    copy: 'copy',
    paste: 'paste',
    delete: 'delete',
    selectAll: 'select-all',
    find: 'find',
    emoji: 'emoji',
    sidebar: 'sidebar',
    zoomIn: 'zoom-in',
    zoomOut: 'zoom-out',
    zoomReset: 'zoom-reset',
    fullscreen: 'fullscreen',
    help: 'help',
    shortcuts: 'keyboard',
};
