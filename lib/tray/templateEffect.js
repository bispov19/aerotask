// SPDX-License-Identifier: GPL-3.0-or-later
// Ícone "template", como no macOS: só a FORMA do ícone, pintada na cor do
// texto da barra.
//
// Por que não tons de cinza? Um ícone colorido em tons de cinza fica com a
// luminosidade da cor original: o coração roxo do Deezer vira um cinza
// escuro e parece "apagado" (desabilitado) na barra preta. O template ignora
// a cor e usa só a transparência (alfa) de cada pixel: onde o ícone existe, a
// cor do texto; onde é transparente, nada — igual aos ícones simbólicos.
//
// Como funciona um Clutter.ShaderEffect: o Clutter desenha o ator numa
// textura fora da tela e depois a desenha na tela passando cada pixel pelo
// nosso código (GLSL). As "uniforms" são a cor que mandamos do JavaScript.

import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

const DECLARATIONS = `
uniform float tm_red;
uniform float tm_green;
uniform float tm_blue;
`;

// Roda DEPOIS da cor normal do pixel (cogl_color_out) ser calculada. As
// cores do Clutter têm alfa PRÉ-MULTIPLICADO: a cor nova também é
// multiplicada pelo alfa (senão a borda suavizada ficaria "dura").
const CODE = `
float a = cogl_color_out.a;
cogl_color_out = vec4(tm_red * a, tm_green * a, tm_blue * a, a);
`;

export const TemplateEffect = GObject.registerClass(
class AeroTaskTemplateEffect extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
    }

    /** @param {Cogl.Color} color - a cor do texto da barra (0–255) */
    setColor(color) {
        this.set_uniform_float('tm_red', 1, [color.red / 255]);
        this.set_uniform_float('tm_green', 1, [color.green / 255]);
        this.set_uniform_float('tm_blue', 1, [color.blue / 255]);
        this.queue_repaint();
    }
});
