// SPDX-License-Identifier: GPL-3.0-or-later
// Aero Menu Global — ponto de entrada da extensão.
//
// O GNOME Shell importa este arquivo e cria UMA instância da classe exportada
// como `default`. Depois ele chama enable() e disable() quantas vezes quiser.
//
// Regra de ouro do extensions.gnome.org: NADA é criado no construtor ou no
// nível do módulo; tudo nasce no enable() e tudo é destruído no disable().
//
// Por que "session-modes": ["user", "unlock-dialog"] no metadata.json?
// Por padrão o GNOME DESATIVA as extensões ao bloquear a tela. Isso destruiria
// o nosso Registrar (camada B), e os apps Qt/Electron — que só registram seus
// menus quando abrem — perderiam os menus a cada bloqueio. Então, durante o
// bloqueio, a extensão continua ativa, mas mantém VIVO APENAS o Registrar
// (um serviço D-Bus, sem nenhuma interface na tela). A barra, os atalhos e
// as mudanças no painel são destruídos ao bloquear e recriados ao desbloquear.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {BarLook} from './lib/island/barLook.js';
import {BatteryIndicator} from './lib/island/batteryIcon.js';
import {Island} from './lib/island/island.js';
import {AppUsage} from './lib/island/services/appUsage.js';
import {ClipboardHistory} from './lib/island/services/clipboard.js';
import {FileTray} from './lib/island/services/fileTray.js';
import {FocusTimer} from './lib/island/services/focus.js';
import {ReminderStore} from './lib/island/services/reminders.js';
import {FloatingPanel} from './lib/floatingPanel.js';
import {MenuBar} from './lib/menuBar.js';
import {OsdOverride} from './lib/osdOverride.js';
import {PanelLayout} from './lib/panelLayout.js';
import {Registrar} from './lib/sources/registrar.js';
import {TrayIcons} from './lib/tray/trayIcons.js';
import {StatusNotifierWatcher} from './lib/tray/watcher.js';
import {VolumeHud} from './lib/volumeHud.js';
import {logError, setDebug} from './lib/util.js';

/** A extensão "AppIndicator and KStatusNotifierItem Support". */
const APPINDICATOR_UUID = 'appindicatorsupport@rgcjonas.gmail.com';

export default class AeroMenuGlobalExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        setDebug(this._settings.get_boolean('debug'));
        this._settings.connectObject(
            'changed::debug', () => setDebug(this._settings.get_boolean('debug')),
            'changed::enable-registrar', () => this._syncRegistrar(),
            'changed::island-enabled', () => this._syncIsland(),
            'changed::app-usage-enabled', () => this._syncUsage(),
            // O visual dos menus é decidido quando eles são criados (por causa
            // do Blur my Shell): ligar/desligar recria a barra.
            'changed::island-menus', () => {
                if (this._menuBar) {
                    this._destroyUi();
                    this._createUi();
                }
            },
            this);

        this._registrar = null;
        this._syncRegistrar();

        // Ícones de bandeja (AppIndicator/StatusNotifierItem). O serviço vive
        // aqui (sobrevive ao bloqueio); os botões são da interface. Se a
        // extensão AppIndicator estiver ativa, ela é quem cuida: cedemos a
        // vez — e assumimos quando ela for desativada.
        this._trayWatcher = null;
        this._settings.connectObject('changed::tray-icons-enabled', () => this._syncTrayWatcher(), this);
        Main.extensionManager.connectObject('extension-state-changed', (_m, extension) => {
            if (extension.uuid === APPINDICATOR_UUID)
                this._syncTrayWatcher();
        }, this);
        this._syncTrayWatcher();

        // Timer de foco e lembretes vivem AQUI (e não no relógio): a interface
        // da barra é destruída ao bloquear a tela, mas o Pomodoro continua
        // contando e a lista continua a mesma.
        this._focusTimer = new FocusTimer(this._settings);
        this._reminders = new ReminderStore();
        // Pelo mesmo motivo: o histórico da área de transferência, a bandeja
        // de arquivos e o tempo de uso de apps (este só se ligado).
        this._clipboard = new ClipboardHistory(this._settings);
        this._fileTray = new FileTray(this.path);
        this._usage = null;
        this._syncUsage();

        // Bloqueio/desbloqueio de tela chegam como mudança de "modo de sessão".
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._destroyUi();
        this._registrar?.destroy();
        this._registrar = null;
        Main.extensionManager.disconnectObject(this);
        this._trayWatcher?.destroy();
        this._trayWatcher = null;
        this._focusTimer?.destroy();
        this._focusTimer = null;
        this._reminders?.destroy();
        this._reminders = null;
        this._clipboard?.destroy();
        this._clipboard = null;
        this._fileTray?.destroy();
        this._fileTray = null;
        this._usage?.destroy();
        this._usage = null;
        this._settings?.disconnectObject(this);
        this._settings = null;
        setDebug(false);
    }

    /**
     * A extensão AppIndicator está ligada (ou ligando)? O GNOME avisa
     * "ligando" ANTES de chamar o enable() dela: desligamos o nosso serviço a
     * tempo de ela pegar o nome no barramento sem erro.
     */
    get _appIndicatorActive() {
        const state = Main.extensionManager.lookup(APPINDICATOR_UUID)?.state;
        return state === ExtensionState.ACTIVE || state === ExtensionState.ACTIVATING;
    }

    _syncTrayWatcher() {
        const wanted = this._settings.get_boolean('tray-icons-enabled') && !this._appIndicatorActive;
        if (wanted && !this._trayWatcher) {
            try {
                this._trayWatcher = new StatusNotifierWatcher();
            } catch (e) {
                logError(e, 'ícones de bandeja indisponíveis (outro programa já oferece o serviço)');
                this._trayWatcher = null;
            }
        } else if (!wanted && this._trayWatcher) {
            this._trayWatcher.destroy();
            this._trayWatcher = null;
        } else {
            return;
        }
        this._tray?.setWatcher(this._trayWatcher);
    }

    /** Liga/desliga o Registrar (camada B) conforme a preferência, ao vivo. */
    _syncRegistrar() {
        const wanted = this._settings.get_boolean('enable-registrar');
        if (wanted && !this._registrar) {
            // Outro programa (ou uma cópia antiga desta extensão, ainda ativa)
            // já oferece o Registrar neste processo: seguimos sem a camada B
            // em vez de deixar a extensão inteira falhar.
            try {
                this._registrar = new Registrar();
            } catch (e) {
                logError(e, 'Registrar indisponível (outro programa já o oferece); menus de apps Qt/Electron desligados');
                this._registrar = null;
            }
        } else if (!wanted && this._registrar) {
            this._registrar.destroy();
            this._registrar = null;
        }
        this._menuBar?.setRegistrar(this._registrar);
    }

    _syncSessionMode() {
        if (Main.sessionMode.isLocked)
            this._destroyUi();
        else
            this._createUi();
    }

    _createUi() {
        if (this._menuBar)
            return;

        // A cor da barra (preto fumê ou a do tema), usada pelos menus e pelo
        // painel do relógio para "sair da barra" com o mesmo visual dela.
        this._barLook = new BarLook(this._settings);

        // A barra é um único ator (St.BoxLayout) com todos os títulos dentro.
        this._menuBar = new MenuBar(this, this._registrar, this._barLook);

        // `_leftBox` é a caixa da esquerda do painel. O "_" indica que é
        // interno do Shell (não há API pública para inserir um ator qualquer
        // ali — `addToStatusArea` só aceita UM PanelMenu.Button por chamada).
        // Quase todas as extensões de painel usam essa caixa; o risco é ela
        // mudar de nome numa versão futura, por isso só declaramos suporte ao
        // GNOME 51 no metadata.json.
        Main.panel._leftBox.insert_child_at_index(this._menuBar, 0);

        // Esconde o botão Atividades / move o relógio (conforme preferências).
        this._panelLayout = new PanelLayout(this._settings);

        // Bateria no estilo do MacBook, no lugar do ícone do GNOME.
        this._battery = new BatteryIndicator(this._settings);

        // Barra flutuante (cantos arredondados; encosta com janela maximizada).
        this._floatingPanel = new FloatingPanel(this._settings);

        // Ícones de bandeja na barra (os do serviço que já está rodando).
        this._tray = new TrayIcons(this._settings, {
            getAppearance: () => this._menuBar.getAppearance(),
            getMenuOptions: () => this._menuBar.getMenuOptions(),
        });
        this._tray.setWatcher(this._trayWatcher);

        // O OSD do GNOME (volume/brilho) passa por um ponto só: o volume vai
        // para o HUD no centro da tela (estilo macOS); o brilho, para os
        // alertas do relógio (que se registra ao ser criado).
        this._osd = new OsdOverride();
        this._volumeHud = new VolumeHud(this._settings);
        this._osd.setHandler('volume', osd => this._volumeHud.handleOsd(osd));

        // A ilha (notch) no lugar do relógio, se ligada nas preferências.
        this._island = null;
        this._syncIsland();
    }

    /** Liga/desliga a ilha ao vivo (só enquanto a interface existe). */
    _syncIsland() {
        const wanted = Boolean(this._menuBar) && this._settings.get_boolean('island-enabled');
        if (wanted && !this._island) {
            this._island = new Island(this._settings, this._barLook,
                () => this._menuBar.getAppearance(), {
                    focus: this._focusTimer,
                    reminders: this._reminders,
                    clipboard: this._clipboard,
                    fileTray: this._fileTray,
                    usage: this._usage,
                    osd: this._osd,
                });
        } else if (!wanted && this._island) {
            this._island.destroy();
            this._island = null;
        }
    }

    /** Tempo de uso de apps: liga/desliga ao vivo (desligado por padrão). */
    _syncUsage() {
        const wanted = this._settings.get_boolean('app-usage-enabled');
        if (wanted && !this._usage) {
            this._usage = new AppUsage();
        } else if (!wanted && this._usage) {
            this._usage.destroy();
            this._usage = null;
        } else {
            return;
        }
        this._island?.setUsage(this._usage);
    }

    _destroyUi() {
        // A ilha primeiro: ela devolve o relógio do GNOME ao painel antes de
        // o PanelLayout restaurar a posição dele.
        this._island?.destroy();
        this._island = null;

        // O OSD por último: devolve os métodos originais do GNOME.
        this._volumeHud?.destroy();
        this._volumeHud = null;
        this._osd?.destroy();
        this._osd = null;

        this._tray?.destroy();
        this._tray = null;
        this._floatingPanel?.destroy();
        this._floatingPanel = null;
        this._battery?.destroy();
        this._battery = null;
        this._panelLayout?.destroy();
        this._panelLayout = null;

        // destroy() remove a barra do painel e destrói os filhos (botões e
        // menus); os menus saem sozinhos do gerenciador de menus do painel.
        this._menuBar?.destroy();
        this._menuBar = null;
        this._barLook?.destroy();
        this._barLook = null;
    }
}
