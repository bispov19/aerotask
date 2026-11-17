#!/usr/bin/env python3
"""Ativa extensões no dconf em uso (respeita DCONF_PROFILE).

Uso interno do scripts/dev-nested.sh: roda DENTRO do barramento da sessão
aninhada, antes do Shell subir. Também desliga a Global Menu for GNOME, para
não haver conflito com o AeroTask.

Uso: dconf-enable-extensions.py UUID [UUID...] [--disable UUID...]
"""
import ast
import subprocess
import sys


def gsettings(*args):
    return subprocess.check_output(['gsettings', *args], text=True, timeout=10).strip()


def get_list(key):
    out = gsettings('get', 'org.gnome.shell', key)
    return [] if out.startswith('@as') else ast.literal_eval(out)


def set_list(key, values):
    gsettings('set', 'org.gnome.shell', key, str(values))


args = sys.argv[1:]
# Depois de "--disable": extensões a desligar (ex.: versões antigas do projeto).
off = args[args.index('--disable') + 1:] if '--disable' in args else []
ours = args[:args.index('--disable')] if '--disable' in args else args
off.append('globalmenu@ShiroOSL.github.io')
enabled = [u for u in get_list('enabled-extensions') if u not in off]
set_list('enabled-extensions', enabled + [u for u in ours if u not in enabled])
set_list('disabled-extensions', [u for u in get_list('disabled-extensions') if u not in ours])
gsettings('set', 'org.gnome.shell', 'disable-user-extensions', 'false')
