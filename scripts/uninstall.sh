#!/usr/bin/env bash
# Desinstala o AeroTask: desativa, tira da lista de extensões ativas e
# apaga a pasta instalada.
#
#   ./scripts/uninstall.sh            # mantém configurações e dados
#   ./scripts/uninstall.sh --limpar   # apaga também as configurações (dconf)
#                                     # e os dados (~/.local/share/aerotask)

set -euo pipefail

UUID=aerotask@bispov19
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

gnome-extensions disable "$UUID" 2>/dev/null || true

python3 - "$UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
enabled = [] if out.startswith('@as') else ast.literal_eval(out)
subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                       str([u for u in enabled if u != uuid])])
PY

if [ -d "$EXT_DIR/$UUID" ]; then
    rm -rf "${EXT_DIR:?}/$UUID"
    echo "Removido: $EXT_DIR/$UUID"
else
    echo "O AeroTask não estava instalado."
fi

if [ "${1:-}" = "--limpar" ]; then
    dconf reset -f /org/gnome/shell/extensions/aerotask/
    rm -rf "${HOME:?}/.local/share/aerotask"
    echo "Configurações e dados apagados."
fi

echo "Encerre a sessão e entre de novo para o Shell esquecer a extensão."
