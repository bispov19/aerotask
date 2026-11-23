#!/usr/bin/env bash
# Testes de robustez no Shell aninhado (precisa do dev-nested.sh rodando).
#
# Critérios de aceite verificados:
#   - ativar/desativar N vezes (padrão 10) sem erro e sem duplicar a barra;
#   - desativar restaura o painel (barra some, botão Atividades volta);
#   - bloquear/desbloquear (simulado com o mesmo mecanismo da tela de
#     bloqueio: Main.sessionMode.pushMode('unlock-dialog')) não duplica nada;
#   - nenhuma linha nova de erro no log mencionando a extensão.
#
# Uso: ./scripts/nested-test.sh [ciclos]

set -euo pipefail
cd "$(dirname "$0")/.."

CYCLES="${1:-10}"
LOG=$(ls -t "${XDG_STATE_HOME:-$HOME/.local/state}"/aerotask/nested-*.log | head -1)
BEFORE=$(wc -l < "$LOG")

./scripts/nested-eval.sh "(async () => {
  const uuid = 'aerotask@viniciusbispo19', m = Main.extensionManager;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => ({
    estado: m.lookup(uuid).state,
    erro: m.lookup(uuid).error || null,
    barras: Main.panel._leftBox.get_children().filter(c => c.name === 'aeroTaskMenuBar').length,
    atividadesVisivel: Main.panel.statusArea.activities.container.visible,
    menusNoGerenciador: Main.panel.menuManager._menus.length,
    atoresNoUiGroup: Main.layoutManager.uiGroup.get_n_children(),
    atoresAeroNoPalco: countOurs(global.stage),
    // Relógio do AeroTask (Farol): quantos existem, se o relógio do GNOME está visível, se o
    // calendário dele está em casa e se o Super+V voltou ao original.
    farois: Main.panel._rightBox.get_children().filter(c => c.get_first_child()?.constructor.name === 'AeroTaskFarolClock').length,
    relogioVisivel: Main.panel.statusArea.dateMenu.container.visible,
    calendarioEmCasa: !Main.panel.statusArea.dateMenu._calendar.get_parent()?.has_style_class_name?.('aerotask-farol-calendar-month'),
    // Fundo pintado pelo AeroTask (estilos Preto e Vidro) e o desfoque próprio do Vidro.
    fundoNosso: (Main.panel.style ?? '').replace(/ /g, '').includes('background-color:rgba('),
    vidros: Main.layoutManager.panelBox.get_children().filter(c => c.name === 'aerotask-panel-glass').length,
    estiloBarra: m.lookup(uuid).stateObj?._settings?.get_string('panel-style') ?? null,
    // Bateria: o ícone do GNOME volta ao desativar; o OSD volta ao original.
    bateriaGnomeVisivel: Main.panel.statusArea.quickSettings._system?.visible ?? true,
    osdOriginal: !Object.prototype.hasOwnProperty.call(Main.osdWindowManager, 'showAll') ||
      Main.osdWindowManager.showAll === Object.getPrototypeOf(Main.osdWindowManager).showAll,
    superficies: Main.layoutManager.uiGroup.get_children().filter(c => c.constructor.name === 'AeroTaskFarolSurface').length,
    superVOriginal: !Object.prototype.hasOwnProperty.call(Main.panel, 'toggleCalendar') ||
      Main.panel.toggleCalendar === Object.getPrototypeOf(Main.panel).toggleCalendar,
    // Prateleira: o atalho Super+Shift+V só existe com o relógio do AeroTask; a
    // bandeja de arquivos (janela GTK) fecha junto com a extensão.
    // (removeKeybinding não apaga a entrada: deixa o modo em NONE = 0.)
    atalhoPrateleira: (Main.wm._allowedKeybindings['clipboard-shortcut'] ?? 0) !== 0,
    // Barra flutuante: ao desativar, nada de máscara/estilo/deslocamento sobrando.
    mascaraBarra: !!Main.layoutManager.panelBox.get_effect('aerotask-menu-floating-mask'),
    estiloPanelBox: Main.layoutManager.panelBox.style ?? null,
    barraTransformada: Main.panel.translation_y !== 0 || Main.panel.scale_x !== 1,
    // Ícones de bandeja (rodar com um programa de bandeja aberto, ex.:
    // dev/test-apps/sni-test.js): ao desativar, nenhum botão sobra.
    iconesBandeja: Main.panel._rightBox.get_children()
      .filter(c => c.get_first_child()?.constructor.name === 'AeroTaskTrayButton').length,
    bandejas: global.get_window_actors().filter(a => a.meta_window.get_wm_class() === 'io.github.viniciusbispo19.AeroTask.Tray').length,
  });
  // Conta, no palco inteiro, os atores ESTRUTURAIS das nossas classes
  // (barra, títulos, raízes de menu, diálogos — GTypes AeroTaskMenu*). Itens de
  // menu ficam de fora: eles são criados sob demanda quando um menu abre.
  // Se algum ator estrutural sobrar após os ciclos, é vazamento nosso.
  function countOurs(actor) {
    const name = actor.constructor.name;
    let n = name.startsWith('AeroTaskMenu') && !name.endsWith('Item') ? 1 : 0;
    for (const child of actor.get_children())
      n += countOurs(child);
    return n;
  }
  await wait(2000); // deixa as outras extensões terminarem de iniciar
  // Ciclo de aquecimento: reativar recria o Registrar, e apps Qt/Electron já
  // abertos não se registram de novo (a barra passa a usar os menus padrão).
  // Medimos a partir daqui, para comparar só o que é vazamento.
  m.disableExtension(uuid); await wait(250);
  m.enableExtension(uuid); await wait(500);
  const antes = snap();
  for (let i = 0; i < ${CYCLES}; i++) {
    m.disableExtension(uuid); await wait(250);
    m.enableExtension(uuid); await wait(250);
    // Abre o painel (pelo Super+V) e desativa com ele aberto: o calendário
    // emprestado precisa voltar para o relógio do GNOME.
    // Um alerta de volume no meio do ciclo (a forma do alerta precisa sumir).
    Main.osdWindowManager.showAll(new (imports.gi.Gio.ThemedIcon)({name: 'audio-volume-medium-symbolic'}), null, 0.5, 1);
    if (i % 4 === 0) { m.lookup(uuid).stateObj._farol.toggle('shelf', true); await wait(150); }
    else if (i % 2 === 0) { Main.panel.toggleCalendar(); await wait(150); }
    // E com um menu da barra aberto (a forma de vidro atrás dele).
    else {
      const bar = Main.panel._leftBox.get_children().find(c => c.name === 'aeroTaskMenuBar');
      bar?._menuButtons[1]?.menu.open(); await wait(150);
    }
  }
  // Fecha o que ficou aberto (menu do último ciclo) antes de comparar.
  Main.panel.menuManager.activeMenu?.close(); await wait(900);
  const depois = snap();
  // Abre a bandeja de arquivos e desativa com ela aberta.
  m.lookup(uuid).stateObj._fileTray.open(); await wait(3000);
  const comBandeja = snap();
  m.disableExtension(uuid); await wait(800);
  const desativada = snap();
  m.enableExtension(uuid); await wait(300);
  Main.sessionMode.pushMode('unlock-dialog'); await wait(500);
  const bloqueada = snap();
  Main.sessionMode.popMode('unlock-dialog'); await wait(800);
  const desbloqueada = snap();
  return {antes, depois, comBandeja, desativada, bloqueada, desbloqueada};
})()" | sed "s/^(true, '//; s/')\$//" | python3 -I -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("Falha no Eval:", raw); sys.exit(1)
print(json.dumps(data, indent=1, ensure_ascii=False))
a, d = data["antes"], data["depois"]
checks = {
    "ativa e sem erro após os ciclos": d["estado"] == 1 and not d["erro"],
    "exatamente 1 barra após os ciclos": d["barras"] == 1,
    "nenhum menu sobrando no gerenciador": d["menusNoGerenciador"] == a["menusNoGerenciador"],
    "nenhum ator nosso sobrando no palco": d["atoresAeroNoPalco"] == a["atoresAeroNoPalco"],
    "desativar remove todos os atores nossos": data["desativada"]["atoresAeroNoPalco"] == 0,
    "desativar remove a barra": data["desativada"]["barras"] == 0,
    "desativar mostra o botão Atividades": data["desativada"]["atividadesVisivel"],
    "bloquear remove a barra (só o Registrar fica)": data["bloqueada"]["barras"] == 0
        and data["bloqueada"]["atoresAeroNoPalco"] == 0,
    "desbloquear recria 1 barra": data["desbloqueada"]["barras"] == 1,
    "exatamente 1 relógio do AeroTask após os ciclos": d["farois"] == 1,
    "relógio do AeroTask esconde o do GNOME": not d["relogioVisivel"],
    "desativar remove o relógio do AeroTask": data["desativada"]["farois"] == 0,
    "desativar mostra o relógio do GNOME": data["desativada"]["relogioVisivel"],
    "desativar devolve o calendário ao relógio": data["desativada"]["calendarioEmCasa"],
    "desativar restaura o Super+V": data["desativada"]["superVOriginal"],
    "fundo da barra conforme o estilo": d["fundoNosso"] == (d["estiloBarra"] != "gnome"),
    "no máximo 1 desfoque de vidro": d["vidros"] == (1 if d["estiloBarra"] == "glass" else 0),
    "desativar devolve a cor original da barra": not data["desativada"]["fundoNosso"],
    "desativar remove o desfoque de vidro": data["desativada"]["vidros"] == 0,
    "desativar remove as formas de vidro": data["desativada"]["superficies"] == 0,
    "desativar mostra o ícone de bateria do GNOME": data["desativada"]["bateriaGnomeVisivel"],
    "desativar devolve o OSD original": data["desativada"]["osdOriginal"],
    "bloquear remove o relógio do AeroTask": data["bloqueada"]["farois"] == 0,
    "desbloquear recria 1 relógio do AeroTask": data["desbloqueada"]["farois"] == 1,
    "atalho da Prateleira registrado": d["atalhoPrateleira"],
    "desativar remove o atalho da Prateleira": not data["desativada"]["atalhoPrateleira"],
    "a bandeja de arquivos abre": data["comBandeja"]["bandejas"] == 1,
    "desativar fecha a bandeja de arquivos": data["desativada"]["bandejas"] == 0,
    "barra flutuante conforme a preferência (sem janelas: máscara)": d["mascaraBarra"],
    "desativar tira a máscara da barra": not data["desativada"]["mascaraBarra"],
    "desativar devolve o estilo do panelBox": data["desativada"]["estiloPanelBox"] is None,
    "desativar devolve a barra sem deslocamento": not data["desativada"]["barraTransformada"],
    "ícones de bandeja não duplicam nos ciclos": d["iconesBandeja"] == a["iconesBandeja"],
    "desativar remove os ícones de bandeja": data["desativada"]["iconesBandeja"] == 0,
    "desbloquear traz os ícones de bandeja de volta": data["desbloqueada"]["iconesBandeja"] == a["iconesBandeja"],
}
for name, ok in checks.items():
    print(("  ✓ " if ok else "  ✗ ") + name)
print("RESULTADO:", "OK" if all(checks.values()) else "FALHOU")
'

echo "--- avisos novos no log causados pelo AeroTask:"
tail -n +$((BEFORE + 1)) "$LOG" | python3 -I -c '
import re, sys
blocks, cur = [], []
for line in sys.stdin.read().splitlines():
    if re.search(r"(CRITICAL|WARNING|ERROR) \*\*", line):
        if cur: blocks.append(cur)
        cur = [line]
    elif cur and line.strip():
        cur.append(line)
    elif cur:
        blocks.append(cur); cur = []
if cur: blocks.append(cur)
def first_frame(b):
    return next((l for l in b if l.lstrip().startswith("#0")), "")
# Nosso: a pilha passa pelo aerotask@ — exceto quando o erro nasce no código
# de OUTRA extensão (#0 nela), só disparado por algo nosso (ex.: o gnome-mosaic
# reage a toda janela que se move).
ours = [b for b in blocks if any("aerotask@" in l for l in b)
        and not ("/gnome-shell/extensions/" in first_frame(b) and "aerotask@" not in first_frame(b))]
other = [b for b in blocks if not any("@file://" in l or "@resource://" in l for l in b[1:])]
for b in ours:
    print("\n".join(b)); print()
if not ours:
    print("(nenhum)")
print(f"(outros avisos novos: {len(blocks) - len(ours)}, dos quais {len(other)} sem pilha JS)")
'
