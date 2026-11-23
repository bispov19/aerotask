// SPDX-License-Identifier: GPL-3.0-or-later
// Analisa os pixels de um ícone de bandeja para decidir como deixá-lo
// monocromático (veja templateEffect.js):
//
//   'shape' — o ícone é uma FORMA sobre fundo transparente (coração, seta,
//             nuvem…): basta pintar a forma na cor do texto;
//   'glyph' — é um "ladrilho" (quadrado/círculo cheio, como os ícones de app
//             de vários temas) com fundo de UMA cor: o fundo some e fica só o
//             desenho de dentro, na cor do texto;
//   'gray'  — ladrilho com fundo de várias cores (degradê, foto): não dá para
//             separar o desenho; fica em tons de cinza.
//
// JavaScript puro (sem Shell): recebe uma função que lê um pixel.

/** Mais que esta fração dos pixels opacos = ladrilho (formas ficam em ~0,4–0,7). */
const TILE_COVERAGE = 0.8;
/** A cor do fundo precisa ocupar pelo menos esta fração da faixa de fora. */
const MIN_BACKGROUND_SHARE = 0.5;
/** Distância de cor (0–1,7) até onde uma amostra ainda é "o fundo". */
const BACKGROUND_RANGE = 0.12;
/** Distância de cor (0–1,7) do fundo: abaixo = fundo; acima = desenho. */
const GLYPH_LOW = 0.15;
const GLYPH_HIGH = 0.35;
/** Detalhes de outra cor precisam ser pelo menos esta fração do desenho. */
const MIN_DETAIL_SHARE = 0.06;

/**
 * @param {number} width
 * @param {number} height
 * @param {Function} pixel - (x, y) => [r, g, b, a], tudo de 0 a 255 e SEM
 *   alfa pré-multiplicado
 * @returns {{kind: string, background: number[]|null}} background em 0–1
 */
export function analyzeIcon(width, height, pixel) {
    let opaque = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (pixel(x, y)[3] > 127) {
                opaque++;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }
    }
    if (!opaque || opaque / (width * height) < TILE_COVERAGE)
        return {kind: 'shape', background: null};

    // Cor do fundo do ladrilho: a cor MAIS FREQUENTE na faixa de fora (os
    // 20% perto da borda), onde quase nunca há desenho. A moda, e não a
    // média: ladrilhos costumam ter uma bordinha de outra cor.
    const bandX = Math.max(1, Math.round((maxX - minX + 1) * 0.2));
    const bandY = Math.max(1, Math.round((maxY - minY + 1) * 0.2));
    const samples = [];
    const bins = new Map();
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const inner = x >= minX + bandX && x <= maxX - bandX &&
                y >= minY + bandY && y <= maxY - bandY;
            const p = pixel(x, y);
            if (inner || p[3] < 240)
                continue;
            samples.push([p[0] / 255, p[1] / 255, p[2] / 255]);
            // Cores parecidas caem no mesmo "balde" (16 níveis por canal).
            const key = (p[0] >> 4) << 8 | (p[1] >> 4) << 4 | p[2] >> 4;
            bins.set(key, (bins.get(key) ?? 0) + 1);
        }
    }
    if (!samples.length)
        return {kind: 'gray', background: null};
    // O balde mais cheio dá a cor aproximada; o fundo são todas as amostras
    // PERTO dela (um degradê suave cruza a fronteira dos baldes).
    const [topKey] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
    const guess = [topKey >> 8, (topKey >> 4) & 15, topKey & 15].map(v => (v * 16 + 8) / 255);
    const near = samples.filter(c => colorDistance(c, guess) < BACKGROUND_RANGE);
    if (near.length < samples.length * MIN_BACKGROUND_SHARE)
        return {kind: 'gray', background: null};
    const background = [0, 1, 2].map(i => near.reduce((sum, c) => sum + c[i], 0) / near.length);
    return {kind: 'glyph', background};
}

function colorDistance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Máscara do desenho de dentro de um ladrilho: 1 onde a cor se afasta do
 * fundo, 0 no fundo e na bordinha do ladrilho (os pixels perto da borda
 * transparente). A transição é suave (antisserrilhado).
 *
 * @param {number} width
 * @param {number} height
 * @param {Function} pixel - como em analyzeIcon
 * @param {number[]} background - [r, g, b] de 0 a 1
 * @returns {Uint8Array} alfa (0–255), um byte por pixel
 */
export function glyphMask(width, height, pixel, background) {
    const ring = Math.max(1, Math.round(Math.min(width, height) * 0.08));
    const mask = new Uint8Array(width * height);
    const nearEdge = (x, y) => {
        for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height || pixel(nx, ny)[3] < 128)
                    return true;
            }
        }
        return false;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = pixel(x, y);
            if (a < 8 || nearEdge(x, y))
                continue;
            const d = colorDistance([r / 255, g / 255, b / 255], background);
            const t = Math.min(1, Math.max(0, (d - GLYPH_LOW) / (GLYPH_HIGH - GLYPH_LOW)));
            mask[y * width + x] = Math.round(a * t * t * (3 - 2 * t));
        }
    }
    knockOutDetails(width, height, pixel, background, mask);
    return mask;
}

/**
 * Segundo passo: se o desenho é quase todo de UMA cor com detalhes de outra
 * dentro (círculo vermelho com um "play" branco), os detalhes viram furos —
 * senão o desenho inteiro seria um borrão da cor do texto.
 *
 * Só vira furo o pixel longe das DUAS cores (do desenho e do fundo): as
 * bordas suavizadas entre desenho e fundo ficam como estão.
 */
function knockOutDetails(width, height, pixel, background, mask) {
    const inside = [];
    const bins = new Map();
    for (let i = 0; i < width * height; i++) {
        if (mask[i] < 200)
            continue;
        const p = pixel(i % width, Math.floor(i / width));
        const c = [p[0] / 255, p[1] / 255, p[2] / 255];
        inside.push([i, c]);
        const key = (p[0] >> 4) << 8 | (p[1] >> 4) << 4 | p[2] >> 4;
        bins.set(key, (bins.get(key) ?? 0) + 1);
    }
    if (inside.length < 8)
        return;
    const [topKey] = [...bins.entries()].sort((x, y) => y[1] - x[1])[0];
    const guess = [topKey >> 8, (topKey >> 4) & 15, topKey & 15].map(v => (v * 16 + 8) / 255);
    const main = inside.filter(([, c]) => colorDistance(c, guess) < BACKGROUND_RANGE);
    if (main.length < inside.length * MIN_BACKGROUND_SHARE)
        return; // desenho de várias cores (degradê): fica inteiro
    const color = [0, 1, 2].map(k => main.reduce((sum, [, c]) => sum + c[k], 0) / main.length);
    const holes = [];
    for (let i = 0; i < width * height; i++) {
        if (!mask[i])
            continue;
        const p = pixel(i % width, Math.floor(i / width));
        const c = [p[0] / 255, p[1] / 255, p[2] / 255];
        if (colorDistance(c, color) > GLYPH_HIGH && colorDistance(c, background) > GLYPH_HIGH)
            holes.push(i);
    }
    // Poucos pixels diferentes = ruído/brilho, não um detalhe.
    if (holes.length < inside.length * MIN_DETAIL_SHARE)
        return;
    for (const i of holes)
        mask[i] = 0;
}
