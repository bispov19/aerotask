# shellcheck shell=bash
# MIGRAÇÃO: o UUID anterior do AeroTask (com o nome de usuário antigo do
# GitHub). As configurações NÃO mudam de lugar: o caminho no dconf
# (/org/gnome/shell/extensions/aerotask/) não tem o nome de usuário. Usado por:
#   - scripts/install.sh: desativa e remove a versão com o UUID antigo e a
#     troca pela nova na lista de extensões ativas;
#   - scripts/dev-nested.sh: desliga a versão antiga na sessão de teste.
OLD_UUIDS=(aerotask@viniciusbispo19 aerotask-devtools@viniciusbispo19)
# Caminhos antigos de configurações (nenhum: o caminho continua o mesmo).
OLD_PATHS=()
