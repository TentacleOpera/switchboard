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
            // Manifest keys are Go target names, so `x64` must be normalised to
            // `amd64` — `process.arch` never spells it that way, and the
            // un-normalised key silently missed on every amd64 machine, which is
            // the entire install base of the tower.
            const arch = process.arch === 'x64' ? 'amd64' : process.arch;
            const platform = `${process.platform}-${arch}`;
            const rel = targets[platform];
            if (typeof rel !== 'string') { continue; }
            const abs = path.resolve(path.dirname(manifestPath), rel);
            if (fs.existsSync(abs)) { return abs; }
        } catch { /* unreadable or malformed manifest */ }
    }
    return null;
}

/**
 * The invocation prefix every agent-facing fragment carries in front of the
 * `<cliPath>` token. Every live fragment writes `node "<cliPath>"` — the
 * substitution seam rewrites that whole phrase, so a fragment never has to
 * know which executable it will end up naming.
 */
const NODE_INVOCATION_PREFIX = 'node "' + CLI_PATH_TOKEN + '"';

/**
 * The runnable command an agent should be handed for a board callback.
 *
 * The static Go client IS the `switchboard` executable: it is invoked as
 * `"<path>" <verb>` with no `node` prefix, and it hands non-client verbs to
 * the Node host entry itself. When no Go client is installed the Node bundle
 * is named directly, exactly as before.
 *
 * `nodeCliPath` is the Node host entry the caller already resolved; it is used
 * only when no Go client is present. Returning the whole invocation (not just
 * a path) is what makes the `node` prefix disappear along with the Node path —
 * a caller that only swapped the path would emit `node "<go binary>"`.
 */
export function formatCliInvocation(nodeCliPath?: string): string {
    const goPath = resolveGoClientPath();
    if (goPath) { return `"${goPath}"`; }
    return `node "${nodeCliPath || resolveBundledCliPath()}"`;
}

/**
 * Resolves the preferred CLI executable for agent-facing prompts. Prefers the
 * static Go client when available; falls back to the Node CLI host entry
 * point. Callers that need the *invocation* (with or without the `node`
 * prefix) want `formatCliInvocation` instead — the prefix and the path are one
 * decision, not two.
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
 * When the static Go client is installed, the whole `node "<cliPath>"` phrase
 * becomes `"<go client>"` — the Go binary is the `switchboard` executable and
 * is not run through `node`. Without a Go client the Node bundle is named, as
 * before.
 */
export function substituteCliPath(text: string, cliPath?: string): string {
    if (!text || text.indexOf(CLI_PATH_TOKEN) === -1) { return text; }
    const nodePath = cliPath || resolveBundledCliPath();
    // The whole `node "<cliPath>"` phrase is the unit of substitution, not the
    // token alone: the Go client is its own executable and must not be handed
    // to `node`. Rewrite the phrase first, then any bare token (comments,
    // future fragments) with the Node path.
    const invocation = formatCliInvocation(nodePath);
    return text
        .split(NODE_INVOCATION_PREFIX).join(invocation)
        .split(CLI_PATH_TOKEN).join(nodePath);
}
