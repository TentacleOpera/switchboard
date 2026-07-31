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
