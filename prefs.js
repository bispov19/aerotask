// SPDX-License-Identifier: GPL-3.0-or-later
// Janela de preferências do AeroTask (libadwaita).
//
// Importante: este arquivo NÃO roda dentro do GNOME Shell. Ele roda num
// processo separado (o app "Extensões"/gnome-extensions-app), com GTK 4 e
// libadwaita. Por isso aqui usamos Gtk/Adw (e não St/Clutter), e não
// podemos importar nada de "resource:///org/gnome/shell/ui/...".
//
// Todas as opções são gravadas no GSettings. A extensão (no Shell) escuta
// "changed::chave" e aplica a mudança na hora — sem reiniciar nada.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GWeather from 'gi://GWeather?version=4.0';
import Pango from 'gi://Pango';

import {
    ExtensionPreferences, gettext as _, pgettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SYSTEM_ICONS} from './lib/icons.js';
import {buildAboutPage, loadPrefsCss} from './prefs/aboutPage.js';

/** Páginas do pop-up do relógio, na ordem em que aparecem. */
const CLOCK_PAGES = ['calendar', 'weather', 'notifications', 'shelf', 'focus', 'reminders'];
/** Quantas cidades mostrar na busca (o resto: digite mais). */
const MAX_CITY_RESULTS = 40;

export default class AeroTaskPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        window.set_default_size(720, 760);
        window.search_enabled = true;

        window.add(this._generalPage());
        window.add(this._clockPage());
        window.add(this._alertsPage());
        window.add(this._appearancePage());
        window.add(this._menusPage());
        window.add(this._compatibilityPage());
        window.add(this._aboutPage(window));
    }

    /**
     * Deixa os ícones da pasta icons/ da extensão disponíveis por NOME no tema
     * do GTK (ex.: 'aerotask-symbolic'). Só assim um ícone de aba
     * (`icon_name`) é recolorido como simbólico no tema claro/escuro — o GTK
     * reconhece pelo sufixo "-symbolic" do arquivo. O caminho vem de
     * `this.dir` (onde a extensão está instalada), nunca de um caminho fixo.
     * Fazemos uma vez por display: o tema é compartilhado pelo processo.
     */
    _registerIcons() {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const iconsPath = this.dir.get_child('icons').get_path();
        if (!theme.get_search_path().includes(iconsPath))
            theme.add_search_path(iconsPath);
    }

    // ----------------------------------------------------------------------
    // Componentes reutilizáveis
    // ----------------------------------------------------------------------

    /** Linha com interruptor ligada direto a uma chave booleana. */
    _switch(key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /** Linha numérica (SpinRow) ligada a uma chave inteira. */
    _spin(key, title, subtitle, min, max, step = 1) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
        });
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /**
     * Lista de opções (ComboRow) ligada a uma chave de texto/enum.
     *
     * @param {string} key
     * @param {string} title
     * @param {[string, string][]} options - pares [valor, rótulo]
     * @param {string} [subtitle]
     * @param {Gio.Settings} [settings] - outro esquema (ex.: o do GNOME)
     */
    _combo(key, title, options, subtitle = '', settings = this._settings) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(options.map(([, label]) => label)),
        });
        const sync = () => {
            const index = options.findIndex(([value]) => value === settings.get_string(key));
            row.selected = Math.max(0, index);
        };
        sync();
        row.connect('notify::selected', () => {
            const value = options[row.selected]?.[0];
            if (value && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        settings.connect(`changed::${key}`, sync);
        return row;
    }

    /**
     * Linha de atalho de teclado: mostra o atalho atual e, ao clicar, abre
     * uma janelinha que "escuta" a próxima combinação de teclas.
     */
    _shortcut(key, title, subtitle = '') {
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            label.accelerator = this._settings.get_strv(key)[0] ?? '';
        };
        sync();
        this._settings.connect(`changed::${key}`, sync);

        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(label);
        row.connect('activated', () => this._captureShortcut(row, key));
        return row;
    }

    _captureShortcut(parent, key) {
        const content = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: _('Press the new shortcut'),
            description: _('Esc cancels · Backspace disables the shortcut'),
        });
        const dialog = new Adw.Dialog({
            title: _('Set Shortcut'),
            content_width: 420,
            child: content,
        });
        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && !mods) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && !mods) {
                this._settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Ignora teclas que são só modificadores (Ctrl sozinho etc.).
            if (!Gtk.accelerator_valid(keyval, mods) &&
                !(keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35))
                return Gdk.EVENT_STOP;
            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
            this._settings.set_strv(key, [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(parent);
    }

    // ----------------------------------------------------------------------
    // Páginas
    // ----------------------------------------------------------------------

    _generalPage() {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const bar = new Adw.PreferencesGroup({title: _('Menu Bar')});
        bar.add(this._switch('show-fallback-menus', _('Standard menus'),
            _('Show File, Edit, View and Window when the app has no menus of its own')));
        bar.add(this._switch('hide-activities', _('Hide the Activities button')));
        bar.add(this._switch('macos-control-center', _('macOS-style Control Center'),
            _('Quick Settings in blocks: connectivity, Focus, Display, Sound and Now Playing')));
        bar.add(this._switch('floating-panel', _('Floating bar'),
            _('Rounded corners and a small margin from the screen edges; it touches the edges while a window is maximized')));
        bar.add(this._switch('black-bar', _('Black bar'),
            _('The bar, the menus and the clock panel look like one piece')));
        const opacityRow = this._spin('black-bar-opacity', _('Black bar opacity (%)'),
            _('Below 100, the Blur my Shell blur shows through'), 50, 100, 5);
        this._settings.bind('black-bar', opacityRow, 'sensitive', Gio.SettingsBindFlags.GET);
        bar.add(opacityRow);
        bar.add(this._switch('farol-menus', _('Farol-style menus'),
            _('Menus come out of the bar as smoked glass, with a spring animation')));
        const clockRow = this._combo('clock-position', _('Clock position'), [
            ['center', _('Center')],
            ['right', _('Right (like macOS)')],
        ], _('Used with the GNOME clock'));
        // Com o relógio do AeroTask ligado, ele fica sempre no canto direito
        // (como no macOS): a opção fica cinza.
        this._settings.bind('farol-enabled', clockRow, 'sensitive',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        bar.add(clockRow);
        page.add(bar);

        // Os ícones à direita da barra, como no macOS.
        const status = new Adw.PreferencesGroup({title: _('Status Icons')});
        status.add(this._switch('status-classic-layout', _('Classic GNOME layout'),
            _('All icons in one button, with the volume icon, as before: no Control Center button and no Wi-Fi, Bluetooth or battery menus')));
        const statusRows = [
            this._switch('status-control-center-button', _('Control Center button'),
                _('Two switches next to the clock; a click opens the Control Center')),
            this._switch('status-wifi-bluetooth-menus', _('Wi-Fi and Bluetooth menus'),
                _('Each icon opens its own menu with networks or devices')),
            this._switch('status-battery-menu', _('Battery menu'),
                _('The battery icon opens its own menu with the power source, power mode and apps using significant energy')),
            this._switch('status-show-volume', _('Volume icon in the bar'),
                _('When off, sound is controlled from the Control Center')),
        ];
        // Com o layout clássico, as outras opções não valem: ficam cinza (mas
        // guardam a escolha, para quando o layout do macOS voltar).
        for (const row of statusRows) {
            this._settings.bind('status-classic-layout', row, 'sensitive',
                Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
            status.add(row);
        }
        page.add(status);

        page.add(this._trayGroup());

        const keys = new Adw.PreferencesGroup({title: _('Keyboard Shortcuts')});
        keys.add(this._shortcut('focus-bar-shortcut', _('Focus the menu bar'),
            _('Opens the app menu; use the arrow keys to navigate')));
        keys.add(this._shortcut('force-quit-shortcut', _('Force Quit')));
        page.add(keys);

        const monitors = new Adw.PreferencesGroup({title: _('Multiple Monitors')});
        monitors.add(new Adw.ActionRow({
            title: _('The menu bar is shown on the primary monitor'),
            subtitle: _('GNOME has a single top bar, on the primary monitor. Showing the menus on every monitor would need a second bar, which this extension does not create.'),
        }));
        page.add(monitors);
        return page;
    }

    /**
     * Grupo "Ícones de programas": a bandeja (AppIndicator/StatusNotifierItem).
     */
    _trayGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Program Icons'),
            description: _('Tray icons of programs such as Discord, Steam and Telegram (AppIndicator and StatusNotifierItem), with the menu of each program. Monochrome uses the symbolic icon when the theme has one; otherwise, grayscale.'),
        });

        // A extensão AppIndicator, se ativa, tem prioridade (as duas não
        // podem oferecer o mesmo serviço ao mesmo tempo).
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const conflict = new Adw.ActionRow({
            title: _('The “AppIndicator and KStatusNotifierItem Support” extension is active'),
            subtitle: _('It takes priority. Disable it in the Extensions app to use the icons of AeroTask.'),
            css_classes: ['warning'],
        });
        conflict.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
        const syncConflict = () => {
            const enabled = shell.get_strv('enabled-extensions').includes('appindicatorsupport@rgcjonas.gmail.com');
            const disabled = shell.get_boolean('disable-user-extensions');
            conflict.visible = enabled && !disabled;
        };
        syncConflict();
        shell.connect('changed::enabled-extensions', syncConflict);
        group.add(conflict);

        group.add(this._switch('tray-icons-enabled', _('Show program icons in the bar')));
        const style = this._combo('tray-icon-style', _('Icon style'), [
            ['monochrome', _('Monochrome (like macOS)')],
            ['original', _('Original colors')],
        ]);
        this._settings.bind('tray-icons-enabled', style, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(style);

        // Os programas já vistos, cada um com "mostrar".
        const programs = new Adw.ExpanderRow({
            title: _('Programs'),
            subtitle: _('Choose which icons appear; programs show up here after they run once'),
        });
        this._settings.bind('tray-icons-enabled', programs, 'sensitive', Gio.SettingsBindFlags.GET);
        let rows = [];
        const syncPrograms = () => {
            rows.forEach(row => programs.remove(row));
            rows = [];
            const hidden = this._settings.get_strv('tray-hidden-items');
            const known = this._settings.get_strv('tray-known-items');
            if (known.length === 0) {
                const empty = new Adw.ActionRow({title: _('No program seen yet')});
                rows.push(empty);
                programs.add_row(empty);
                return;
            }
            for (const entry of known) {
                const [key, title] = entry.split('\t');
                const row = new Adw.SwitchRow({
                    title: title || key,
                    subtitle: key,
                    active: !hidden.includes(key),
                });
                row.connect('notify::active', () => {
                    const current = this._settings.get_strv('tray-hidden-items').filter(k => k !== key);
                    this._settings.set_strv('tray-hidden-items', row.active ? current : [...current, key]);
                });
                rows.push(row);
                programs.add_row(row);
            }
        };
        syncPrograms();
        this._settings.connect('changed::tray-known-items', syncPrograms);
        group.add(programs);
        return group;
    }

    /**
     * Página "Relógio": o relógio do canto direito, as páginas do pop-up, a
     * temperatura e o Foco.
     */
    _clockPage() {
        const page = new Adw.PreferencesPage({
            title: _('Clock'),
            icon_name: 'preferences-system-time-symbolic',
        });

        const clock = new Adw.PreferencesGroup({
            title: _('Clock'),
            description: _('A macOS-style clock in the right corner; click it for the calendar, notifications, copied items, focus and reminders'),
        });
        clock.add(this._switch('farol-enabled', _('Use the AeroTask clock'),
            _('Replaces the GNOME clock')));

        // Formato da hora: é a MESMA chave das Configurações do GNOME
        // (org.gnome.desktop.interface). Mudar aqui muda lá, e vice-versa.
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        clock.add(this._combo('clock-format', _('Time format'), [
            ['24h', _('24-hour (13:30)')],
            ['12h', _('12-hour (1:30 PM)')],
        ], _('The same option as in GNOME Settings'), iface));
        const seconds = new Adw.SwitchRow({title: _('Show seconds')});
        iface.bind('clock-show-seconds', seconds, 'active', Gio.SettingsBindFlags.DEFAULT);
        clock.add(seconds);
        clock.add(this._switch('farol-show-date', _('Show the date beside the time')));
        page.add(clock);

        // O resto só existe com o relógio do AeroTask ligado.
        const needsClock = group => {
            this._settings.bind('farol-enabled', group, 'sensitive', Gio.SettingsBindFlags.GET);
            page.add(group);
        };

        const pages = new Adw.PreferencesGroup({
            title: _('Pages'),
            description: _('What appears when you click the clock'),
        });
        pages.add(this._pageSwitch('calendar', _('Calendar')));
        const worldClocks = this._switch('farol-world-clocks', _('World clocks on the Calendar page'),
            _('The cities from the Clocks app'));
        pages.add(worldClocks);
        pages.add(this._pageSwitch('notifications', _('Notifications')));
        pages.add(this._pageSwitch('shelf', _('Shelf'), _('Clipboard history and the file tray')));
        pages.add(this._pageSwitch('focus', _('Focus')));
        pages.add(this._pageSwitch('reminders', _('Reminders')));
        pages.add(this._switch('app-usage-enabled', _('App usage'),
            _('Records how long each app is in use; stored only on this computer')));
        const syncWorldClocks = () => {
            worldClocks.sensitive = this._settings.get_strv('farol-pages').includes('calendar');
        };
        syncWorldClocks();
        this._settings.connect('changed::farol-pages', syncWorldClocks);
        needsClock(pages);

        const weather = new Adw.PreferencesGroup({
            title: _('Weather'),
            description: _('From GNOME’s weather service (MET Norway); only the city’s approximate position is sent. “Automatic” uses the location of the GNOME Weather settings.'),
        });
        weather.add(this._switch('weather-enabled', _('Show the temperature beside the clock')));
        const weatherRows = [
            this._combo('weather-unit', _('Unit'), [
                ['celsius', _('Celsius (°C)')],
                ['fahrenheit', _('Fahrenheit (°F)')],
            ]),
            this._combo('weather-location-mode', _('Location'), [
                // Contexto próprio: em pt-BR é "Automática" (a localização),
                // e não "Automático" (o ícone).
                ['auto', pgettext('weather location', 'Automatic')],
                ['manual', _('Chosen city')],
            ]),
            // Escolher uma cidade já muda a localização para "Cidade escolhida".
            this._cityRow(),
        ];
        weatherRows.forEach(row => {
            this._settings.bind('weather-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            weather.add(row);
        });

        // Previsão: a página Clima do pop-up (aba própria, aberta quando você
        // quiser — também clicando no tempo no topo do pop-up).
        weather.add(this._pageSwitch('weather', _('Weather page'),
            _('Today’s forecast and the next days, in the clock pop-up'), 'weather-enabled'));
        const hourly = this._switch('weather-show-hourly', _('Today, hour by hour'));
        const showDays = this._switch('weather-show-days', _('Next days'),
            _('Highest and lowest temperature and the weather of each day'));
        const dayCount = this._spin('weather-forecast-days', _('How many days'),
            _('The forecast reaches about 9 days ahead'), 2, 9);
        weather.add(hourly);
        weather.add(showDays);
        weather.add(dayCount);
        const syncForecast = () => {
            const on = this._settings.get_boolean('weather-enabled') &&
                this._settings.get_strv('farol-pages').includes('weather');
            hourly.sensitive = on;
            showDays.sensitive = on;
            dayCount.sensitive = on && this._settings.get_boolean('weather-show-days');
        };
        syncForecast();
        for (const key of ['weather-enabled', 'farol-pages', 'weather-show-days'])
            this._settings.connect(`changed::${key}`, syncForecast);
        needsClock(weather);

        const shelf = new Adw.PreferencesGroup({
            title: _('Shelf'),
            description: _('Copied texts, links, images and files. Passwords copied from password managers are never saved.'),
        });
        shelf.add(this._shortcut('clipboard-shortcut', _('Open the clipboard history')));
        shelf.add(this._switch('clipboard-paste-on-select', _('Paste right away'),
            _('Choosing an item also pastes it into the app (Ctrl+Shift+V in terminals)')));
        shelf.add(this._spin('clipboard-history-size', _('Items to keep'),
            _('Pinned items are not counted'), 10, 200, 10));
        shelf.add(this._switch('clipboard-save-history', _('Keep between sessions'),
            _('Turned off, the history lives only in memory and is gone when you log out')));
        needsClock(shelf);

        const focus = new Adw.PreferencesGroup({
            title: _('Focus'),
            description: _('Also adjustable on the Focus page, with − and +'),
        });
        focus.add(this._spin('focus-work-minutes', _('Focus length'), _('In minutes'), 1, 180));
        focus.add(this._spin('focus-break-minutes', _('Break length'), _('In minutes'), 1, 60));
        focus.add(this._switch('focus-dnd', _('Do Not Disturb while focusing'),
            _('Turned off again at the end, if it was the focus that turned it on')));
        needsClock(focus);
        return page;
    }

    /**
     * Interruptor de uma página do pop-up do relógio. A lista "farol-pages"
     * fica sempre na ordem de CLOCK_PAGES. A última página ligada não pode ser
     * desligada (senão o clique no relógio abriria um balão vazio).
     */
    _pageSwitch(id, title, subtitle = '', requires = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        const sync = () => {
            const pages = this._settings.get_strv('farol-pages');
            row.active = pages.includes(id);
            row.sensitive = !(row.active && pages.length === 1) &&
                (!requires || this._settings.get_boolean(requires));
        };
        row.connect('notify::active', () => {
            const pages = this._settings.get_strv('farol-pages');
            if (row.active === pages.includes(id))
                return;
            this._settings.set_strv('farol-pages',
                CLOCK_PAGES.filter(p => (p === id ? row.active : pages.includes(p))));
        });
        sync();
        this._settings.connect('changed::farol-pages', sync);
        if (requires)
            this._settings.connect(`changed::${requires}`, sync);
        return row;
    }

    /** Linha "Cidade": mostra a escolhida; clicar abre a busca. */
    _cityRow() {
        const row = new Adw.ActionRow({title: _('City'), activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        const sync = () => {
            row.subtitle = this._settings.get_string('weather-manual-city') || _('None chosen');
        };
        sync();
        this._settings.connect('changed::weather-manual-city', sync);
        row.connect('activated', () => this._chooseCity(row));
        return row;
    }

    /**
     * Janelinha de busca de cidade. A lista vem do próprio libgweather (a base
     * de cidades do GNOME, uns 4 mil lugares, já com nomes em pt-BR) — sem
     * internet e sem serviço de busca externo.
     */
    _chooseCity(parent) {
        const search = new Gtk.SearchEntry({
            placeholder_text: _('Search for a city…'),
            hexpand: true,
        });
        const list = new Gtk.ListBox({
            css_classes: ['boxed-list'],
            selection_mode: Gtk.SelectionMode.NONE,
            valign: Gtk.Align.START,
        });
        const hint = new Gtk.Label({
            label: _('Type at least two letters'),
            css_classes: ['dim-label'],
            margin_top: 24,
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        box.append(search);
        box.append(hint);
        box.append(list);
        const toolbar = new Adw.ToolbarView({
            content: new Gtk.ScrolledWindow({
                child: box,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                vexpand: true,
            }),
        });
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({
            title: _('Choose a City'),
            content_width: 440,
            content_height: 560,
            child: toolbar,
        });

        const cities = this._cities();
        search.connect('search-changed', () => {
            list.remove_all();
            const query = normalize(search.text.trim());
            const results = query.length < 2 ? []
                : cities.filter(c => c.key.includes(query))
                    // Quem COMEÇA com o texto vem primeiro.
                    .sort((a, b) => Number(!a.key.startsWith(query)) - Number(!b.key.startsWith(query)) ||
                        a.name.localeCompare(b.name))
                    .slice(0, MAX_CITY_RESULTS);
            hint.label = query.length < 2 ? _('Type at least two letters') : _('No city found');
            hint.visible = results.length === 0;
            list.visible = results.length > 0;
            for (const city of results) {
                const row = new Adw.ActionRow({
                    title: city.name,
                    subtitle: city.region,
                    activatable: true,
                });
                row.connect('activated', () => {
                    this._settings.set_string('weather-manual-city', city.name);
                    this._settings.set_value('weather-manual-coords',
                        new GLib.Variant('(dd)', city.coords));
                    this._settings.set_string('weather-location-mode', 'manual');
                    dialog.close();
                });
                list.append(row);
            }
        });
        // Enter escolhe o primeiro resultado.
        search.connect('activate', () => list.get_row_at_index(0)?.activate());
        list.visible = false;
        dialog.present(parent);
        search.grab_focus();
    }

    /** Todas as cidades do libgweather (lidas uma vez, ~30 ms). */
    _cities() {
        if (this._cityCache)
            return this._cityCache;
        const cities = [];
        const walk = location => {
            let child = null;
            while ((child = location.next_child(child))) {
                if (child.get_level() !== GWeather.LocationLevel.CITY) {
                    walk(child);
                    continue;
                }
                if (!child.has_coords())
                    continue;
                const name = child.get_name();
                const parent = child.get_parent();
                const state = parent?.get_level() === GWeather.LocationLevel.ADM1 ? parent.get_name() : '';
                const country = child.get_country_name() ?? '';
                cities.push({
                    name,
                    region: [state, country].filter(Boolean).join(', '),
                    coords: child.get_coords(),
                    key: normalize(name),
                });
            }
        };
        walk(GWeather.Location.get_world());
        this._cityCache = cities;
        return cities;
    }

    /**
     * Página "Alertas": o HUD do centro da tela (volume, brilho, Caps Lock…),
     * as mensagens que saem do relógio (bateria, rede…) e o ícone da bateria.
     */
    _alertsPage() {
        const page = new Adw.PreferencesPage({
            title: _('Alerts'),
            icon_name: 'preferences-system-notifications-symbolic',
        });
        // Os alertas saem do relógio do AeroTask: sem ele, ficam cinza.
        const needsClock = group => {
            this._settings.bind('farol-enabled', group, 'sensitive', Gio.SettingsBindFlags.GET);
            page.add(group);
        };

        // O HUD fica no centro da tela: não depende do relógio. Um só padrão
        // para todos os avisos (o do macOS).
        const hud = new Adw.PreferencesGroup({
            title: _('Center of the Screen'),
            description: _('A macOS-style HUD in place of GNOME’s pop-up. Volume and brightness show for any change (keys, the Quick Settings controls, apps…)'),
        });
        hud.add(this._switch('alert-volume', _('Volume')));
        hud.add(this._switch('alert-brightness', _('Brightness'),
            _('Screen and keyboard backlight')));
        hud.add(this._switch('alert-caps-lock', _('Caps Lock')));
        hud.add(this._switch('alert-quick-settings', _('Quick Settings Buttons'),
            _('Wi-Fi, Bluetooth, Power Mode, Night Light, Keep Screen On…')));
        hud.add(this._switch('volume-hud-show-percentage', _('Show the percentage'),
            _('“65%” below the volume and brightness bar')));
        page.add(hud);

        // O ícone da bateria NÃO depende do relógio do AeroTask.
        const battery = new Adw.PreferencesGroup({title: _('Battery')});
        battery.add(this._switch('battery-icon-enabled', _('MacBook-style battery icon'),
            _('Replaces the GNOME battery icon in the top bar')));
        const percent = this._switch('battery-show-percentage', _('Show the battery percentage'),
            _('Inside the battery icon'));
        this._settings.bind('battery-icon-enabled', percent, 'sensitive', Gio.SettingsBindFlags.GET);
        battery.add(percent);
        page.add(battery);

        const batteryAlerts = new Adw.PreferencesGroup({title: _('Battery Alerts')});
        batteryAlerts.add(this._switch('alert-battery-low', _('Low battery'),
            _('Once at 20% and once at 10%; the 10% alert shows even in Do Not Disturb')));
        batteryAlerts.add(this._switch('alert-battery-full', _('Battery charged')));
        needsClock(batteryAlerts);

        const other = new Adw.PreferencesGroup({
            title: _('Other Alerts'),
            description: _('Only important alerts: they wait for full screen to end and are held back in Do Not Disturb'),
        });
        other.add(this._switch('alert-bluetooth', _('Bluetooth devices'),
            _('When a device connects or disconnects')));
        other.add(this._switch('alert-network', _('No internet connection'),
            _('After 5 seconds offline, and again when it comes back')));
        other.add(this._switch('alert-events', _('Calendar events'),
            _('With a “Join” button for Meet, Zoom, Teams and Webex')));
        const minutes = this._spin('event-reminder-minutes', _('Remind me before the event'),
            _('In minutes'), 1, 60);
        this._settings.bind('alert-events', minutes, 'sensitive', Gio.SettingsBindFlags.GET);
        other.add(minutes);
        needsClock(other);
        return page;
    }

    _appearancePage() {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        // --- Ícone do sistema: grade com prévia de cada logo ---
        const iconGroup = new Adw.PreferencesGroup({
            title: _('System Icon'),
            description: _('The logo shown in place of the Apple menu'),
        });
        iconGroup.add(this._iconPicker());
        iconGroup.add(this._spin('icon-size', _('Icon size'), _('In pixels'), 14, 22));
        iconGroup.add(this._combo('icon-style', _('Icon style'), [
            ['symbolic', _('Symbolic (follows the theme color)')],
            ['color', _('Color')],
        ]));
        page.add(iconGroup);

        const bar = new Adw.PreferencesGroup({title: _('Menu Bar')});
        bar.add(this._switch('bold-app-name', _('App name in bold')));
        bar.add(this._spin('title-spacing', _('Title spacing'),
            _('Space on each side of a menu title, in pixels'), 2, 16));
        page.add(bar);

        const menus = new Adw.PreferencesGroup({title: _('Drop-down Menus')});
        menus.add(this._combo('shortcut-style', _('Shortcut style'), [
            ['text', _('Text (Ctrl+C)')],
            ['symbols', _('Mac symbols (⌃C)')],
        ]));
        menus.add(this._spin('menu-opacity', _('Opacity'), _('In percent'), 50, 100, 2));
        menus.add(this._spin('menu-radius', _('Corner radius'), _('In pixels'), 0, 16));
        page.add(menus);
        return page;
    }

    /** Grade de botões com o logo de cada distro + Automático + Personalizado. */
    _iconPicker() {
        const iconsDir = this.dir.get_child('icons');
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 8,
            min_children_per_line: 4,
            column_spacing: 6,
            row_spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            homogeneous: true,
        });

        const buttons = new Map();
        const addButton = (id, name, image) => {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
            box.append(image);
            box.append(new Gtk.Label({label: name, css_classes: ['caption'],
                ellipsize: Pango.EllipsizeMode.END}));
            const button = new Gtk.ToggleButton({
                child: box,
                tooltip_text: name,
                css_classes: ['flat'],
            });
            button.connect('clicked', () => {
                if (id === 'custom')
                    this._chooseCustomIcon(flow);
                else
                    this._settings.set_string('system-icon', id);
                sync();
            });
            buttons.set(id, button);
            flow.append(button);
        };

        for (const [id, info] of Object.entries(SYSTEM_ICONS)) {
            const file = iconsDir.get_child(`${id}-symbolic.svg`);
            addButton(id, info.name, new Gtk.Image({
                gicon: new Gio.FileIcon({file}),
                pixel_size: 28,
            }));
        }
        addButton('auto', _('Automatic'), new Gtk.Image({
            icon_name: 'computer-symbolic', pixel_size: 28,
        }));
        addButton('custom', _('Custom…'), new Gtk.Image({
            icon_name: 'document-open-symbolic', pixel_size: 28,
        }));

        const sync = () => {
            const current = this._settings.get_string('system-icon');
            for (const [id, button] of buttons)
                button.active = id === current;
        };
        sync();
        this._settings.connect('changed::system-icon', sync);

        const row = new Adw.PreferencesRow({activatable: false, child: flow});
        return row;
    }

    async _chooseCustomIcon(parentWidget) {
        const filter = new Gtk.FileFilter({name: _('Images (SVG, PNG)')});
        filter.add_mime_type('image/svg+xml');
        filter.add_mime_type('image/png');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({
            title: _('Choose an Icon'),
            filters,
            default_filter: filter,
        });
        try {
            const file = await dialog.open(parentWidget.get_root(), null);
            this._settings.set_string('custom-icon-path', file.get_path());
            this._settings.set_string('system-icon', 'custom');
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                console.warn(`[AeroTask] escolhendo ícone: ${e.message}`);
        }
    }

    _menusPage() {
        const page = new Adw.PreferencesPage({
            title: _('Menus'),
            icon_name: 'view-list-symbolic',
        });

        const std = new Adw.PreferencesGroup({
            title: _('Standard Menus'),
            description: _('Used when the app does not export menus of its own'),
        });
        std.add(this._switch('show-file-menu', _('File')));
        std.add(this._switch('show-edit-menu', _('Edit')));
        std.add(this._switch('show-view-menu', _('View')));
        std.add(this._switch('show-window-menu', _('Window')));
        std.add(this._switch('show-help-menu', _('Help')));
        std.add(this._switch('help-search', _('Search field in the Help menu'),
            _('Searches every menu item of the current app')));
        page.add(std);

        const sys = new Adw.PreferencesGroup({title: _('System Menu')});
        sys.add(this._switch('system-menu-show-software', _('Software Center…')));
        sys.add(this._switch('system-menu-show-recent', _('Recent Items')));
        sys.add(this._switch('system-menu-show-force-quit', _('Force Quit…')));
        sys.add(this._switch('system-menu-show-power', _('Suspend, Restart and Shut Down')));
        page.add(sys);
        return page;
    }

    _compatibilityPage() {
        const page = new Adw.PreferencesPage({
            title: _('Compatibility'),
            icon_name: 'applications-engineering-symbolic',
        });

        const dbus = new Adw.PreferencesGroup({title: _('Apps That Use DBusMenu')});
        dbus.add(this._switch('enable-registrar', _('Read menus from Qt, Electron and similar apps'),
            _('Provides the com.canonical.AppMenu.Registrar service. Works with apps running through XWayland; apps that were already open need to be restarted.')));
        page.add(dbus);

        page.add(this._ignoredAppsGroup());

        const debug = new Adw.PreferencesGroup({title: _('Troubleshooting')});
        debug.add(this._switch('debug', _('Debug mode'),
            _('Writes details to the system journal (journalctl)')));
        page.add(debug);
        return page;
    }

    /** Lista editável de apps que usam só os menus padrão. */
    _ignoredAppsGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Ignored Apps'),
            description: _('These apps always use the standard menus. Use the app ID (e.g. org.gnome.TextEditor) or the window class (WM_CLASS).'),
        });

        const entry = new Adw.EntryRow({
            title: _('Add app'),
            show_apply_button: true,
        });
        entry.connect('apply', () => {
            const value = entry.text.trim();
            const list = this._settings.get_strv('ignored-apps');
            if (value && !list.includes(value))
                this._settings.set_strv('ignored-apps', [...list, value]);
            entry.text = '';
        });
        group.add(entry);

        let rows = [];
        const sync = () => {
            for (const row of rows)
                group.remove(row);
            rows = this._settings.get_strv('ignored-apps').map(app => {
                const row = new Adw.ActionRow({title: app});
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    this._settings.set_strv('ignored-apps',
                        this._settings.get_strv('ignored-apps').filter(a => a !== app));
                });
                row.add_suffix(remove);
                group.add(row);
                return row;
            });
        };
        sync();
        this._settings.connect('changed::ignored-apps', sync);
        return group;
    }

    /**
     * Aba "Sobre". O layout fica em prefs/aboutPage.js; aqui só os DADOS.
     * Versão e endereço vêm do metadata.json (a mesma fonte que o site de
     * extensões usa): atualizar a versão lá já atualiza esta tela.
     */
    _aboutPage(window) {
        this._registerIcons();
        loadPrefsCss(this.dir, window);
        return buildAboutPage({
            logo: this.dir.get_child('icons').get_child('aerotask-mark.svg'),
            name: 'AeroTask',
            description: _('A glassy top bar for GNOME with global app menus, a clock panel, a tile-style control center and a clean tray.'),
            version: String(this.metadata['version-name'] ?? this.metadata.version ?? '—'),
            // O arquivo LICENSE é a GPL v3; os arquivos dizem "or-later".
            license: _('GPL-3.0 or later'),
            url: this.metadata.url ?? 'https://github.com/viniciusbispo19',
            author: 'Vini',
            authorRole: _('Web Developer · Author and maintainer'),
            features: _('Global menu bar with the app’s own menus · Menu search in Help · System menu · Clock panel with calendar, weather, notifications, Shelf, focus timer and reminders · Tile-style control center · Status icons with their own menus · On-screen HUD · Monochrome tray icons · Floating glass bar'),
            notice: _('AeroTask is an independent, open-source project.'),
        });
    }
}

/** Para buscar sem ligar para acentos e maiúsculas: "São Paulo" → "sao paulo". */
function normalize(text) {
    return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
