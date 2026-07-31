import * as fs from 'fs';
import * as path from 'path';
import type { TerminalHandle } from '../services/hostSeams';

let ptyModule: typeof import('node-pty') | undefined;

function getPtyModule(): typeof import('node-pty') {
    if (!ptyModule) {
        ptyModule = require('node-pty');
        if (process.platform === 'darwin') {
            try {
                const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
                const arch = process.arch;
                const helperPath = path.join(nodePtyDir, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
                if (fs.existsSync(helperPath)) {
                    fs.chmodSync(helperPath, 0o755);
                }
            } catch (err) {
                console.warn('[PtyBackend] Failed to chmod darwin spawn-helper:', err);
            }
        }
    }
    return ptyModule!;
}

let ptyAvailable: boolean | undefined;

/**
 * Can this machine actually spawn PTYs?
 *
 * `node-pty` is an OPTIONAL dependency (it ships no Linux prebuild, and its
 * install hook falls back to `node-gyp rebuild` — see the backend plan's
 * dependency decision), so a perfectly healthy install can legitimately lack it.
 * Every PTY-facing capability flag must derive from this probe: without it
 * standalone advertises a Terminals rail tab and un-hidden dispatch buttons that
 * throw on first click.
 *
 * Probed once and cached — the answer cannot change while the process lives.
 * Loads the module for real (rather than resolving a path) so a present-but-
 * unloadable binary counts as unavailable.
 */
export function isPtyAvailable(): boolean {
    if (ptyAvailable === undefined) {
        try {
            getPtyModule();
            ptyAvailable = true;
        } catch (err) {
            ptyAvailable = false;
            console.warn('[PtyBackend] node-pty unavailable — PTY terminals disabled for this session:', err instanceof Error ? err.message : err);
        }
    }
    return ptyAvailable;
}

export interface PtySpawnOptions {
    name: string;
    shell?: string;
    args?: string[];
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
}

export class PtyTerminalBackend {
    public create(options: PtySpawnOptions): TerminalHandle & { pty: import('node-pty').IPty } {
        const pty = getPtyModule();
        const shell = options.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
        const args = options.args || (process.platform !== 'win32' && !options.shell ? ['-l'] : []);
        const cols = options.cols || 80;
        const rows = options.rows || 24;
        const cwd = options.cwd || process.cwd();
        const env = (options.env || process.env) as Record<string, string>;

        const ptyProcess = pty.spawn(shell, args, {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
        });

        const handle: TerminalHandle & { pty: import('node-pty').IPty } = {
            name: options.name,
            pty: ptyProcess,
            sendText: (text: string, addNewLine?: boolean) => {
                ptyProcess.write(text + (addNewLine !== false ? '\r' : ''));
            },
            write: (data: string) => {
                ptyProcess.write(data);
            },
            onData: (cb: (chunk: string) => void) => {
                const disposable = ptyProcess.onData(cb);
                return { dispose: () => disposable.dispose() };
            },
            onExit: (cb: (code: number | undefined) => void) => {
                const disposable = ptyProcess.onExit((e) => cb(e.exitCode));
                return { dispose: () => disposable.dispose() };
            },
            resize: (cols: number, rows: number) => {
                try {
                    ptyProcess.resize(cols, rows);
                } catch (err) {
                    console.warn(`[PtyBackend] Failed to resize terminal ${options.name}:`, err);
                }
            },
            dispose: () => {
                try {
                    ptyProcess.kill();
                } catch { /* ignore */ }
            },
            kill: () => {
                try {
                    ptyProcess.kill();
                } catch { /* ignore */ }
            },
            show: () => {},
        };

        return handle;
    }
}
