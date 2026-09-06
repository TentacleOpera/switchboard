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
let _goClientPath: string | null = null;

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
 * Composition-root seam for the static Go client binary. Both hosts call this
 * with the absolute path to the platform-appropriate `switchboard` binary from
 * `client-artifacts.json`. When set, `resolveCliPath()` prefers this over the
 * Node CLI, and `resolveBundledCliPath()` continues to return the Node host
 * entry point for `node "<cliPath>"` invocations.
 *
 * Developer mode: set `SWITCHBOARD_GO_CLIENT_PATH` to name a freshly built Go
 * client binary that is not yet in the artifact manifest.
 */
export function setGoClientPath(clientPath: string | null | undefined): void {
    _goClientPath = (typeof clientPath === 'string' && clientPath.trim()) ? clientPath.trim() : null;
}

/**
 * Absolute path to the bundled Node CLI (the host entry point). Falls back to
 * probing `__dirname` so a host that never called `setBundledCliPath` still
 * emits a runnable command rather than a literal placeholder:
 *  - standalone: this module is bundled INTO `dist/standalone/cli.js`, so
 *    `__dirname` is `dist/standalone/`.
 *  - extension: this module is bundled into `dist/extension.js`, so
 *    `__dirname` is `dist/`.
 *
 * This always returns the Node host path — the Go client is resolved separately
 * by `resolveGoClientPath()` / `resolveCliPath()`.
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
 * Resolves the static Go client binary path from (in order):
 *  1. `SWITCHBOARD_GO_CLIENT_PATH` env (developer mode — freshly built binary).
 *  2. The value set by `setGoClientPath()` (composition-root seam).
 *  3. `client-artifacts.json` next to this module, keyed by platform.
 * Returns `null` when no Go client is installed — callers fall back to the
 * Node CLI path.
 */
export function resolveGoClientPath(): string | null {
    // Developer override.
    const envPath = process.env['SWITCHBOARD_GO_CLIENT_PATH'];
    if (typeof envPath === 'string' && envPath.trim()) {
        try { if (fs.existsSync(envPath.trim())) { return envPath.trim(); } } catch { /* unreadable */ }
    }
    // Composition-root seam.
    if (_goClientPath) { return _goClientPath; }
    // Artifact manifest: look for client-artifacts.json relative to __dirname.
    const manifestCandidates = [
        path.join(__dirname, 'client-artifacts.json'),
        path.join(__dirname, '..', 'client-artifacts.json'),
        path.join(__dirname, '..', '..', 'client-artifacts.json'),
    ];
    for (const manifestPath of manifestCandidates) {
        try {
            if (!fs.existsSync(manifestPath)) { continue; }
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const targets = manifest.targets;
            if (!targets || typeof targets !== 'object') { continue; }
            const platform = `${process.platform}-${process.arch}`;
            const rel = targets[platform];
            if (typeof rel !== 'string') { continue; }
            const abs = path.resolve(path.dirname(manifestPath), rel);
            if (fs.existsSync(abs)) { return abs; }
        } catch { /* unreadable or malformed manifest */ }
    }
    return null;
}

/**
 * Resolves the preferred CLI path for agent-facing prompts. Prefers the static
 * Go client when available; falls back to the Node CLI host entry point.
 * The Go client is invoked as `"<path>" <verb>` (no `node` prefix); the Node
 * CLI is invoked as `node "<path>" <verb>`.
 *
 * Prompt fragments that use `node "<cliPath>"` should continue to use
 * `resolveBundledCliPath()` for the Node form. This function is for the
 * `switchboard`-style invocation (no `node` prefix).
 */
export function resolveCliPath(): string {
    const goPath = resolveGoClientPath();
    if (goPath) { return goPath; }
    return resolveBundledCliPath();
}

/**
 * Returns `true` when the resolved CLI path is the Go client binary (not the
 * Node CLI). Used by prompt builders to choose between `node "<path>"` and
 * `"<path>"` invocation forms.
 */
export function isGoClientResolved(): boolean {
    return resolveGoClientPath() !== null;
}

/**
 * Replace every `<cliPath>` token in agent-facing text with a runnable path.
 * `cliPath` overrides the host-wired path (the prompt builder passes the value
 * it already resolved); omit it to use the composition-root seam.
 *
 * By default, substitutes the Node CLI path (for `node "<cliPath>"` patterns).
 * Pass `{ preferGoClient: true }` to substitute the Go client path when
 * available (for `switchboard`-style patterns without a `node` prefix).
 */
export function substituteCliPath(text: string, cliPath?: string, opts?: { preferGoClient?: boolean }): string {
    if (!text || text.indexOf(CLI_PATH_TOKEN) === -1) { return text; }
    const resolved = cliPath
        || (opts?.preferGoClient ? resolveCliPath() : resolveBundledCliPath());
    return text.split(CLI_PATH_TOKEN).join(resolved);
}
