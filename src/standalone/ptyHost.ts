/**
 * Retired compatibility entry. PTY ownership moved to cmd/switchboard-pty-host.
 * The standalone webpack entry no longer includes this module.
 */
export function runPtyHost(): never {
    throw new Error('The TypeScript PTY host is retired; use the packaged switchboard-pty-host executable');
}
