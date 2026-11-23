#!/usr/bin/env bash
# Empacota e instala o AeroTask em ~/.local/share/gnome-shell/extensions/.
#
# Por que não usar um link simbólico para a pasta do projeto? Porque um
# `gnome-extensions install --force` posterior apagaria o destino do link —
# ou seja, o seu código-fonte. Copiar via pacote é mais seguro e testa
# exatamente o que será publicado.
#
# No Wayland o Shell em execução NÃO recarrega o código de uma extensão:
# depois de instalar, encerre a sessão e entre de novo (ou teste numa sessão
# aninhada: scripts/dev-nested.sh).

set -euo pipefail
cd "$(dirname "$0")/.."

UUID=aerotask@bispov19
SCHEMA=org.gnome.shell.extensions.aerotask
NEW_PATH=/org/gnome/shell/extensions/aerotask/
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

# Nomes anteriores do projeto (migração): OLD_UUIDS e OLD_PATHS.
source scripts/legacy-names.sh

./scripts/build.sh
gnome-extensions install --force "build/$UUID.shell-extension.zip"
echo "Instalado em $EXT_DIR/$UUID"

# 1) Configurações: se o AeroTask ainda não tem nenhuma, copia as do nome
#    anterior (o primeiro caminho antigo com dados), só as chaves que existem
#    no schema novo.
if [ -z "$(dconf dump "$NEW_PATH")" ]; then
    keys=$(gsettings --schemadir "$EXT_DIR/$UUID/schemas" list-keys "$SCHEMA")
    for old in "${OLD_PATHS[@]}"; do
        dump=$(dconf dump "$old")
        [ -n "$dump" ] || continue
        # Mantém o cabeçalho [/] e as linhas "chave=valor" de chaves conhecidas.
        printf '%s\n' "$dump" | KEYS="$keys" awk '
            BEGIN { n = split(ENVIRON["KEYS"], k, "\n"); for (i = 1; i <= n; i++) ok[k[i]] = 1 }
            /^\[/ { print; next }
            { split($0, kv, "="); if (kv[1] in ok) print }
        ' | dconf load "$NEW_PATH"
        echo "Configurações copiadas de $old"
        break
    done
fi

# 2) Versões antigas: desativa (o Shell em execução tira a barra antiga na
#    hora) e remove a pasta, para não ficarem duas extensões disputando a
#    barra. As configurações antigas ficam no dconf (não atrapalham).
for old in "${OLD_UUIDS[@]}"; do
    if [ -d "$EXT_DIR/$old" ]; then
        gnome-extensions disable "$old" 2>/dev/null || true
        rm -rf "${EXT_DIR:?}/$old"
        echo "Versão antiga removida: $old"
    fi
done

# 3) Liga o AeroTask e tira os nomes antigos da lista de extensões ativas.
#    (gnome-extensions enable só funciona se o Shell em execução já conhecer
#    a extensão; editar a lista funciona sempre e vale no próximo login.)
python3 - "$UUID" "${OLD_UUIDS[@]}" <<'PY'
import ast, subprocess, sys
new, *old = sys.argv[1:]
def get(key):
    out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', key], text=True).strip()
    return [] if out.startswith('@as') else ast.literal_eval(out)
def put(key, values):
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', key, str(values)])
enabled = [u for u in get('enabled-extensions') if u not in old]
if new not in enabled:
    enabled.append(new)
put('enabled-extensions', enabled)
put('disabled-extensions', [u for u in get('disabled-extensions') if u != new and u not in old])
PY
gnome-extensions enable "$UUID" 2>/dev/null || \
    echo "O AeroTask fica ativo no próximo login (encerre a sessão e entre de novo)."
