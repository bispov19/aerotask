// SPDX-License-Identifier: GPL-3.0-or-later
// Monta as imagens de divulgação no formato da página de uma extensão:
// ícone, título, autor e resumo no topo; a captura de tela; a legenda e uma
// descrição embaixo.
//
// Uso (na raiz do projeto):
//   gjs -m scripts/store-images.js
// Lê assets/icon-512.png, assets/screenshots/captions.json e as capturas de
// assets/screenshots/raw/ (tiradas com scripts/store-session.sh); grava as
// imagens prontas em assets/screenshots/.

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

const WIDTH = 1600;
const MARGIN = 120;
const SHOT_WIDTH = WIDTH - 2 * MARGIN;
const FONT = 'Inter';
const TITLE = 'AeroTask';
const AUTHOR = 'Web Developer';
const TAGLINE = 'A glassy top bar for GNOME with global app menus, a clock panel, ' +
    'a tile-style control center and a clean tray.';

const COLORS = {
    page: [0.965, 0.961, 0.957],
    text: [0.13, 0.13, 0.14],
    dim: [0.40, 0.40, 0.43],
    accent: [0.10, 0.45, 0.85],
};

const dir = GLib.get_current_dir();
const path = (...parts) => GLib.build_filenamev([dir, ...parts]);

function setColor(cr, [r, g, b], a = 1) {
    cr.setSourceRGBA(r, g, b, a);
}

/** Texto com quebra de linha; devolve a altura usada (px). */
function text(cr, str, {x, y, width = SHOT_WIDTH, size, weight = 400, color = COLORS.text}) {
    const layout = PangoCairo.create_layout(cr);
    const font = Pango.FontDescription.from_string(FONT);
    font.set_absolute_size(size * Pango.SCALE);
    font.set_weight(weight);
    layout.set_font_description(font);
    layout.set_width(width * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD);
    layout.set_text(str, -1);
    setColor(cr, color);
    cr.moveTo(x, y);
    PangoCairo.show_layout(cr, layout);
    return layout.get_pixel_size()[1];
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function drawImage(cr, surface, x, y, w, h, radius) {
    cr.save();
    roundedRect(cr, x, y, w, h, radius);
    cr.clip();
    cr.translate(x, y);
    cr.scale(w / surface.getWidth(), h / surface.getHeight());
    cr.setSourceSurface(surface, 0, 0);
    cr.paint();
    cr.restore();
}

function compose({file, caption, description}, index, total) {
    const shot = Cairo.ImageSurface.createFromPNG(path('assets', 'screenshots', 'raw', file));
    const icon = Cairo.ImageSurface.createFromPNG(path('assets', 'icon-512.png'));
    const shotHeight = Math.round(SHOT_WIDTH * shot.getHeight() / shot.getWidth());
    const height = 260 + shotHeight + 220;

    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, WIDTH, height);
    const cr = new Cairo.Context(surface);
    setColor(cr, COLORS.page);
    cr.paint();

    // Cabeçalho: ícone, título, autor e resumo.
    drawImage(cr, icon, MARGIN, 70, 128, 128, 0);
    const left = MARGIN + 128 + 36;
    text(cr, TITLE, {x: left, y: 66, size: 46, weight: 800});
    text(cr, AUTHOR, {x: left, y: 126, size: 22, weight: 500, color: COLORS.accent});
    text(cr, TAGLINE, {x: left, y: 160, width: WIDTH - left - MARGIN, size: 21, color: COLORS.dim});

    // Captura, com sombra suave.
    const top = 260;
    for (let i = 6; i > 0; i--) {
        cr.save();
        roundedRect(cr, MARGIN - i, top - i + 6, SHOT_WIDTH + 2 * i, shotHeight + 2 * i, 18 + i);
        cr.setSourceRGBA(0, 0, 0, 0.025);
        cr.fill();
        cr.restore();
    }
    drawImage(cr, shot, MARGIN, top, SHOT_WIDTH, shotHeight, 18);

    // Legenda + descrição + posição (1 / 3).
    const below = top + shotHeight + 44;
    text(cr, caption, {x: MARGIN, y: below, size: 32, weight: 700});
    text(cr, `${index + 1} / ${total}`, {x: WIDTH - MARGIN - 80, y: below + 6, width: 80,
        size: 22, weight: 500, color: COLORS.dim});
    text(cr, description, {x: MARGIN, y: below + 52, size: 22, color: COLORS.dim});

    const out = path('assets', 'screenshots', file);
    surface.writeToPNG(out);
    print(`ok: ${out}`);
}

const [, bytes] = GLib.file_get_contents(path('assets', 'screenshots', 'captions.json'));
const captions = JSON.parse(new TextDecoder().decode(bytes));
captions.forEach((c, i) => compose(c, i, captions.length));
