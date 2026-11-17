#!/usr/bin/env bash
# Abre um GNOME Shell aninhado LIMPO, em inglês, só com o AeroTask — para tirar
# as capturas da página da extensão (extensions.gnome.org).
#
# Diferente do dev-nested.sh (que copia as SUAS configurações para testar
# compatibilidade), aqui tudo é novo e temporário:
#   - HOME próprio numa pasta temporária: nada dos seus apps, notificações,
#     histórico da área de transferência, agenda ou cidade aparece na imagem;
#   - idioma inglês (LANGUAGE=en_US): o Shell e o AeroTask em inglês;
#   - tema, ícones e papel de parede padrão do sistema.
#
# Uso:
#   ./scripts/store-session.sh [pasta-temporária]     (padrão: /tmp/aerotask-store)
# Em outro terminal, para conversar com o Shell dessa sessão:
#   DBUS_SESSION_BUS_ADDRESS="$(cat /tmp/aerotask-store/bus)" gdbus call --session \
#       --dest org.gnome.Shell --object-path /org/gnome/Shell \
#       --method org.gnome.Shell.Eval 'Main.panel.visible'
# Ao fechar a janela, apague a pasta temporária.

set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(realpath -m "${1:-/tmp/aerotask-store}")"
UUID=aerotask@viniciusbispo19
DEVTOOLS_UUID=aerotask-devtools@viniciusbispo19

./scripts/build.sh >/dev/null
gnome-extensions pack --force --out-dir=build "dev/$DEVTOOLS_UUID" >/dev/null

rm -rf "$ROOT/home"
mkdir -p "$ROOT/home"
export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US
# Liga o Eval/Screenshot do Shell (só a extensão auxiliar lê isso).
export AEROTASK_DEV=1

# Instala no HOME temporário (o install também compila o schema).
gnome-extensions install --force "build/$UUID.shell-extension.zip"
gnome-extensions install --force "build/$DEVTOOLS_UUID.shell-extension.zip"

export ROOT UUID DEVTOOLS_UUID
dbus-run-session -- bash -c '
    set -e
    gsettings set org.gnome.shell enabled-extensions "[\"$UUID\", \"$DEVTOOLS_UUID\"]"
    # Sem o tour de boas-vindas do primeiro login.
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    # Clima de uma cidade fixa: em "Automático" o Shell usaria a SUA
    # localização (Geoclue), e ela apareceria na imagem.
    S="gsettings --schemadir $XDG_DATA_HOME/gnome-shell/extensions/$UUID/schemas"
    $S set org.gnome.shell.extensions.aerotask weather-location-mode manual
    $S set org.gnome.shell.extensions.aerotask weather-manual-city "San Francisco"
    $S set org.gnome.shell.extensions.aerotask weather-manual-coords "(37.77, -122.42)"
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$ROOT/bus"
    exec gnome-shell --devkit --wayland --devkit-args="--monitor-size=1600x1000"
' > "$ROOT/shell.log" 2>&1
