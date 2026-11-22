// SPDX-License-Identifier: GPL-3.0-or-later
// Aba "Sobre" das preferências do AeroTask.
//
// Por que um módulo separado? O prefs.js já tem ~900 linhas com as outras
// abas. Aqui fica SÓ a montagem da tela (o "como mostrar"); os dados (nome,
// versão, link, autor…) chegam prontos num objeto montado no prefs.js (o "o
// que mostrar"). Assim, trocar um texto não exige mexer no layout, e mudar o
// layout não arrisca quebrar as outras abas.
//
// Roda no processo das preferências (GTK 4 + libadwaita), não no Shell: por
// isso o estilo vem de prefs/prefs.css (o stylesheet.css só vale no Shell).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Carrega prefs/prefs.css para a tela inteira do processo das preferências.
 * O provedor é retirado quando a janela fecha: o app Extensões continua
 * aberto e chamaria isto de novo na próxima vez (somaria cópias do CSS).
 *
 * @param {Gio.File} dir - pasta da extensão (this.dir)
 * @param {Gtk.Window} window - janela das preferências
 */
export function loadPrefsCss(dir, window) {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    provider.load_from_file(dir.get_child('prefs').get_child('prefs.css'));
    Gtk.StyleContext.add_provider_for_display(display, provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    window.connect('close-request', () => {
        Gtk.StyleContext.remove_provider_for_display(display, provider);
        return false; // deixa a janela fechar normalmente
    });
}

/** Linha de informação (não clicável) com ícone à esquerda. */
function infoRow(iconName, title, subtitle) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
        // 0 = sem limite de linhas: o texto quebra em vez de virar "…".
        subtitle_lines: 0,
        // Títulos/subtítulos do Adw aceitam marcação Pango; nossos textos são
        // puros (um "&" quebraria a marcação).
        use_markup: false,
    });
    row.add_prefix(new Gtk.Image({icon_name: iconName}));
    return row;
}

/**
 * Monta a aba "Sobre".
 *
 * @param {object} info
 * @param {Gio.File} info.logo - arquivo do símbolo (aerotask-mark.svg)
 * @param {string} info.name - nome do projeto
 * @param {string} info.description - frase curta
 * @param {string} info.version - ex.: "1.0.0"
 * @param {string} info.license - ex.: "GPL-3.0 ou posterior"
 * @param {string} info.url - endereço do repositório
 * @param {string} info.author - nome do autor
 * @param {string} info.authorRole - função do autor
 * @param {string} info.features - principais recursos, separados por " · "
 * @param {string} info.notice - aviso final
 * @returns {Adw.PreferencesPage}
 */
export function buildAboutPage(info) {
    const page = new Adw.PreferencesPage({
        title: _('About'),
        icon_name: 'aerotask-symbolic',
    });

    // --- 1. Card principal ---------------------------------------------
    // Um PreferencesGroup sem título só serve de "trilho" (mesma largura e
    // margens dos outros grupos); o visual do card vem da classe about-hero.
    const heroGroup = new Adw.PreferencesGroup();
    const hero = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ['about-hero'],
    });
    hero.append(new Gtk.Image({
        gicon: new Gio.FileIcon({file: info.logo}),
        pixel_size: 140,
        margin_bottom: 6,
    }));
    hero.append(new Gtk.Label({label: info.name, css_classes: ['title-1']}));
    hero.append(new Gtk.Label({
        label: info.description,
        css_classes: ['dim-label'],
        wrap: true,
        justify: Gtk.Justification.CENTER,
        max_width_chars: 48,
    }));
    hero.append(new Gtk.Label({
        // Dois espaços em volta do "•" para respirar, como no pedido.
        // replace em vez de .format(): o format() é um acréscimo do Shell e
        // não há garantia de que exista no processo das preferências.
        label: `${_('Version %s').replace('%s', info.version)}  •  ${info.license}`,
        css_classes: ['caption', 'dim-label'],
    }));
    heroGroup.add(hero);
    page.add(heroGroup);

    // --- 2. Links ---------------------------------------------------------
    const links = new Adw.PreferencesGroup({title: _('Links')});
    const repo = new Adw.ActionRow({
        title: _('GitHub repository'),
        subtitle: info.url.replace(/^https?:\/\//, ''),
        activatable: true,
        use_markup: false,
    });
    repo.add_prefix(new Gtk.Image({icon_name: 'web-browser-symbolic'}));
    repo.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    repo.connect('activated', () => {
        // UriLauncher passa pelo portal quando existe (Flatpak, sandbox) e
        // abre o navegador padrão; o pai faz a janela do navegador vir à frente.
        new Gtk.UriLauncher({uri: info.url}).launch(repo.get_root(), null, null);
    });
    links.add(repo);
    page.add(links);

    // --- 3. Créditos -----------------------------------------------------
    const credits = new Adw.PreferencesGroup({title: _('Credits')});
    credits.add(infoRow('avatar-default-symbolic', info.author, info.authorRole));
    credits.add(infoRow('starred-symbolic', _('Features'), info.features));
    credits.add(infoRow('dialog-information-symbolic', _('Notice'), info.notice));
    page.add(credits);

    return page;
}
