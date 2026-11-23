// SPDX-License-Identifier: GPL-3.0-or-later
// O VIDRO da barra (estilo "Vidro" em panelLook.js): o mesmo material da
// Orla Dock (outro projeto do mesmo autor), para barra e dock parecerem
// feitas da mesma lâmina.
//
// Como o material é montado (para cada pixel do papel de parede já
// desfocado):
//
//   1. Refração — perto das bordas de cima e de baixo o vidro "curva": o
//      fundo é lido um pouco para dentro, como numa lente. Com a dispersão,
//      vermelho, verde e azul se deslocam diferente (arco-íris sutil).
//   2. Adaptação — mede o brilho do que está atrás e o puxa para um "tom"
//      fixo. Papel de parede claro ou escuro: o vidro fica com o mesmo
//      contraste, e o texto branco continua legível SEM camada escura.
//   3. Vibração — realça a saturação (as cores passam mais vivas).
//   4. Cor do vidro — modo "cor": usa a matiz do tom, mas mantém o brilho
//      de cada pixel (tinge sem escurecer).
//   5. Reflexo — um brilho suave vindo de cima.
//   6. Granulado — ruído quase invisível que evita "degraus" de cor.
//
// A borda clara (lâmina de vidro) é um contorno de 1 px só embaixo da barra
// (GLASS_BORDER, aplicado como sombra interna no estilo da barra).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// =============================================================================
// Valores do vidro — ajuste aqui (iguais aos da Orla Dock do usuário).
// O raio do desfoque e a força da cor também estão nas preferências.
// =============================================================================

/** Raio do desfoque, em px (padrão da chave glass-blur-radius). */
export const GLASS_BLUR_RADIUS = 8;
/** Brilho do Shell.BlurEffect: 1 = não escurece nem clareia o fundo. */
export const GLASS_BRIGHTNESS = 1.0;
/** Saturação: 1 = cores originais; 1,2 = 20% mais vivas ("vibrancy"). */
export const GLASS_SATURATION = 1.2;
/** Cor do vidro (r, g, b de 0 a 255): um azul-ardósia bem escuro. */
export const GLASS_TINT = [0x16, 0x20, 0x2a];
/** Força da cor do vidro, 0–1 (padrão da chave glass-opacity, em %). */
export const GLASS_OPACITY = 0.10;
/** Adaptação ao brilho do fundo (0 = nenhuma, 1 = máxima). */
export const GLASS_ADAPT = 0.6;
/** Tom para onde o brilho é puxado (0 = escuro, 1 = claro). */
export const GLASS_TONE = 0.2;
/** Refração perto das bordas (0–1) e separação das cores (0–1). */
export const GLASS_REFRACTION = 1.0;
export const GLASS_DISPERSION = 0.7;
/** Reflexo vindo de cima (0–1). */
export const GLASS_SHEEN = 0.5;
/** Granulado (0–1). */
export const GLASS_GRAIN = 0.2;
/** Borda clara: linha de 1 px, branco a 14%, só na parte de baixo da barra. */
export const GLASS_BORDER = 'box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.14);';

// ----- Constantes internas da receita (as mesmas da Orla) ---------------------

const LUMA = [0.2126, 0.7152, 0.0722]; // peso de cada canal no brilho (Rec. 709)
const TONE_DARK = 0.12; // GLASS_TONE = 0 → este brilho
const TONE_LIGHT = 0.86; // GLASS_TONE = 1 → este brilho
const ADAPT_KEEP = 0.2; // quanto do contraste original sobra na adaptação máxima
const BEVEL_PX = 16; // largura da faixa "curva" perto da borda
const REFRACT_PX = 9; // deslocamento máximo da leitura na faixa curva
const DISPERSION_PX = 2.2; // separação máxima entre as cores
const SHEEN_GAIN = 0.16; // quanto o reflexo clareia no topo
const SHEEN_REACH = 0.55; // até onde o reflexo desce (fração da altura)
const GRAIN_LEVELS = 3.0; // amplitude do granulado (níveis de 255)

const f = n => Number(n).toFixed(4);

const GLSL_DECLARATIONS = `
uniform vec2 aero_size;        // tamanho da barra, em pixels
uniform vec2 aero_tex_scale;   // parte usada da textura (0..1)
uniform float aero_scale;      // escala da tela
uniform float aero_target;
uniform float aero_adapt;
uniform float aero_saturation;
uniform vec4 aero_tint;
uniform float aero_refraction;
uniform float aero_dispersion;
uniform float aero_sheen;
uniform float aero_grain;

const vec3 AERO_LUMA = vec3(${LUMA.map(f).join(', ')});

// Distância até a borda de um retângulo centrado em 0 (negativa dentro).
float aero_sdf(vec2 p, vec2 half_size) {
    vec2 q = abs(p) - half_size;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// Direção "para fora" da borda mais próxima.
vec2 aero_normal(vec2 p, vec2 half_size) {
    float e = 0.5;
    vec2 g = vec2(aero_sdf(p + vec2(e, 0.0), half_size) - aero_sdf(p - vec2(e, 0.0), half_size),
                  aero_sdf(p + vec2(0.0, e), half_size) - aero_sdf(p - vec2(0.0, e), half_size));
    float len = length(g);
    return len > 0.0001 ? g / len : vec2(0.0, -1.0);
}

// Lê o fundo desfocado num ponto (em pixels).
vec4 aero_sample(vec2 p) {
    vec2 uv = clamp(p, vec2(0.5), aero_size - vec2(0.5)) / aero_size * aero_tex_scale;
    return texture2D(cogl_sampler0, uv);
}

float aero_hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

const GLSL_CODE = `
vec2 p = cogl_tex_coord_in[0].xy / aero_tex_scale * aero_size;
vec2 half_size = aero_size * 0.5;
vec2 c = p - half_size;
float dist = aero_sdf(c, half_size);
vec2 n = aero_normal(c, half_size);

// 1. Refração e dispersão perto das bordas.
float bevel = min(${f(BEVEL_PX)} * aero_scale, min(half_size.x, half_size.y) * 0.9);
float t = clamp(1.0 + dist / max(bevel, 1.0), 0.0, 1.0);
float bend = aero_refraction * ${f(REFRACT_PX)} * aero_scale * t * t;
vec4 texel = cogl_color_out;
if (bend > 0.01) {
    float spread = aero_dispersion * ${f(DISPERSION_PX)} * aero_scale * t;
    vec4 g = aero_sample(p - n * bend);
    float r = aero_sample(p - n * (bend + spread)).r;
    float b = aero_sample(p - n * max(bend - spread, 0.0)).b;
    texel = vec4(r, g.g, b, g.a);
}
float alpha = texel.a;
vec3 base = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);

// 2. Adaptação ao brilho do que está atrás.
float lum = dot(base, AERO_LUMA);
base += vec3(aero_adapt * ${f(1 - ADAPT_KEEP)} * (aero_target - lum));
// 3. Vibração (saturação).
lum = dot(base, AERO_LUMA);
base = mix(vec3(lum), base, aero_saturation);
// 4. Cor do vidro, modo "cor": matiz do tom, brilho do pixel.
float tint_lum = dot(aero_tint.rgb, AERO_LUMA);
base = mix(base, aero_tint.rgb + vec3(lum - tint_lum), aero_tint.a);
// 5. Reflexo vindo de cima.
float from_top = p.y / max(aero_size.y, 1.0);
base += vec3(aero_sheen * ${f(SHEEN_GAIN)} * pow(clamp(1.0 - from_top / ${f(SHEEN_REACH)}, 0.0, 1.0), 2.0));
// 6. Granulado.
base += vec3((aero_hash(floor(p)) - 0.5) * aero_grain * ${f(GRAIN_LEVELS / 255)} * 2.0);

cogl_color_out = vec4(clamp(base, 0.0, 1.0) * alpha, alpha);
`;

const UNIFORMS = ['size', 'tex_scale', 'scale', 'target', 'adapt', 'saturation',
    'tint', 'refraction', 'dispersion', 'sheen', 'grain'];

// Textura arredondada para cima em degraus de 64 px: reaproveitada quando
// a barra muda um pouco de tamanho.
const TEXTURE_STEP = 64;
const roundUp = v => Math.max(TEXTURE_STEP, Math.ceil(v / TEXTURE_STEP) * TEXTURE_STEP);

/**
 * Desfoque + material de vidro. É um Shell.BlurEffect (modo ACTOR: desfoca o
 * conteúdo do ator, aqui a cópia do papel de parede) cujo resultado, em vez
 * de ir direto para a tela, é desenhado numa textura nossa e "carimbado" na
 * tela por um shader com os passos do material (Clutter.LayerNode +
 * Cogl.Pipeline com um trecho de GLSL).
 */
export const GlassEffect = GObject.registerClass(
class AeroTaskGlassEffect extends Shell.BlurEffect {
    /** @param {number} radius - raio do desfoque, em px */
    _init(radius) {
        super._init({mode: Shell.BlurMode.ACTOR, brightness: GLASS_BRIGHTNESS, radius});
        this._tintOpacity = GLASS_OPACITY;
        this._framebuffer = null;
        this._pipeline = null;
        this._texWidth = 0;
        this._texHeight = 0;
    }

    /** @param {number} value - força da cor do vidro, 0–1 */
    set tintOpacity(value) {
        this._tintOpacity = value;
        this.queue_repaint();
    }

    _ensureFramebuffer(actor, width, height) {
        if (this._framebuffer && width <= this._texWidth && height <= this._texHeight)
            return;
        const context = actor.get_context().get_backend().get_cogl_context();
        this._texWidth = roundUp(width);
        this._texHeight = roundUp(height);
        const texture = Cogl.Texture2D.new_with_size(context, this._texWidth, this._texHeight);
        this._framebuffer = Cogl.Offscreen.new_with_texture(texture);
        this._pipeline = Cogl.Pipeline.new(context);
        this._pipeline.set_layer_texture(0, texture);
        this._pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        this._pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
            GLSL_DECLARATIONS, GLSL_CODE));
        this._uniforms = Object.fromEntries(UNIFORMS.map(name =>
            [name, this._pipeline.get_uniform_location(`aero_${name}`)]));
    }

    vfunc_paint_node(node, paintContext, flags) {
        const actor = this.get_actor();
        if (!actor) {
            super.vfunc_paint_node(node, paintContext, flags);
            return;
        }
        // Tamanho em pixels reais (considera escala fracionária, ex.: 1,33).
        const [width, height] = actor.get_size();
        const scale = actor.get_resource_scale();
        const pixelWidth = Math.ceil(width * scale);
        const pixelHeight = Math.ceil(height * scale);
        if (!(pixelWidth > 0) || !(pixelHeight > 0)) // também pega NaN
            return;

        this._ensureFramebuffer(actor, pixelWidth, pixelHeight);
        this._framebuffer.orthographic(0, 0,
            this._texWidth / scale, this._texHeight / scale, 0, 1);
        this._framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);

        const usedX = pixelWidth / this._texWidth;
        const usedY = pixelHeight / this._texHeight;
        const values = {
            size: [pixelWidth, pixelHeight],
            tex_scale: [usedX, usedY],
            scale: [scale],
            target: [TONE_DARK + (TONE_LIGHT - TONE_DARK) * GLASS_TONE],
            adapt: [GLASS_ADAPT],
            saturation: [GLASS_SATURATION],
            tint: [...GLASS_TINT.map(v => v / 255), this._tintOpacity],
            refraction: [GLASS_REFRACTION],
            dispersion: [GLASS_DISPERSION],
            sheen: [GLASS_SHEEN],
            grain: [GLASS_GRAIN],
        };
        for (const [name, value] of Object.entries(values))
            this._pipeline.set_uniform_float(this._uniforms[name], value.length, 1, value);

        const layer = Clutter.LayerNode.new_to_framebuffer(this._framebuffer, this._pipeline);
        layer.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}),
            0, 0, usedX, usedY);
        node.add_child(layer);
        // O Shell.BlurEffect desenha DENTRO da nossa camada.
        super.vfunc_paint_node(layer, paintContext, flags);
    }
});
