// SPDX-License-Identifier: GPL-3.0-or-later
// Barra superior FLUTUANTE: com cantos arredondados e uma margem em relação
// às bordas da tela quando nenhuma janela está maximizada; encostada no
// topo (sem margem e sem cantos) quando há uma janela maximizada — como a
// barra do macOS com uma janela em tela cheia.
//
// Como funciona (sem brigar com o Blur my Shell):
//
//   - Geometria: um "padding" no panelBox (o contêiner da barra). A barra
//     fica recuada dentro dele e a área reservada para a barra ("struts")
//     cresce junto: janelas maximizadas ficam abaixo da barra flutuante. O
//     Blur my Shell posiciona o desfoque na posição da barra, então ele
//     acompanha sozinho.
//   - Cantos: uma máscara (shader) no panelBox recorta a barra E o desfoque
//     num retângulo de cantos arredondados. Não usamos border-radius na barra:
//     o Blur my Shell reescreve o border-radius dela com o valor dele.
//   - Transição: a geometria muda UMA vez (mudar a margem a cada quadro
//     faria cada janela maximizada ser redimensionada a cada quadro). O
//     movimento suave é só visual: a máscara e a barra (deslocamento + uma
//     escala leve) vão do estado antigo ao novo numa Clutter.Timeline, com a
//     duração dos pop-ups do GNOME. "Reduzir animação" pula para o fim.
//
// Quando encostar: há uma janela visível no monitor da barra, na área de
// trabalho atual, maximizada na vertical (inclui janelas presas em meia tela,
// que também encostam no topo). Recalculado quando janelas são maximizadas,
// restauradas, minimizadas, fechadas, abertas ou trocadas de área de trabalho
// — várias mudanças seguidas viram um cálculo só, antes do próximo quadro.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {POPUP_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/boxpointer.js';

/** Margem da barra flutuante (px lógicos): em cima e dos lados. */
const MARGIN_TOP = 6;
const MARGIN_SIDE = 8;
/** Raio dos cantos (no máximo metade da altura da barra). */
const CORNER_RADIUS = 12;

const MASK_DECLARATIONS = `
uniform float am_width;
uniform float am_height;
uniform float am_x;
uniform float am_y;
uniform float am_w;
uniform float am_h;
uniform float am_radius;
`;

// Cobertura do pixel dentro do retângulo arredondado (1 px de suavização).
const MASK_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * vec2(am_width, am_height);
vec2 halfSize = vec2(am_w, am_h) * 0.5;
vec2 center = vec2(am_x, am_y) + halfSize;
float r = min(am_radius, min(halfSize.x, halfSize.y));
vec2 q = abs(p - center) - (halfSize - vec2(r));
float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
float cover = clamp(0.5 - dist, 0.0, 1.0);
// Cores do Clutter têm alfa pré-multiplicado: multiplicar tudo apaga.
cogl_color_out *= cover;
`;

/** Recorta o ator num retângulo de cantos arredondados (com antisserrilhado). */
const RoundedMask = GObject.registerClass(
class AeroMenuRoundedMask extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, MASK_DECLARATIONS, MASK_CODE);
    }

    /**
     * @param {number} width - largura do ator (px lógicos)
     * @param {number} height - altura do ator
     * @param {number[]} rect - [x, y, largura, altura] do retângulo visível
     * @param {number} radius - raio dos cantos
     */
    setShape(width, height, [x, y, w, h], radius) {
        // Números soltos (um "vec4" passado de uma vez chegava zerado).
        this.set_uniform_float('am_width', 1, [width]);
        this.set_uniform_float('am_height', 1, [height]);
        this.set_uniform_float('am_x', 1, [x]);
        this.set_uniform_float('am_y', 1, [y]);
        this.set_uniform_float('am_w', 1, [w]);
        this.set_uniform_float('am_h', 1, [h]);
        this.set_uniform_float('am_radius', 1, [radius]);
    }
});

export class FloatingPanel {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._box = Main.layoutManager.panelBox;
        this._panel = Main.panel;
        this._originalStyle = this._box.style;
        this._floating = null; // estado atual (null = ainda não aplicado)
        this._progress = 1; // 0 = flutuante, 1 = encostada (visual)
        this._from = 1;
        this._to = 1;
        this._timeline = null;
        this._laterId = 0;
        this._mask = null;

        settings.connectObject('changed::floating-panel', () => this._queueUpdate(), this);

        // Tudo que pode mudar "tem janela maximizada?".
        global.window_manager.connectObject(
            'size-changed', () => this._queueUpdate(),
            'minimize', () => this._queueUpdate(),
            'unminimize', () => this._queueUpdate(),
            'map', () => this._queueUpdate(),
            'destroy', () => this._queueUpdate(),
            'switch-workspace', () => this._queueUpdate(),
            this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this._queueUpdate(), this);
        global.display.connectObject(
            'window-entered-monitor', () => this._queueUpdate(),
            'window-left-monitor', () => this._queueUpdate(),
            'restacked', () => this._queueUpdate(),
            this);
        Main.overview.connectObject(
            'showing', () => this._queueUpdate(),
            'hidden', () => this._queueUpdate(),
            this);
        // A máscara depende do tamanho do panelBox (monitor, escala, altura).
        this._box.connectObject('notify::allocation', () => this._syncMask(), this);

        this._update(false);
    }

    /** Agrupa várias mudanças seguidas num cálculo só, antes do próximo quadro. */
    _queueUpdate() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._update(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Há uma janela maximizada (na vertical) visível no monitor da barra? */
    _hasMaximizedWindow() {
        const monitor = Main.layoutManager.primaryIndex;
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.list_all_windows().some(w =>
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.minimized &&
            w.maximized_vertically &&
            w.get_monitor() === monitor &&
            w.located_on_workspace(workspace) &&
            w.showing_on_its_workspace());
    }

    _update(animate) {
        const floating = this._settings.get_boolean('floating-panel') &&
            (Main.overview.visible || !this._hasMaximizedWindow());
        if (floating === this._floating)
            return;
        const first = this._floating === null;
        this._floating = floating;

        // 1) Geometria: muda uma vez (as janelas maximizadas se ajustam).
        this._box.style = floating
            ? `${this._originalStyle ?? ''} padding: ${MARGIN_TOP}px ${MARGIN_SIDE}px 0 ${MARGIN_SIDE}px;`.trim()
            : this._originalStyle;
        this._ensureMask();

        // 2) Visual: do estado antigo ao novo.
        const target = floating ? 0 : 1;
        const duration = animate && !first && St.Settings.get().enable_animations
            ? POPUP_ANIMATION_TIME : 0;
        this._animateTo(target, duration);
    }

    _ensureMask() {
        // A máscara só existe com a barra flutuante ou durante a transição
        // (encostada e parada, ela sai: poupa o desenho fora da tela).
        if (this._mask)
            return;
        this._mask = new RoundedMask();
        // O desfoque estático do Blur my Shell (dentro do panelBox) é uma
        // cópia do papel de parede do MONITOR inteiro, recortada só ao
        // desenhar: sem limitar o panelBox à própria área, a textura do
        // efeito teria o tamanho da tela e as contas da máscara não batem.
        this._originalClip = this._box.clip_to_allocation;
        this._box.clip_to_allocation = true;
        this._box.add_effect_with_name('aero-menu-floating-mask', this._mask);
    }

    _removeMask() {
        if (!this._mask)
            return;
        this._box.remove_effect(this._mask);
        this._mask = null;
        this._box.clip_to_allocation = this._originalClip;
    }

    _animateTo(target, duration) {
        this._timeline?.stop();
        this._timeline = null;
        this._from = this._progress;
        this._to = target;
        if (duration <= 0 || this._from === target) {
            this._setProgress(target);
            this._finish();
            return;
        }
        const timeline = new Clutter.Timeline({actor: this._panel, duration});
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        timeline.connect('new-frame', () => {
            const t = timeline.get_progress();
            this._setProgress(this._from + (this._to - this._from) * t);
        });
        timeline.connect('completed', () => {
            this._timeline = null;
            this._setProgress(this._to);
            this._finish();
        });
        this._timeline = timeline;
        timeline.start();
    }

    /** Fim da transição: encostada não precisa de máscara nem de transformação. */
    _finish() {
        this._panel.translation_y = 0;
        this._panel.scale_x = 1;
        if (!this._floating)
            this._removeMask();
        else
            this._syncMask();
    }

    /**
     * @param {number} p - 0 = visual flutuante, 1 = visual encostado
     */
    _setProgress(p) {
        this._progress = p;
        // A barra JÁ está na geometria final; o deslocamento/escala a levam
        // de onde ela "estava" até lá. top/side = o recuo visual agora.
        const top = MARGIN_TOP * (1 - p);
        const side = MARGIN_SIDE * (1 - p);
        const width = this._box.width;
        // Geometria FINAL (a do estado novo), calculada — e não lida da
        // alocação, que só se atualiza no próximo layout.
        const geometryTop = this._floating ? MARGIN_TOP : 0;
        const geometryWidth = width - (this._floating ? 2 * MARGIN_SIDE : 0);
        if (width > 0 && geometryWidth > 0) {
            // Escala pelo centro de cima: recua os dois lados por igual.
            this._panel.set_pivot_point(0.5, 0);
            this._panel.scale_x = (width - 2 * side) / geometryWidth;
            this._panel.translation_y = top - geometryTop;
        }
        this._syncMask();
    }

    _syncMask() {
        if (!this._mask)
            return;
        const width = this._box.width;
        const height = this._box.height;
        if (width <= 0 || height <= 0)
            return;
        const p = this._progress;
        const top = MARGIN_TOP * (1 - p);
        const side = MARGIN_SIDE * (1 - p);
        const panelHeight = this._panel.height;
        const radius = Math.min(CORNER_RADIUS, panelHeight / 2) * (1 - p);
        this._mask.setShape(width, height, [side, top, width - 2 * side, panelHeight], radius);
        this._box.queue_redraw();
    }

    destroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._timeline?.stop();
        this._timeline = null;
        this._settings.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._box.disconnectObject(this);
        this._removeMask();
        this._panel.translation_y = 0;
        this._panel.scale_x = 1;
        this._box.style = this._originalStyle;
    }
}
