// SPDX-License-Identifier: GPL-3.0-or-later
// "Apps Usando Muita Energia" do pop-up da bateria.
//
// O macOS mede a energia de cada app; o Linux não tem uma API pronta para
// isso. A melhor aproximação disponível sem permissões especiais é o USO DE
// CPU: é o que mais gasta bateria e o kernel conta o tempo de CPU de cada
// processo em /proc/<pid>/stat (campos utime + stime, em "tiques").
//
// Como medimos:
//   1. uma "foto" de todos os processos (pid → pai e tiques de CPU);
//   2. outra foto um pouco depois;
//   3. para cada app aberto (Shell.AppSystem), somamos a diferença de tiques
//      dos processos dele E dos filhos (navegadores e apps Electron fazem o
//      trabalho pesado em processos filhos);
//   4. tiques / 100 / segundos = fração de UM núcleo. Acima do limite, o app
//      entra na lista.
//
// Custo: ler ~500 arquivos pequenos do /proc, de forma assíncrona (nada trava
// o Shell), e SÓ com o pop-up aberto (mais uma foto quando o ponteiro passa
// sobre o ícone, para a lista já estar pronta no clique).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {logError} from '../util.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

/** O /proc conta o tempo em "tiques" de 1/100 s (USER_HZ, fixo no Linux). */
const TICKS_PER_SECOND = 100;
/** Acima disto (fração de um núcleo) o app "usa muita energia". */
const HEAVY_CPU = 0.15;
/** No máximo tantos apps na lista (como no macOS, só os piores). */
const MAX_APPS = 5;
/** Janela mínima entre duas fotos (ms): menos que isso é ruído. */
const MIN_WINDOW = 1000;
/** Foto tirada ao passar o ponteiro vale como 1ª foto até esta idade (ms). */
const BASE_MAX_AGE = 5000;
/** Com o pop-up aberto, a lista se atualiza a cada (ms). */
const REFRESH = 3000;

/** PID do próprio GNOME Shell (nunca entra na conta de um app). */
const SHELL_PID = new Gio.Credentials().get_unix_pid();

/**
 * Lê /proc/<pid>/stat: "pid (nome) estado ppid … utime stime …".
 * O nome pode ter espaços e parênteses: cortamos depois do ÚLTIMO ")".
 *
 * @param {string} text
 * @returns {{ppid: number, ticks: number}|null}
 */
export function parseStat(text) {
    const end = text.lastIndexOf(')');
    if (end < 0)
        return null;
    // Depois do ")": [0] estado, [1] ppid, …, [11] utime, [12] stime
    // (campos 3, 4, 14 e 15 do `man 5 proc`).
    const fields = text.slice(end + 2).split(' ');
    const ppid = Number(fields[1]);
    const ticks = Number(fields[11]) + Number(fields[12]);
    if (!Number.isFinite(ppid) || !Number.isFinite(ticks))
        return null;
    return {ppid, ticks};
}

/**
 * Uma foto de todos os processos.
 *
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<{time: number, procs: Map<number, object>}>}
 */
async function snapshot(cancellable) {
    const proc = Gio.File.new_for_path('/proc');
    const enumerator = await proc.enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
    const pids = [];
    for (;;) {
        const infos = await enumerator.next_files_async(256, GLib.PRIORITY_LOW, cancellable);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            const name = info.get_name();
            if (/^\d+$/.test(name))
                pids.push(Number(name));
        }
    }

    const procs = new Map();
    const decoder = new TextDecoder();
    await Promise.all(pids.map(async pid => {
        try {
            const file = Gio.File.new_for_path(`/proc/${pid}/stat`);
            const [bytes] = await file.load_contents_async(cancellable);
            const stat = parseStat(decoder.decode(bytes));
            if (stat)
                procs.set(pid, stat);
        } catch {
            // O processo terminou entre a lista e a leitura: normal.
        }
    }));
    return {time: GLib.get_monotonic_time(), procs};
}

/**
 * Apps que mais usaram CPU entre duas fotos (só os acima do limite).
 *
 * @param {object} before - foto antiga
 * @param {object} after - foto nova
 * @param {Shell.App[]} apps - apps abertos
 * @returns {{app: Shell.App, cpu: number}[]}
 */
export function heavyApps(before, after, apps) {
    const seconds = (after.time - before.time) / GLib.USEC_PER_SEC;
    if (seconds <= 0)
        return [];

    // pid → filhos (a árvore de processos da foto nova).
    const children = new Map();
    for (const [pid, {ppid}] of after.procs) {
        if (!children.has(ppid))
            children.set(ppid, []);
        children.get(ppid).push(pid);
    }

    // Cada processo conta para UM app só (o primeiro que o alcança).
    const counted = new Set([0, 1, SHELL_PID]);
    const result = [];
    for (const app of apps) {
        let ticks = 0;
        const stack = [...app.get_pids()];
        while (stack.length > 0) {
            const pid = stack.pop();
            if (counted.has(pid))
                continue;
            counted.add(pid);
            const now = after.procs.get(pid);
            if (!now)
                continue;
            // Processo que nasceu entre as fotos (sem "antes", ou com o PID
            // reaproveitado por outro pai): TODO o tempo de CPU dele
            // aconteceu depois da 1ª foto, então conta inteiro.
            const then = before.procs.get(pid);
            if (then && then.ppid === now.ppid)
                ticks += Math.max(0, now.ticks - then.ticks);
            else
                ticks += now.ticks;
            stack.push(...children.get(pid) ?? []);
        }
        const cpu = ticks / TICKS_PER_SECOND / seconds;
        if (cpu >= HEAVY_CPU)
            result.push({app, cpu});
    }
    return result.sort((a, b) => b.cpu - a.cpu).slice(0, MAX_APPS);
}

/** Espera `ms`, ou menos se o cancelável for cancelado. */
function sleep(ms, cancellable) {
    return new Promise(resolve => {
        let cancelId = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            cancellable.disconnect(cancelId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        // Se já estava cancelado, o Gio chama na hora (e devolve 0).
        cancelId = cancellable.connect(() => {
            GLib.source_remove(id);
            resolve();
        });
    });
}

function isCancelled(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class EnergyMonitor {
    constructor() {
        this._base = null; // última foto (de quando o ponteiro passou)
        this._priming = null; // foto do "passar o ponteiro" em andamento
        this._cancellable = null; // medição contínua (pop-up aberto)
        this._primeCancellable = new Gio.Cancellable();
    }

    /**
     * O ponteiro chegou ao ícone: tira a 1ª foto já, para a lista estar
     * pronta logo depois do clique (e não 1 s depois).
     */
    prime() {
        if (this._cancellable || this._priming || this._baseIsFresh())
            return;
        this._priming = snapshot(this._primeCancellable)
            .then(s => {
                this._base = s;
            })
            .catch(e => {
                if (!isCancelled(e))
                    logError(e, 'bateria: lendo o uso de CPU');
            })
            .finally(() => {
                this._priming = null;
            });
    }

    /**
     * Mede sem parar (até stop()) e chama `onResult(lista)` a cada medida.
     *
     * @param {(apps: object[]) => void} onResult
     */
    start(onResult) {
        // Não chama stop(): ele apagaria a foto do "passar o ponteiro".
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._loop(cancellable, onResult).catch(e => {
            if (!isCancelled(e) && !cancellable.is_cancelled())
                logError(e, 'bateria: lendo o uso de CPU');
        });
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        // A próxima abertura mede de novo (uma foto velha deixaria de fora o
        // que mudou desde então).
        this._base = null;
    }

    _baseIsFresh() {
        if (!this._base)
            return false;
        const age = (GLib.get_monotonic_time() - this._base.time) / 1000;
        return age < BASE_MAX_AGE;
    }

    async _loop(cancellable, onResult) {
        if (this._priming)
            await this._priming;
        let base = this._baseIsFresh() ? this._base : await snapshot(cancellable);
        while (!cancellable.is_cancelled()) {
            const age = (GLib.get_monotonic_time() - base.time) / 1000;
            if (age < MIN_WINDOW)
                await sleep(MIN_WINDOW - age, cancellable);
            if (cancellable.is_cancelled())
                return;
            const now = await snapshot(cancellable);
            if (cancellable.is_cancelled())
                return;
            const apps = Shell.AppSystem.get_default().get_running();
            onResult(heavyApps(base, now, apps));
            base = now;
            await sleep(REFRESH, cancellable);
        }
    }

    destroy() {
        this.stop();
        this._primeCancellable.cancel();
        this._base = null;
    }
}
