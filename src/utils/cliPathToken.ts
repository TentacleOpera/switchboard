import * as fs from 'fs';
import * as path from 'path';

/**
 * The literal token every agent-facing prompt fragment carries in place of the
 * bundled CLI's absolute path.
 *
 * The fragments are module-level constants (and byte-identical mirrors in
 * `terminals.js` / `kanban.html`), so they cannot interpolate a runtime path.
 * They carry this token instead, and the emission seams below swap it for a
 * real path on the way out. An unsubstituted token reaches the agent as
 * `node "<cliPath>" done …` — a command that cannot run — so every seam that
 * emits fragment text must call `substituteCliPath`.
 */
export const CLI_PATH_TOKEN = '<cliPath>';

let _bundledCliPath: string | null = null;

/**
 * Composition-root seam. Both hosts call this with the absolute path to the
 * bundled `dist/standalone/cli.js`. Module-level rather than threaded through
 * every options object: the path is one per host process, and a per-call option
 * is the "never wired == working" seam CLAUDE.md names.
 */
export function setBundledCliPath(cliPath: string | null | undefined): void {
    _bundledCliPath = (typeof cliPath === 'string' && cliPath.trim()) ? cliPath.trim() : null;
}

/**
 * Absolute path to the bundled CLI. Falls back to probing `__dirname` so a host
 * that never called `setBundledCliPath` still emits a runnable command rather
 * than a literal placeholder:
 *  - standalone: this module is bundled INTO `dist/standalone/cli.js`, so
 *    `__dirname` is `dist/standalone/`.
 *  - extension: this module is bundled into `dist/extension.js`, so
 *    `__dirname` is `dist/`.
 */
export function resolveBundledCliPath(): string {
    if (_bundledCliPath) { return _bundledCliPath; }
    const candidates = [
        path.join(__dirname, 'cli.js'),
        path.join(__dirname, 'standalone', 'cli.js'),
        path.join(__dirname, '..', 'standalone', 'cli.js'),
    ];
    for (const candidate of candidates) {
        try { if (fs.existsSync(candidate)) { return candidate; } } catch { /* unreadable */ }
    }
    return candidates[1];
}

/**
 * Replace every `<cliPath>` token in agent-facing text with a runnable path.
 * `cliPath` overrides the host-wired path (the prompt builder passes the value
 * it already resolved); omit it to use the composition-root seam.
 */
export function substituteCliPath(text: string, cliPath?: string): string {
    if (!text || text.indexOf(CLI_PATH_TOKEN) === -1) { return text; }
    return text.split(CLI_PATH_TOKEN).join(cliPath || resolveBundledCliPath());
}
