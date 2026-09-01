import * as net from 'net';

export const PORT_BASE = 7777;
export const PORT_SPAN = 4; // 7777..7780 — one constant, one line to widen

/**
 * Can we bind `port` on loopback right now?
 *
 * Used to choose the listen port before `startHeadlessSwitchboard` builds anything,
 * so a busy default port costs one throwaway socket rather than a half-booted
 * instance that has to be abandoned mid-flight.
 */
export function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        try { probe.listen(port, '127.0.0.1'); } catch { resolve(false); }
    });
}

/** First free port in [PORT_BASE, PORT_BASE+PORT_SPAN). Returns null if all are taken. */
export async function resolvePreferredPort(base = PORT_BASE, span = PORT_SPAN): Promise<number | null> {
    for (let i = 0; i < span; i++) {
        const port = base + i;
        if (await isPortFree(port)) {
            return port;
        }
    }
    return null;
}
