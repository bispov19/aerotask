#!/usr/bin/env python3
"""Gera os ícones dos menus em icons/menu/<nome>-symbolic.svg.

Estilo: contorno fino (traço de 1,5 px, pontas e cantos redondos) numa grade
de 16×16, como os símbolos dos menus do macOS. Todos saem deste arquivo, com
as mesmas primitivas, para formarem UMA família visual.

Por que o "traço" vira forma PREENCHIDA? O GNOME Shell (St) recolore um
-symbolic.svg injetando "rect,path,ellipse,circle,polygon { fill: <cor>
!important }" — só PREENCHIMENTO. Um traço de verdade ficaria com cor fixa e
as formas abertas virariam blocos. Então cada linha é uma cápsula de 1,5 px e
cada contorno é um anel (dois caminhos com fill-rule="evenodd"); o resultado
parece traço e recolore sozinho no tema claro e no escuro.

Uso: python3 scripts/make-menu-icons.py   (sobrescreve icons/menu/)
"""
import math
import os

W = 1.5          # espessura do "traço"
R = W / 2
COLOR = '#bebebe'  # cor de referência (o St troca pela cor do texto)
OUT = os.path.join(os.path.dirname(__file__), '..', 'icons', 'menu')


def f(v):
    return f'{v:.3f}'.rstrip('0').rstrip('.')


# ----- Primitivas (cada uma devolve uma lista de elementos SVG) -----

def capsule(x0, y0, x1, y1):
    """Segmento com pontas redondas (as meias-voltas curvam PARA FORA:
    sweep-flag 0 no sistema do SVG, com o eixo y para baixo)."""
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy) or 1e-6
    nx, ny = -dy / length * R, dx / length * R
    return [f'<path d="M{f(x0 + nx)} {f(y0 + ny)} L{f(x1 + nx)} {f(y1 + ny)} '
            f'A{f(R)} {f(R)} 0 0 0 {f(x1 - nx)} {f(y1 - ny)} '
            f'L{f(x0 - nx)} {f(y0 - ny)} A{f(R)} {f(R)} 0 0 0 {f(x0 + nx)} {f(y0 + ny)}Z"/>']


def dot(cx, cy, r=R):
    return [f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}"/>']


def polyline(points, closed=False):
    """Linhas ligadas, com juntas redondas."""
    pts = list(points) + ([points[0]] if closed else [])
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        out += capsule(x0, y0, x1, y1)
    for x, y in points:
        out += dot(x, y)
    return out


def rr_path(x, y, w, h, r):
    r = max(0.0, min(r, w / 2, h / 2))
    return (f'M{f(x + r)} {f(y)} H{f(x + w - r)} '
            f'A{f(r)} {f(r)} 0 0 1 {f(x + w)} {f(y + r)} V{f(y + h - r)} '
            f'A{f(r)} {f(r)} 0 0 1 {f(x + w - r)} {f(y + h)} H{f(x + r)} '
            f'A{f(r)} {f(r)} 0 0 1 {f(x)} {f(y + h - r)} V{f(y + r)} '
            f'A{f(r)} {f(r)} 0 0 1 {f(x + r)} {f(y)}Z')


def rrect(x, y, w, h, r):
    """Contorno de retângulo arredondado (o traço fica centrado na borda)."""
    return [f'<path fill-rule="evenodd" d="{rr_path(x - R, y - R, w + W, h + W, r + R)} '
            f'{rr_path(x + R, y + R, w - W, h - W, max(r - R, 0))}"/>']


def rrect_fill(x, y, w, h, r):
    return [f'<path d="{rr_path(x, y, w, h, r)}"/>']


def ring(cx, cy, r):
    def circle(rad):
        return (f'M{f(cx - rad)} {f(cy)} A{f(rad)} {f(rad)} 0 1 0 {f(cx + rad)} {f(cy)} '
                f'A{f(rad)} {f(rad)} 0 1 0 {f(cx - rad)} {f(cy)}Z')
    return [f'<path fill-rule="evenodd" d="{circle(r + R)} {circle(r - R)}"/>']


def arc(cx, cy, r, a0, a1):
    """Arco (graus; 0 = direita, 90 = baixo — eixo y para baixo) com pontas redondas."""
    steps = max(8, int(abs(a1 - a0) / 6))
    pts = [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
            cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        out += capsule(x0, y0, x1, y1)
    return out


def point_on(cx, cy, r, a):
    return cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))


def mirror(elements_fn):
    """Espelha um ícone na horizontal (ex.: refazer = desfazer espelhado)."""
    return ['<g transform="matrix(-1 0 0 1 16 0)">', *elements_fn(), '</g>']


# ----- Ícones -----

def window(x=1.75, y=2.75, w=12.5, h=10.5):
    return rrect(x, y, w, h, 2.25)


def magnifier():
    return ring(6.75, 6.75, 4.5) + capsule(10.1, 10.1, 13.75, 13.75)


def undo():
    return (arc(9.5, 9, 3.5, -90, 90) + capsule(9.5, 5.5, 3.5, 5.5) +
            polyline([(6, 3), (3.5, 5.5), (6, 8)]) + capsule(9.5, 12.5, 6, 12.5))


def gear():
    out = ring(8, 8, 4.25) + ring(8, 8, 1.75)
    for i in range(8):
        a = i * 45
        x0, y0 = point_on(8, 8, 5.0, a)
        x1, y1 = point_on(8, 8, 6.5, a)
        out += capsule(x0, y0, x1, y1)
    return out


ICONS = {
    # Menu do sistema
    'computer': lambda: rrect(3, 3.5, 10, 7, 1.25) + capsule(1.5, 12.75, 14.5, 12.75),
    'settings': gear,
    'software': lambda: (capsule(9.2, 2.6, 4.1, 11.6) + capsule(6.8, 2.6, 11.9, 11.6) +
                         capsule(2.25, 9.75, 13.75, 9.75) + capsule(2.6, 13.2, 3.4, 11.9) +
                         capsule(13.4, 13.2, 12.6, 11.9)),
    # Arquivo
    'window-new': lambda: (rrect(1.75, 2.75, 10, 9, 2) + capsule(1.75, 5.5, 11.75, 5.5) +
                           capsule(13.25, 10, 13.25, 14.5) + capsule(11, 12.25, 15.5, 12.25)),
    'tab-new': lambda: (rrect(1.75, 3.25, 12.5, 9.5, 2) + capsule(1.75, 6, 14.25, 6) +
                        capsule(8, 7.75, 8, 11) + capsule(6.4, 9.4, 9.6, 9.4)),
    'open': lambda: polyline([(1.75, 4), (6, 4), (7.5, 5.5), (14.25, 5.5), (14.25, 12.75),
                              (1.75, 12.75)], closed=True) + capsule(1.75, 7.75, 14.25, 7.75),
    'recent': lambda: ring(8, 8, 6) + polyline([(8, 4.5), (8, 8), (10.5, 9.5)]),
    'close': lambda: capsule(4.5, 4.5, 11.5, 11.5) + capsule(11.5, 4.5, 4.5, 11.5),
    'save': lambda: (capsule(8, 2.25, 8, 9.75) + polyline([(5, 7), (8, 10), (11, 7)]) +
                     polyline([(2.25, 9.5), (2.25, 13.5), (13.75, 13.5), (13.75, 9.5)])),
    'save-as': lambda: (capsule(6.5, 3.5, 6.5, 9.75) + polyline([(4, 7.25), (6.5, 9.75), (9, 7.25)]) +
                        polyline([(2.25, 9.5), (2.25, 13.5), (13.75, 13.5), (13.75, 9.5)]) +
                        capsule(12.25, 2, 12.25, 6) + capsule(10.25, 4, 14.25, 4)),
    'print': lambda: (rrect(1.75, 6, 12.5, 6, 1.75) + polyline([(4.5, 6), (4.5, 2.25), (11.5, 2.25), (11.5, 6)]) +
                      rrect(4.75, 9.5, 6.5, 4.5, 0.75) + dot(12, 8, 0.8)),
    # Editar
    'undo': undo,
    'redo': lambda: mirror(undo),
    'cut': lambda: (ring(4.5, 11.75, 2) + ring(11.5, 11.75, 2) +
                    capsule(5.8, 10.2, 11.25, 2.25) + capsule(10.2, 10.2, 4.75, 2.25)),
    'copy': lambda: (polyline([(5.75, 4.75), (5.75, 2.25), (13.75, 2.25), (13.75, 10.25), (10.75, 10.25)]) +
                     rrect(2.25, 5.25, 8, 8.5, 1.5)),
    'paste': lambda: rrect(3, 3.5, 10, 10.75, 1.75) + rrect(5.75, 1.75, 4.5, 2.5, 1),
    'delete': lambda: (polyline([(5.25, 3.25), (14.25, 3.25), (14.25, 12.75), (5.25, 12.75), (1.75, 8)], closed=True) +
                       capsule(7.75, 6, 11.25, 10) + capsule(11.25, 6, 7.75, 10)),
    'select-all': lambda: (polyline([(2, 5.5), (2, 2), (5.5, 2)]) + polyline([(10.5, 2), (14, 2), (14, 5.5)]) +
                           polyline([(14, 10.5), (14, 14), (10.5, 14)]) + polyline([(5.5, 14), (2, 14), (2, 10.5)]) +
                           rrect_fill(5.5, 5.5, 5, 5, 1)),
    'find': magnifier,
    'emoji': lambda: (ring(8, 8, 6.25) + dot(5.9, 6.6, 0.95) + dot(10.1, 6.6, 0.95) +
                      arc(8, 8.4, 3.2, 25, 155)),
    # Visualizar
    'sidebar': lambda: (window() + capsule(6.25, 2.75, 6.25, 13.25) +
                        capsule(3.5, 5.75, 4.5, 5.75) + capsule(3.5, 8, 4.5, 8)),
    'zoom-in': lambda: magnifier() + capsule(4.75, 6.75, 8.75, 6.75) + capsule(6.75, 4.75, 6.75, 8.75),
    'zoom-out': lambda: magnifier() + capsule(4.75, 6.75, 8.75, 6.75),
    'zoom-reset': lambda: magnifier() + rrect_fill(5.4, 5.4, 2.7, 2.7, 0.6),
    'fullscreen': lambda: (capsule(9.25, 6.75, 13.5, 2.5) + polyline([(9.75, 2.5), (13.5, 2.5), (13.5, 6.25)]) +
                           capsule(6.75, 9.25, 2.5, 13.5) + polyline([(2.5, 9.75), (2.5, 13.5), (6.25, 13.5)])),
    # Janela
    'minimize': lambda: window() + capsule(5, 10.25, 11, 10.25),
    'maximize': lambda: (window() + capsule(5.25, 10.75, 10.75, 5.25) +
                         polyline([(7.5, 5.25), (10.75, 5.25), (10.75, 8.5)])),
    'tile-left': lambda: window() + rrect_fill(2.75, 3.75, 5, 8.5, 1.25),
    'tile-right': lambda: window() + rrect_fill(8.25, 3.75, 5, 8.5, 1.25),
    'next-display': lambda: (rrect(1.75, 2.25, 12.5, 8.5, 1.75) + capsule(8, 10.75, 8, 13.25) +
                             capsule(5.5, 13.5, 10.5, 13.5) + capsule(5.25, 6.5, 10.25, 6.5) +
                             polyline([(8.5, 4.75), (10.25, 6.5), (8.5, 8.25)])),
    'workspaces': lambda: (rrect(1.75, 1.75, 5, 5, 1.25) + rrect(9.25, 1.75, 5, 5, 1.25) +
                           rrect(1.75, 9.25, 5, 5, 1.25) + rrect(9.25, 9.25, 5, 5, 1.25)),
    'pin': lambda: (ring(8, 4.75, 2.75) + capsule(4.5, 9, 11.5, 9) + capsule(8, 9, 8, 14.5) +
                    capsule(6.25, 7.25, 5.5, 9) + capsule(9.75, 7.25, 10.5, 9)),
    'bring-front': lambda: (polyline([(4.5, 5.25), (4.5, 2.25), (14.25, 2.25), (14.25, 9.75), (11.75, 9.75)]) +
                            rrect(1.75, 5.75, 9.5, 8, 1.75)),
    # Ajuda
    'help': lambda: (ring(8, 8, 6.25) + arc(8, 6.6, 2.1, 190, 395) +
                     capsule(*point_on(8, 6.6, 2.1, 35), 8, 9.4) + dot(8, 11.5, 0.95)),
    'keyboard': lambda: (rrect(1.5, 4, 13, 8, 1.75) +
                         [e for x in (4.25, 6.75, 9.25, 11.75) for e in dot(x, 6.6, 0.8)] +
                         [e for x in (4.25, 6.75, 9.25, 11.75) for e in dot(x, 8.6, 0.8)] +
                         capsule(5.5, 10.4, 10.5, 10.4)),
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, draw in ICONS.items():
        body = '\n  '.join(draw())
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">\n'
               f'<g fill="{COLOR}">\n  {body}\n</g>\n</svg>\n')
        with open(os.path.join(OUT, f'{name}-symbolic.svg'), 'w') as fh:
            fh.write(svg)
    print(f'{len(ICONS)} ícones em {os.path.normpath(OUT)}')


if __name__ == '__main__':
    main()
