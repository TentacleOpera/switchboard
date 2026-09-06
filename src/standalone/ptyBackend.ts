import type { TerminalHandle } from '../services/hostSeams';

export interface PtySpawnOptions {
    name: string;
    shell?: string;
    args?: string[];
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
}

/**
 * PTYs are owned by the Go host. This compatibility seam remains only so old
 * callers fail loudly while the composition roots migrate; it never loads a
 * native PTY module.
 */
export function isPtyAvailable(): boolean {
    return false;
}

export class PtyTerminalBackend {
    public create(_options: PtySpawnOptions): TerminalHandle {
        throw new Error('PTY terminals require the packaged switchboard-pty-host executable; Node PTY fallback is removed');
    }
}
