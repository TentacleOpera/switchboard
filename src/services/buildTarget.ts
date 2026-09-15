/**
 * Build target — where a build runs, and the results recorded against a commit.
 *
 * The operator chooses one of three targets in the Agent Control panel
 * (`this box`, `desktop over SSH`, `GitHub Actions`); the choice is a
 * per-workspace config value, delivered to the agent as the `seat.build-target`
 * standing-order fragment (config carries the choice, the fragment does the
 * telling — the same shape as `seat.subagent-policy`).
 *
 * Build results are keyed by commit SHA so a reviewer dispatched commit X reads
 * the result for X, never "the last build". A `planIndex` (planId → commitSha)
 * bridges the plan a reviewer holds to the commit it produced, since the plan
 * record itself carries no SHA.
 *
 * This module is a leaf: it imports nothing from the provider or the prompt
 * builder so both the standing-order fragment table and KanbanProvider can use
 * it without a cycle.
 */

export type BuildTargetId = 'this-box' | 'ssh' | 'github-actions';

export const BUILD_TARGET_IDS: readonly BuildTargetId[] = ['this-box', 'ssh', 'github-actions'];

export const BUILD_TARGET_LABELS: Record<BuildTargetId, string> = {
    'this-box': 'this box',
    'ssh': 'desktop over SSH',
    'github-actions': 'GitHub Actions',
};

/** Default is `this box` — the status quo, made explicit rather than changed. */
export const DEFAULT_BUILD_TARGET: BuildTargetId = 'this-box';

/** Per-workspace config row (kanban.db `config` table). */
export const BUILD_CONFIG_KEY = 'build.config';

export interface BuildResult {
    /** The commit the build ran against. The key this result is stored under. */
    commitSha: string;
    /** The plan whose work the commit belongs to, when known (plan → SHA index). */
    planId?: string;
    target: BuildTargetId;
    success: boolean;
    durationMs: number;
    /** One-line outcome (e.g. the failing step) for the reviewer. */
    summary?: string;
    /** ISO timestamp the result was recorded. */
    at: string;
}

export interface BuildConfig {
    /**
     * The chosen target. `undefined` when the operator never chose one AND when
     * the persisted value was present but not recognised (see
     * {@link unrecognizedTarget}). NEVER defaulted to `this-box` on read: a
     * corrupt value must not read back as a deliberate operator choice.
     */
    target?: BuildTargetId;
    /**
     * The persisted `target` string that was present but is not one of
     * {@link BUILD_TARGET_IDS}. Its presence means the row is corrupt — callers
     * must SURFACE it (the panel warns; the seat fragment tells the agent the
     * target is unrecognised), never substitute a plausible target.
     */
    unrecognizedTarget?: string;
    /** Results keyed by commit SHA. */
    results: Record<string, BuildResult>;
    /** planId → commitSha, so a reviewer holding a plan can find its commit. */
    planIndex: Record<string, string>;
}

export interface BuildTargetAvailability {
    available: boolean;
    /** Human-readable reason. Shown at the point of choice, never swallowed. */
    detail: string;
}

export interface BuildTargetProbeInput {
    /** SSH host configured for the `ssh` target, if any. */
    sshHost?: string;
    /** Result of an SSH reachability test, when one was run. `null`/absent = not tested. */
    sshReachable?: boolean | null;
    /** `owner/repo` configured for the `github-actions` target, if any. */
    actionsRepo?: string;
    /** Whether GitHub Actions credentials are configured (SecretStorage). */
    actionsConfigured?: boolean;
}

export function isBuildTargetId(value: unknown): value is BuildTargetId {
    return typeof value === 'string' && (BUILD_TARGET_IDS as readonly string[]).includes(value);
}

/**
 * Coerce a persisted blob into a well-formed config. Unknown fields are dropped.
 *
 * A `target` that is present but not one of {@link BUILD_TARGET_IDS} is surfaced
 * as {@link BuildConfig.unrecognizedTarget} and left OUT of `target` — it is
 * never replaced with the default. Substituting `this-box` would make a corrupt
 * row indistinguishable from a deliberate operator choice, and
 * `buildTargetDirective('this-box')` would then tell the agent "It is a valid
 * target — not a fallback" about a value the operator never set.
 */
export function normalizeBuildConfig(raw: unknown): BuildConfig {
    const cfg = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const rawTarget = cfg.target;
    const results = (cfg.results && typeof cfg.results === 'object' && !Array.isArray(cfg.results))
        ? cfg.results as Record<string, BuildResult>
        : {};
    const planIndex = (cfg.planIndex && typeof cfg.planIndex === 'object' && !Array.isArray(cfg.planIndex))
        ? cfg.planIndex as Record<string, string>
        : {};
    if (isBuildTargetId(rawTarget)) {
        return { target: rawTarget, results, planIndex };
    }
    if (typeof rawTarget === 'string' && rawTarget.trim()) {
        // Present but unrecognised — surface it, do not substitute.
        return { unrecognizedTarget: rawTarget, results, planIndex };
    }
    // Absent or non-string: nothing has been chosen.
    return { results, planIndex };
}

/**
 * The standing-order text for a target. Delivered by the `seat.build-target`
 * fragment — this is the "telling" half that makes the stored choice reach the
 * agent instead of sitting inert in Agent Control.
 *
 * The `<cliPath>` token is substituted by `substituteCliPath` on the way out of
 * the standing-orders block (same convention as the completion directive).
 */
export function buildTargetDirective(target: string, detail?: string): string {
    const record = ' When the build finishes, record its outcome against the commit you built so the '
        + 'reviewer receives the result for THAT commit: run `node "<cliPath>" verb recordBuildResult '
        + '\'{"commitSha":"<sha>","target":"' + target + '","success":<true|false>,"durationMs":<ms>}\'`. '
        + 'A result keyed by the wrong sha, or not recorded at all, tells the reviewer "not built yet".';
    switch (target) {
        case 'this-box':
            return 'BUILD TARGET: run builds on this box (the board host). It is a valid target — '
                + 'not a fallback. Use the repository\'s own build command (e.g. `npm run package`).' + record;
        case 'ssh':
            return 'BUILD TARGET: run builds on the desktop over SSH'
                + (detail ? ' (' + detail + ')' : '')
                + '. Do NOT build locally — the operator chose the desktop because this box is slow or '
                + 'memory-constrained for this build.' + record;
        case 'github-actions':
            return 'BUILD TARGET: run builds on GitHub Actions'
                + (detail ? ' (' + detail + ')' : '')
                + '. Triggering a workflow has real side effects (Actions minutes, webhooks) — the operator '
                + 'chose this target, so proceed.' + record;
        default:
            // A persisted value that is not one of BUILD_TARGET_IDS. Surface it —
            // never fall through to `this-box`, which would tell the agent "It is a
            // valid target — not a fallback" about a value the operator never set.
            return unrecognizedBuildTargetDirective(target);
    }
}

/**
 * The standing-order text for a config whose `target` is present but not
 * recognised. Delivered instead of a substituted target's directive so the agent
 * is told the truth — "the configured target is unreadable" — rather than being
 * told to build on a target the operator never chose.
 */
export function unrecognizedBuildTargetDirective(raw: string): string {
    return 'BUILD TARGET: the configured build target "' + raw + '" is not recognised (one of: '
        + BUILD_TARGET_IDS.join(', ') + '). Do NOT assume this box — ask the operator to re-select a target in '
        + 'Agent Control, and do not record a build result against a target you had to guess.';
}

/**
 * Which targets are usable right now, probed at the point of choice. A target
 * that is not usable is reported as unavailable with a reason — never silently
 * swapped for `this box`.
 */
export function probeBuildTargets(input: BuildTargetProbeInput): Record<BuildTargetId, BuildTargetAvailability> {
    const sshHost = (input.sshHost || '').trim();
    let ssh: BuildTargetAvailability;
    if (!sshHost) {
        ssh = { available: false, detail: 'No SSH host configured (build.sshHost).' };
    } else if (input.sshReachable === false) {
        ssh = { available: false, detail: `SSH host "${sshHost}" is unreachable.` };
    } else if (input.sshReachable === true) {
        ssh = { available: true, detail: `SSH host "${sshHost}" reachable.` };
    } else {
        ssh = { available: true, detail: `SSH host "${sshHost}" configured (reachability not tested).` };
    }

    const actionsRepo = (input.actionsRepo || '').trim();
    let actions: BuildTargetAvailability;
    if (!actionsRepo) {
        actions = { available: false, detail: 'No GitHub repository configured (build.actionsRepo).' };
    } else if (input.actionsConfigured !== true) {
        actions = { available: false, detail: `GitHub Actions credentials are not configured for "${actionsRepo}".` };
    } else {
        actions = { available: true, detail: `GitHub Actions configured for "${actionsRepo}".` };
    }

    return {
        'this-box': { available: true, detail: 'The board host — always available.' },
        'ssh': ssh,
        'github-actions': actions,
    };
}

/** Minimal shape of the DB config surface this module needs (avoids a hard import). */
export interface BuildConfigStore {
    getConfigJson<T>(key: string, defaultValue: T): Promise<T>;
    setConfigJson(key: string, value: unknown): Promise<boolean>;
    updateConfigJson<T>(key: string, defaultValue: T, updater: (current: T) => T | Promise<T>): Promise<T>;
}

export async function readBuildConfig(db: BuildConfigStore): Promise<BuildConfig> {
    return normalizeBuildConfig(await db.getConfigJson<unknown>(BUILD_CONFIG_KEY, {}));
}

/**
 * The build-target slice of a seat's `StandingOrderRenderOptions`: the chosen
 * target plus the host/repo shown alongside the directive. Read by both hosts'
 * standing-order delivery seams so the `seat.build-target` fragment composes on
 * the same channel as the subagent policy.
 *
 * Returns `{}` (no fragment) ONLY when the operator has never chosen a target —
 * the status quo, where no build-target instruction is delivered. Once a target
 * is chosen — including an explicit `this box` — the fragment fires, so the agent
 * is told where to build AND to record the result the reviewer reads.
 *
 * The value is the RAW persisted string, so a row whose `target` is present but
 * unrecognised reaches the fragment and is SURFACED by `buildTargetDirective`'s
 * default arm — it is never silently dropped (which would be indistinguishable
 * from "never chosen") nor substituted with `this box`.
 */
export async function readBuildRenderOptions(db: BuildConfigStore): Promise<{ buildTarget?: string; buildTargetDetail?: string }> {
    const raw = await db.getConfigJson<unknown>(BUILD_CONFIG_KEY, null);
    if (raw === null || raw === undefined) { return {}; }
    const cfg = normalizeBuildConfig(raw);
    const target = cfg.target ?? cfg.unrecognizedTarget;
    if (!target) { return {}; }
    let detail: string | undefined;
    if (target === 'ssh') {
        detail = ((await db.getConfigJson<string>('build.sshHost', '')) || '').trim() || undefined;
    } else if (target === 'github-actions') {
        detail = ((await db.getConfigJson<string>('build.actionsRepo', '')) || '').trim() || undefined;
    }
    return { buildTarget: target, buildTargetDetail: detail };
}

export async function writeBuildConfig(db: BuildConfigStore, cfg: BuildConfig): Promise<boolean> {
    return db.setConfigJson(BUILD_CONFIG_KEY, cfg);
}

/** Set the chosen target, preserving results and the plan index. */
export async function setBuildTarget(db: BuildConfigStore, target: BuildTargetId): Promise<BuildConfig> {
    return db.updateConfigJson<BuildConfig>(BUILD_CONFIG_KEY, normalizeBuildConfig({}), cfg => {
        const normalized = normalizeBuildConfig(cfg);
        normalized.target = target;
        // An operator re-selecting a target replaces any unrecognised value.
        delete normalized.unrecognizedTarget;
        return normalized;
    });
}

/**
 * Record a build result against its commit SHA. Idempotent per SHA (a re-run
 * replaces the row). Also indexes planId → SHA when a planId is given, so the
 * reviewer path can resolve the plan it holds to the commit it produced.
 */
export async function recordBuildResult(db: BuildConfigStore, result: BuildResult): Promise<BuildConfig> {
    return db.updateConfigJson<BuildConfig>(BUILD_CONFIG_KEY, normalizeBuildConfig({}), cfg => {
        const normalized = normalizeBuildConfig(cfg);
        normalized.results[result.commitSha] = result;
        if (result.planId) {
            normalized.planIndex[result.planId] = result.commitSha;
        }
        return normalized;
    });
}

/**
 * The most recent result per target — the durations the control shows so the
 * choice is informed rather than a guess.
 */
export function lastResultPerTarget(cfg: BuildConfig): Record<BuildTargetId, BuildResult | null> {
    const out: Record<BuildTargetId, BuildResult | null> = {
        'this-box': null, 'ssh': null, 'github-actions': null,
    };
    for (const r of Object.values(cfg.results)) {
        if (!isBuildTargetId(r?.target)) { continue; }
        const prev = out[r.target];
        if (!prev || String(r.at || '') > String(prev.at || '')) { out[r.target] = r; }
    }
    return out;
}

/**
 * Resolve a reviewer's plan to its build result. Prefers an explicit commit SHA;
 * falls back to the plan → SHA index. Returns null when the commit was never
 * built — the caller reports "not built yet" rather than substituting another
 * build's result.
 */
export function resolveBuildResult(cfg: BuildConfig, opts: { commitSha?: string; planId?: string }): BuildResult | null {
    if (opts.commitSha && cfg.results[opts.commitSha]) { return cfg.results[opts.commitSha]; }
    if (opts.planId) {
        const sha = cfg.planIndex[opts.planId];
        if (sha && cfg.results[sha]) { return cfg.results[sha]; }
    }
    return null;
}
