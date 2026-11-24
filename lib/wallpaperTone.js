// SPDX-License-Identifier: GPL-3.0-or-later
// O papel de parede é claro ou escuro ATRÁS DA BARRA?
//
// Usado no estilo Transparente: sem fundo nenhum, o texto fica direto sobre o
// papel de parede. Como no macOS, ele fica escuro sobre papel de parede claro
// e branco sobre papel de parede escuro.
//
// Como medimos: a imagem do papel de parede (o mesmo arquivo que o GNOME
// desenha, da chave picture-uri ou picture-uri-dark, conforme o tema) é
// carregada já REDUZIDA pelo GdkPixbuf, de forma assíncrona (o Shell nunca
// trava esperando o disco), e calculamos o brilho médio só da FAIXA DE CIMA,
// que é a parte que fica atrás da barra. Sem imagem (só cor), usamos a cor.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/** Largura da imagem reduzida (a altura acompanha a proporção). */
const SAMPLE_WIDTH = 128;
/** Faixa de cima analisada (fração da altura): a barra e um pouco abaixo. */
const TOP_STRIP = 0.08;
/** Acima deste brilho (0–1), o fundo é "claro" e o texto fica escuro. */
const LIGHT_THRESHOLD = 0.6;

/** Brilho percebido de uma cor (0–255 por canal) → 0–1 (pesos Rec. 709). */
const luminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

/** Brilho médio das linhas de cima de uma imagem já reduzida. */
function topLuminance(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const rows = Math.max(1, Math.ceil(pixbuf.get_height() * TOP_STRIP));
    let sum = 0, count = 0;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * channels;
            sum += luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
            count++;
        }
    }
    return count ? sum / count : 0;
}

export class WallpaperTone extends Signals.EventEmitter {
    constructor() {
        super();
        /** O fundo atrás da barra é claro? (padrão: escuro → texto branco) */
        this.light = false;
        this._cancellable = null;
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._background.connectObject('changed', () => this.refresh(), this);
        this._interface.connectObject('changed::color-scheme', () => this.refresh(), this);
        this.refresh();
    }

    _set(light) {
        if (light === this.light)
            return;
        this.light = light;
        this.emit('changed');
    }

    refresh() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        const bg = this._background;

        // Sem imagem: só a cor (lisa ou em degradê).
        if (bg.get_string('picture-options') === 'none') {
            const top = parseHex(bg.get_string('primary-color'));
            const other = parseHex(bg.get_string('secondary-color'));
            const shading = bg.get_string('color-shading-type');
            // Degradê vertical: em cima fica a cor primária; horizontal: a média.
            const rgb = shading === 'horizontal' ? top.map((v, i) => (v + other[i]) / 2) : top;
            this._set(luminance(...rgb) > LIGHT_THRESHOLD);
            return;
        }

        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        const uri = (dark && bg.get_string('picture-uri-dark')) || bg.get_string('picture-uri');
        // Sem caminho, ou apresentação de slides (.xml): fica o texto branco.
        if (!uri || uri.endsWith('.xml')) {
            this._set(false);
            return;
        }

        Gio.File.new_for_uri(uri).read_async(GLib.PRIORITY_LOW, cancellable, (file, res) => {
            let stream;
            try {
                stream = file.read_finish(res);
            } catch {
                return; // arquivo sumiu ou foi cancelado: mantém o que estava
            }
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, SAMPLE_WIDTH, -1, true,
                cancellable, (_s, r) => {
                    try {
                        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
                        this._set(topLuminance(pixbuf) > LIGHT_THRESHOLD);
                    } catch {
                        // imagem ilegível ou cancelada: mantém o que estava
                    } finally {
                        stream.close_async(GLib.PRIORITY_LOW, null, null);
                    }
                });
        });
    }

    destroy() {
        this._cancellable?.cancel();
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
    }
}
