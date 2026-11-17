# shellcheck shell=bash
# MIGRAÇÃO: os nomes anteriores do projeto (o único lugar com eles, junto
# da pasta de dados em lib/farol/services/storage.js). Usado por:
#   - scripts/install.sh: copia as configurações e remove as versões antigas;
#   - scripts/dev-nested.sh: desliga as versões antigas na sessão de teste.
OLD_UUIDS=(aero-menu-global@viniciusbispo19 aero-menu-global-devtools@viniciusbispo19 luma-menu@viniciusbispo19)
OLD_PATHS=(/org/gnome/shell/extensions/aero-menu-global/ /org/gnome/shell/extensions/luma-menu/)
