// SPDX-License-Identifier: GPL-3.0-or-later
// Layout do centro de controle no estilo do macOS.
//
//   ╭───────────────╮ ╭───────────────╮
//   │ ◉ Wi-Fi       │ │ ◉ Não perturbe │   ← bloco de conectividade à esquerda;
//   │ ◉ Bluetooth   │ ╰───────────────╯     à direita, Foco e telhas pequenas
//   │ ◉ Modo avião  │ ╭───────────────╮
//   ╰───────────────╯ │ ◉ Luz noturna │
//                     ╰───────────────╯
//   ╭───────╮ ╭───────╮                     ← demais botões em telhas (2 colunas)
//   ╭─────────────────────────────────╮
//   │ Tela   [☀ ▬▬▬▬▬▬▬▬▬▭▭▭▭▭]      │     ← blocos de controle deslizante
//   ╰─────────────────────────────────╯
//   │ Som    [🔊 ▬▬▬▬▬▭▭▭▭▭▭▭▭▭]     │
//   │ [capa] Música — Artista  ⏮ ⏯ ⏭ │     ← Tocando agora (MPRIS)
//   │ 🔋 78%        📷 ⚙ 🔒 ⏻         │     ← linha do sistema (do GNOME)
//
// Os botões CONTINUAM filhos diretos da grade do GNOME: só a posição muda.
// Por isso tudo que o GNOME faz com eles segue funcionando — submenus (a
// posição deles é presa ao botão, relativa à grade), addItem() de outras
// extensões, foco do teclado.
//
// É uma SUBCLASSE do layout do próprio GNOME (QuickSettingsLayout, interno
// do Shell; pegamos a classe pelo objeto em uso): herdamos o espaçamento do
// tema e a propriedade "column-span" que o GNOME usa ao adicionar botões.
//
// Submenu aberto: o GNOME desenha o submenu logo abaixo do botão, na largura
// toda; tudo que estiver abaixo dessa linha desce para abrir espaço.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/** Espaço interno dos blocos e entre os itens de um bloco (px lógicos). */
const BLOCK_PADDING = 8;
const BLOCK_SPACING = 2;

let LayoutClass = null;

/**
 * @param {Clutter.LayoutManager} original - o layout do GNOME em uso
 * @param {object} cc - o ControlCenter (roleOf, blocks)
 * @returns {Clutter.LayoutManager}
 */
export function createControlCenterLayout(original, cc) {
    // Registrar a mesma classe duas vezes dá erro: uma vez por sessão.
    LayoutClass ??= registerLayout(original.constructor);
    const layout = new LayoutClass(original._overlay, {
        n_columns: original.n_columns,
        row_spacing: original.row_spacing,
        column_spacing: original.column_spacing,
    });
    layout._cc = cc;
    return layout;
}

function registerLayout(Base) {
    return GObject.registerClass(
    class AeroMenuControlCenterLayout extends Base {
        _scale() {
            return St.ThemeContext.get_for_stage(global.stage).scale_factor;
        }

        _span(container, child) {
            return this.get_child_meta(container, child).column_span ?? 1;
        }

        /** Os filhos visíveis agrupados pelo papel no centro de controle. */
        _groups(container) {
            const groups = {
                conn: [], focus: [], tile: [], display: [], sound: [],
                media: [], wide: [], system: [],
            };
            for (const child of container) {
                if (!child.visible || child === this._overlay)
                    continue;
                let role = this._cc.roleOf(child);
                // Botões desconhecidos que pedem a largura toda.
                if (role === 'tile' && this._span(container, child) >= this.nColumns)
                    role = 'wide';
                groups[role]?.push(child);
            }
            return groups;
        }

        /**
         * Calcula a posição de cada filho para a largura dada.
         *
         * @returns {{entries: object[], blocks: object[], height: number}}
         */
        _plan(container, width) {
            const s = this._scale();
            const pad = BLOCK_PADDING * s;
            const inner = BLOCK_SPACING * s;
            const gap = this.column_spacing;
            const rowGap = this.row_spacing;
            const colW = Math.floor((width - gap) / 2);
            const g = this._groups(container);
            const {blocks: cc} = this._cc;

            const entries = []; // {actor, x, y, w, h, lane}
            const blocks = []; // {actor, members, title}
            const heightOf = (actor, w) => actor.get_preferred_height(w)[1];
            const place = (actor, x, y, w, lane) => {
                const e = {actor, x, y, w, h: heightOf(actor, w), lane};
                entries.push(e);
                return e;
            };
            let y = 0;

            // ----- Topo: conectividade (esquerda) + Foco e telhas (direita) -----
            const tiles = [...g.focus, ...g.tile];
            if (g.conn.length > 0) {
                const members = [];
                let ly = y + pad;
                for (const child of g.conn) {
                    const e = place(child, pad, ly, colW - 2 * pad, 'L');
                    members.push(e);
                    ly += e.h + inner;
                }
                const leftBottom = ly - inner + pad;
                blocks.push({actor: cc.conn, members, x: 0, w: colW});

                let ry = y;
                let first = true;
                while (tiles.length > 0) {
                    const h = heightOf(tiles[0], colW);
                    // Foco sempre; telhas enquanto couberem ao lado do bloco.
                    if (!first && ry + h > leftBottom + 1)
                        break;
                    place(tiles.shift(), colW + gap, ry, colW, 'R');
                    ry += h + rowGap;
                    first = false;
                }
                y = Math.max(leftBottom, ry - rowGap) + rowGap;
            }

            // ----- Demais botões: telhas em 2 colunas -----
            for (let i = 0; i < tiles.length; i += 2) {
                const row = tiles.slice(i, i + 2);
                const h = Math.max(...row.map(c => heightOf(c, colW)));
                row.forEach((child, j) => {
                    const e = place(child, j * (colW + gap), y, colW, j ? 'R' : 'L');
                    e.h = h;
                });
                y += h + rowGap;
            }

            // ----- Blocos de controle deslizante (Tela, Som) -----
            const sliderBlock = (items, block) => {
                if (items.length === 0)
                    return;
                const members = [];
                let by = y + pad;
                members.push(place(block.title, pad, by, width - 2 * pad, 'F'));
                by += members[0].h + inner;
                for (const child of items) {
                    const e = place(child, pad, by, width - 2 * pad, 'F');
                    members.push(e);
                    by += e.h + inner;
                }
                blocks.push({actor: block.bg, members, x: 0, w: width});
                y = by - inner + pad + rowGap;
            };
            sliderBlock(g.display, cc.display);
            sliderBlock(g.sound, cc.sound);

            // ----- Tocando agora, itens largos e a linha do sistema -----
            for (const child of [...g.media, ...g.wide, ...g.system]) {
                const e = place(child, 0, y, width, 'F');
                y += e.h + rowGap;
            }

            this._shiftForOpenMenu(entries, width);

            // Fundo de cada bloco: dos primeiros aos últimos itens dele.
            for (const b of blocks) {
                const top = Math.min(...b.members.map(e => e.y)) - pad;
                const bottom = Math.max(...b.members.map(e => e.y + e.h)) + pad;
                entries.push({actor: b.actor, x: b.x, y: top, w: b.w, h: bottom - top, lane: 'B'});
            }

            const height = entries.reduce((max, e) => Math.max(max, e.y + e.h), 0);
            return {entries, height};
        }

        /**
         * Com um submenu aberto, tudo que está abaixo do botão dele desce a
         * altura do submenu (por coluna, para nada ficar por baixo dele).
         */
        _shiftForOpenMenu(entries, width) {
            const open = entries.find(e => e.actor.menu?.actor?.visible);
            if (!open)
                return;
            const [, overlayH] = this._overlay.get_preferred_height(width);
            const line = open.y + open.h;
            const shift = {L: 0, R: 0};
            const sorted = [...entries].sort((a, b) => a.y - b.y);
            for (const e of sorted) {
                if (e === open)
                    continue;
                const lanes = e.lane === 'F' ? ['L', 'R'] : [e.lane];
                let newY = e.y + Math.max(...lanes.map(l => shift[l]));
                if (e.y + e.h > line + 0.5)
                    newY = Math.max(newY, (e.y >= line ? e.y : line) + overlayH);
                for (const l of lanes)
                    shift[l] = Math.max(shift[l], newY - e.y);
                e.y = newY;
            }
        }

        _naturalWidth(container) {
            const s = this._scale();
            const pad = BLOCK_PADDING * s;
            const g = this._groups(container);
            const nat = (actor, extra = 0) => actor.get_preferred_width(-1)[1] + extra;
            let col = 0;
            for (const child of [...g.focus, ...g.tile])
                col = Math.max(col, nat(child));
            for (const child of g.conn)
                col = Math.max(col, nat(child, 2 * pad));
            let full = 2 * col + this.column_spacing;
            for (const child of [...g.display, ...g.sound])
                full = Math.max(full, nat(child, 2 * pad));
            for (const child of [...g.media, ...g.wide, ...g.system])
                full = Math.max(full, nat(child));
            return full;
        }

        vfunc_get_preferred_width(container, _forHeight) {
            const width = this._naturalWidth(container);
            return [width, width];
        }

        vfunc_get_preferred_height(container, forWidth) {
            const width = forWidth >= 0 ? forWidth : this._naturalWidth(container);
            const {height} = this._plan(container, width);
            return [height, height];
        }

        vfunc_allocate(container, box) {
            const width = box.get_width();
            const {entries} = this._plan(container, width);
            const [, overlayH] = this._overlay.get_preferred_height(width);
            this._overlay.allocate_available_size(0, 0, width, overlayH);

            const rtl = container.text_direction === Clutter.TextDirection.RTL;
            const placed = new Set();
            const childBox = new Clutter.ActorBox();
            for (const e of entries) {
                const x = box.x1 + (rtl ? width - e.x - e.w : e.x);
                // Tamanho EXATO (o fundo de um bloco não tem tamanho natural).
                childBox.set_origin(Math.round(x), Math.round(box.y1 + e.y));
                childBox.set_size(Math.round(e.w), Math.round(e.h));
                e.actor.allocate(childBox);
                placed.add(e.actor);
            }
            // O que sobrou (fundo de bloco vazio, por exemplo) fica sem tamanho.
            childBox.set_origin(0, 0);
            childBox.set_size(0, 0);
            for (const child of container) {
                if (child !== this._overlay && !placed.has(child))
                    child.allocate(childBox);
            }
        }
    });
}
