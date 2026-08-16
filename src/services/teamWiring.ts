import {
    mutateStandingOrders,
    makeStandingOrder,
    StandingOrder,
} from './standingOrders';
import { resolvePreset, resolvePresetMeta, DEFAULT_MEMBER_RELATIONSHIP } from './linkPresets';
import { GIT_SAFETY_DIRECTIVE } from './agentPromptBuilder';

/**
 * Host-agnostic team wiring — the shared step every caller runs after a head
 * and its children exist.
 *
 * `spawnDelegates` (`ptyFleetService.ts`) creates children with parentage and
 * names but installs NO standing orders and registers NO group. In the
 * extension host the fleet lives in a pty-host child process constructed
 * without a KanbanDatabase (`ptyHost.ts:43`), so wiring placed there works
 * under `npx` and silently no-ops on the shipped extension. This function runs
 * in the process that holds the DB — called from both hosts' `handlePtyVerb`
 * post-create hook and from `instantiateAgentGroupCore`.
 *
 * It does two things:
 *  1. Installs one callback standing order per child (child as `parent`, head
 *     as `child`).
 *  2. Registers a terminals group named for the head, so the team appears as
 *     one unit in the terminals tab.
 *
 * Neither rolls back terminals on failure — the callers' contract is
 * "terminals are already created, surface the error, do not destroy them".
 */

/**
 * The callback contract installed on every worker by default.
 *
 * ORIENTATION IS LOAD-BEARING. In `applyStandingOrders`, `parent` is the terminal
 * that RECEIVES the block (`o.parent === targetName`) and `child` is the terminal
 * the instruction is ABOUT — rendered as `- Regarding terminal "<child>": …`. The
 * Link-up modal proves it: it POSTs the order and then delivers the prompt to
 * `parentName`. So a WORKER is the `parent` of its own callback order and the head
 * is its `child`. Backwards, the block is delivered to the head about a worker
 * that is never told anything, and the coder finishes and reports to nobody.
 *
 * The text names the delivery ROUTE, not just the obligation: "send it a message"
 * is not something a CLI agent can act on. Every fleet terminal is handed the port
 * file and `SWITCHBOARD_API_TOKEN`, so the call is available to it.
 *
 * `{child}` is the head terminal name — substituted by `resolvePreset` in the
 * pair-order path (where `childName = headName` for `member-receives` direction)
 * and by `wireSpawnedTeam` directly when building the team prompt. The previous
 * form opened with a bare `it` whose antecedent came from the `- Regarding
 * terminal "X": ` render prefix; the team scope drops that prefix, so the head
 * must be named explicitly here.
 */
export const AGENT_GROUP_CALLBACK_INSTRUCTION =
    '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
    + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
    + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.';

/**
 * The PRE-rewrite callback text — byte-identical to the shipped constant before
 * this change. Existing installs have per-member pair rows whose `instruction`
 * field carries this exact string. The migration recogniser matches against it
 * (not the post-rewrite constant) because this is what is actually on disk.
 */
const PRE_REWRITE_CALLBACK_INSTRUCTION =
    'it is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
    + '{"name":"<that terminal>","data":"<your report>","clearBeforePrompt":false} against the port in '
    + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.';

/**
 * Layout sizing for a registered team group. The shipped loader
 * (`loadLayoutSettings` in terminals.js) keeps a group only when
 * `LAYOUT_MODES.includes(g.layout)`, and `switchToGroup` applies the group's
 * stored `layout` — a 4-member team registered with `'1'` resolves four
 * members into one pane. Register the smallest layout whose `slots >=
 * members.length`. `MAX_DELEGATES_PER_PARENT` is 8, so head + members can
 * reach 9 and `3x3` is the ceiling; a team larger than that clamps rather
 * than falls through to an invalid mode.
 *
 * Mirrors `LAYOUT_GROW_ORDER` in terminals.js (slot-ascending, '2v' omitted
 * — a stacked pair is a taste call, not an auto-pick).
 */
const TEAM_LAYOUT_LADDER: ReadonlyArray<{ mode: string; slots: number }> = [
    { mode: '1', slots: 1 },
    { mode: '2h', slots: 2 },
    { mode: '1x3', slots: 3 },
    { mode: '2x2', slots: 4 },
    { mode: '2x3', slots: 6 },
    { mode: '3x3', slots: 9 },
];

function layoutForTeamSize(memberCount: number): string {
    for (const rung of TEAM_LAYOUT_LADDER) {
        if (rung.slots >= memberCount) { return rung.mode; }
    }
    return '3x3';
}

/** Config key the terminals webview owns for `terminals.groups`. */
const TERMINALS_GROUPS_KEY = 'terminals.groups';

/**
 * Module-level promise chain serialising `terminals.groups` read-modify-write
 * cycles, in the style of `mutateStandingOrders` and
 * `KanbanProvider._mutateAgentGroups`. Two heads spawning concurrently must
 * not drop one another's group — the webview saves the WHOLE in-memory array,
 * so a stale read clobbers a concurrent write.
 */
let _groupsWriteChain: Promise<unknown> = Promise.resolve();

/** Config key for agent group definitions (team templates). */
const AGENT_GROUPS_CONFIG_KEY = 'terminals.agentGroups';

/**
 * The current seed: a member-less `Lead team` headed on `lead`.
 *
 * A team with no members does nothing — starting a `lead` starts a lead,
 * exactly as today. The seeded row is a piece of explanation that happens
 * to be one click from being functional, which is what allows it to ship
 * into the auto-start feature without a staged rollout.
 */
export const SEEDED_AGENT_GROUP: any = {
    id: 'feature-implementation',
    name: 'Lead team',
    headRole: 'lead',
    members: [],
};

/**
 * The OLD seed value, preserved verbatim for the migration comparison.
 *
 * Every install that opened the AGENTS tab before this change has this
 * exact row persisted on disk. After auto-start, that row would spawn
 * three unrequested coder agent CLIs per lead — the release gate this
 * migration exists to close. The converter identifies an untouched old
 * seed by exact-value comparison against this constant (no marker, no
 * new state) and neutralises it by clearing its members. A group that
 * differs by any field is the operator's and is left alone.
 */
const OLD_SEEDED_AGENT_GROUP: any = {
    id: 'feature-implementation',
    name: 'Feature Implementation',
    headRole: 'lead',
    members: [{ role: 'coder', count: 3, label: '', startupCommand: '' }],
};

/**
 * Convert existing agent groups to the team shape. Runs on every read
 * path that can trigger auto-start, so it is impossible for the
 * auto-start trigger to observe un-migrated data.
 *
 * Three steps, one pass:
 *  1. Neutralise an untouched old seed (exact-value match against
 *     OLD_SEEDED_AGENT_GROUP) by clearing its members. This is the
 *     release gate: without it, the old three-coder seed would spawn
 *     three unrequested agent CLIs per lead on every upgraded install.
 *  2. Add `scope: 'per-team'` and `relationship: 'reports-to-head'`
 *     defaults to every member that lacks them — the final member shape
 *     from the previous subtask. Preserves `label`, `startupCommand`
 *     and any unknown keys on each member.
 *  3. Resolve head-role collisions: the first group by stored order
 *     keeps its head role and becomes active; subsequent groups with
 *     the same head role are marked `unassigned: true` with a note
 *     naming the claimer. Non-destructive — nothing is deleted.
 *
 * Returns `null` when nothing changed (already fully converted), so
 * the caller does not write. Returns the converted array otherwise.
 *
 * This function is pure — it does not touch the DB. The caller decides
 * whether to persist the result (`_loadAgentGroups` does; the
 * `findTeamForHeadRole` read path does not, it matches in-memory).
 */
export function migrateAgentGroups(groups: any[]): any[] | null {
    let changed = false;
    const oldSeed = OLD_SEEDED_AGENT_GROUP;
    const next: any[] = [];

    // ── Step 1+2: neutralise old seed, convert member shape ──────────
    for (const group of groups) {
        if (!group || typeof group !== 'object') {
            // Defensive: skip non-object entries rather than dropping them.
            next.push(group);
            continue;
        }

        let g = { ...group };

        // Step 1: exact-value comparison against the old seed.
        if (isUntouchedOldSeed(g, oldSeed)) {
            // Neutralise: clear members, update name to the new seed's name.
            g = {
                ...g,
                name: SEEDED_AGENT_GROUP.name,
                members: [],
            };
            changed = true;
            console.log(
                `[teamWiring] Migration: neutralised untouched old seed `
                + `'${g.id}' (was 3× coder, now member-less Lead team).`
            );
        }

        // Step 2: convert member shape — add scope/relationship defaults.
        // A missing or non-array `members` is a REPAIR, so flag it here: the
        // `.map` below always produces a new array, which means a later
        // `!Array.isArray(g.members)` test can never fire (it was dead code)
        // and the repair would never be persisted — the converter would return
        // null and the raw, members-less group would keep flowing to the board
        // and to findTeamForHeadRole.
        if (!Array.isArray(g.members)) { changed = true; }
        const members = Array.isArray(g.members) ? g.members : [];
        const convertedMembers = members.map((m: any) => {
            if (!m || typeof m !== 'object') { return m; }
            const converted = { ...m };
            if (converted.scope === undefined) {
                converted.scope = 'per-team';
                changed = true;
            }
            if (converted.relationship === undefined) {
                converted.relationship = 'reports-to-head';
                changed = true;
            }
            // Preserve label, startupCommand, and any unknown keys.
            return converted;
        });
        // Always reseat the array: this is also what converts a group with a
        // missing or non-array `members` into a member-less team (the `changed`
        // flag for that case is set above, before the array is normalised).
        g = { ...g, members: convertedMembers };

        next.push(g);
    }

    // ── Step 3: resolve head-role collisions ─────────────────────────
    // The first group by stored order keeps its head role and becomes the
    // auto-start default; subsequent groups with the same head role are
    // marked unassigned. Non-destructive: nothing is deleted. An unassigned
    // team is visible, editable, explicitly startable, and does not
    // auto-start — the flag means "not the auto-start default", not "broken".
    // Re-assigning its head role to a free one makes it the auto-start
    // default for that role.
    const seenHeadRoles = new Map<string, string>(); // headRole → claiming team name
    for (const g of next) {
        if (!g || !g.headRole) { continue; }
        const headRole = g.headRole;
        if (g.unassigned === true) {
            // Already marked unassigned — check if the collision resolved
            // (e.g. the claimer was deleted or re-assigned).
            if (!seenHeadRoles.has(headRole)) {
                // The claimer is gone — this team can become active again.
                delete g.unassigned;
                delete g.unassignedReason;
                seenHeadRoles.set(headRole, g.name || headRole);
                changed = true;
            } else {
                // Still colliding — update the reason in case the claimer
                // was renamed.
                const claimer = seenHeadRoles.get(headRole)!;
                const reason = `Head role '${headRole}' is the auto-start default for '${claimer}'. This team is startable explicitly but does not auto-start.`;
                if (g.unassignedReason !== reason) {
                    g.unassignedReason = reason;
                    changed = true;
                }
            }
            continue;
        }
        if (seenHeadRoles.has(headRole)) {
            // Collision — mark this group unassigned (not the auto-start
            // default). The team remains visible, editable and explicitly
            // startable; it only loses auto-start on a bare head-role
            // terminal.
            const claimer = seenHeadRoles.get(headRole)!;
            g.unassigned = true;
            g.unassignedReason = `Head role '${headRole}' is the auto-start default for '${claimer}'. This team is startable explicitly but does not auto-start.`;
            changed = true;
            console.log(
                `[teamWiring] Migration: head-role collision on '${headRole}' — `
                + `'${g.name}' is not the auto-start default (auto-start goes to '${claimer}').`
            );
        } else {
            seenHeadRoles.set(headRole, g.name || headRole);
        }
    }

    return changed ? next : null;
}

/**
 * Import existing `addons.delegates` from role config into team definitions.
 * For each role that has a non-empty `addons.delegates` array, create a team
 * where NO existing group claims that head role. Where a group already claims
 * the role, skip — never overwrite an operator's team.
 *
 * This is the retirement migration for the "Delegate children" editor: its
 * config is imported into the team system so an install that configured
 * delegates before the editor was removed keeps spawning the same members.
 * The read path that consumed `addons.delegates` directly is removed in the
 * same change, so this import is the only way that config reaches a spawn.
 *
 * `roleConfigs` is a map of role name → role config object (the same shape
 * `getScopedRoleConfig` returns). Only the `addons.delegates` field is read.
 *
 * Returns `null` when nothing was imported (no delegates, or every role with
 * delegates already has a team). Returns the updated array otherwise.
 *
 * Called from `_loadAgentGroups` in KanbanProvider, which has access to role
 * configs — NOT from `findTeamForHeadRole` or `resolveTeamById`, which run on
 * read-only paths without role config access. The import is a one-time
 * write-back: once the team is persisted, subsequent loads see it in `groups`
 * and the "already claims" check skips it.
 */
export function importDelegatesIntoTeams(
    groups: any[],
    roleConfigs: Record<string, any>
): any[] | null {
    if (!roleConfigs || typeof roleConfigs !== 'object') { return null; }
    const existing = Array.isArray(groups) ? groups : [];
    const claimedHeadRoles = new Set(
        existing.filter(g => g && g.headRole).map(g => g.headRole)
    );

    const imported: any[] = [];
    for (const [role, cfg] of Object.entries(roleConfigs)) {
        if (!cfg || typeof cfg !== 'object') { continue; }
        const delegates = cfg?.addons?.delegates;
        if (!Array.isArray(delegates) || delegates.length === 0) { continue; }
        // A team already claims this head role — never overwrite.
        if (claimedHeadRoles.has(role)) { continue; }

        // Convert delegate entries to team member shape — same defaults as
        // migrateAgentGroups step 2 (scope: per-team, relationship:
        // reports-to-head). Preserve label, startupCommand, and any unknown
        // keys the operator may have set.
        const members = delegates
            .filter(d => d && typeof d === 'object')
            .map((d: any) => ({
                ...d,
                scope: d.scope ?? 'per-team',
                relationship: d.relationship ?? 'reports-to-head',
            }));

        if (members.length === 0) { continue; }

        const team = {
            id: 'imported-delegates-' + role + '-' + Date.now().toString(36),
            name: role.charAt(0).toUpperCase() + role.slice(1) + ' team',
            headRole: role,
            members,
        };
        imported.push(team);
        claimedHeadRoles.add(role);
        console.log(
            `[teamWiring] Delegate import: created team '${team.name}' `
            + `from addons.delegates on role '${role}' (${members.length} member(s)).`
        );
    }

    if (imported.length === 0) { return null; }
    return [...existing, ...imported];
}

/**
 * Exact-value comparison against the old shipped seed. A group that
 * matches every field has demonstrably never been edited by the operator.
 * A group that differs by any field — a renamed group, a different count,
 * an added member, an edited startupCommand — is the operator's and must
 * be left alone.
 */
function isUntouchedOldSeed(group: any, oldSeed: any): boolean {
    if (group.id !== oldSeed.id) { return false; }
    if (group.name !== oldSeed.name) { return false; }
    if (group.headRole !== oldSeed.headRole) { return false; }
    const members = group.members;
    if (!Array.isArray(members) || members.length !== oldSeed.members.length) { return false; }
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const om = oldSeed.members[i];
        if (!m || m.role !== om.role || m.count !== om.count) { return false; }
        // label and startupCommand must be empty string (the shipped defaults).
        if ((m.label || '') !== (om.label || '')) { return false; }
        if ((m.startupCommand || '') !== (om.startupCommand || '')) { return false; }
        // Any extra keys on the member mean it was edited.
        const mKeys = Object.keys(m).sort().join(',');
        const omKeys = Object.keys(om).sort().join(',');
        if (mKeys !== omKeys) { return false; }
    }
    // Check for extra keys on the group itself (e.g. scope, relationship
    // already added by a prior partial migration — those mean it was
    // touched, even if the member matched).
    const gKeys = Object.keys(group).filter(k => k !== 'members').sort().join(',');
    const osKeys = Object.keys(oldSeed).filter(k => k !== 'members').sort().join(',');
    if (gKeys !== osKeys) { return false; }
    return true;
}

/**
 * Look up a team definition whose `headRole` matches the given role.
 *
 * Returns the first match or null. One team per head role is the constraint
 * enforced by the editor and the migration; this function runs the converter
 * in-memory on the raw DB read before matching, so it is impossible for the
 * auto-start trigger to observe un-migrated data — even on an install that
 * has never opened the TEAMS tab in the current session.
 *
 * Used by the auto-start trigger in both hosts' `handlePtyVerb`: when an
 * unparented terminal is created whose role heads a team, the team's members
 * are spawned alongside it. The lookup is a read-only DB query; the definition
 * is not modified at spawn time. The in-memory conversion is not persisted
 * here — `_loadAgentGroups` does the persist when the TEAMS tab is opened.
 */
export async function findTeamForHeadRole(db: any, headRole: string): Promise<any | null> {
    if (!db || !headRole) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        // Run the converter in-memory before matching. This is the fix
        // for the release-gate defect: without it, an install that upgrades
        // and starts a lead without opening the TEAMS tab first would match
        // the un-migrated three-coder old seed and spawn three unrequested
        // agent CLIs. The converter is idempotent and returns null when
        // nothing changed, so the steady-state cost is one comparison per
        // lookup and no write.
        const converted = migrateAgentGroups(groups) ?? groups;
        // Skip unassigned teams — a head-role collision is resolved by the
        // migration marking the loser `unassigned: true`. An unassigned team
        // is visible and editable but does not auto-start.
        return converted.find(g => g && g.headRole === headRole && !g.unassigned) || null;
    } catch (err) {
        console.warn(`[teamWiring] findTeamForHeadRole('${headRole}') failed:`, err);
        return null;
    }
}

/**
 * Resolve a team definition across an ordered list of candidate workspace roots.
 *
 * FIRST ROOT THAT CLAIMS THE HEAD ROLE WINS — not the first root that yields
 * members. A workspace whose team for this role is deliberately member-less is
 * an answer ("start a bare lead here"), and must stop the search rather than
 * fall through to another workspace's team. Every member is a real agent CLI;
 * a silent cross-workspace spawn is a worse failure than no spawn at all.
 *
 * NOTE for the caller: a member-less claim is a REAL outcome, not an
 * almost-miss. `_loadAgentGroups` seeds `SEEDED_AGENT_GROUP` — `headRole:
 * 'lead'`, `members: []` — into any workspace whose TEAMS tab is opened, so a
 * `{ team, root }` with zero members is common and must be reported
 * distinctly from `null`. Collapsing the two is the bug that made the original
 * failure invisible.
 *
 * Returns the match and the root it came from, so the caller can log WHICH
 * workspace answered. Never throws: a root whose DB is unavailable is skipped.
 */
export async function findTeamForHeadRoleInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>,
    headRole: string
): Promise<{ team: any; root: string } | null> {
    for (const root of roots) {
        let db: any;
        try {
            db = await getDb(root);
        } catch (err) {
            console.warn(`[teamWiring] Team lookup: DB unavailable for '${root}':`, err);
            continue;
        }
        if (!db) { continue; }
        const team = await findTeamForHeadRole(db, headRole);
        if (team) { return { team, root }; }
    }
    return null;
}

/**
 * Resolve a single team definition by id, host-side. Runs the migration
 * converter in-memory before matching (same guarantee as
 * `findTeamForHeadRole`: the caller never observes un-migrated data).
 *
 * Unlike `findTeamForHeadRole`, this does NOT skip `unassigned` teams — an
 * unassigned team is explicitly startable, it only loses auto-start. This is
 * the lookup the explicit-start verb uses.
 */
export async function resolveTeamById(db: any, teamId: string): Promise<any | null> {
    if (!db || !teamId) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        const converted = migrateAgentGroups(groups) ?? groups;
        return converted.find(g => g && g.id === teamId) || null;
    } catch (err) {
        console.warn(`[teamWiring] resolveTeamById('${teamId}') failed:`, err);
        return null;
    }
}

/**
 * Start a team by id — the explicit-start path. Host-resolves the definition
 * from `terminals.agentGroups` (never from the wire), reconciles a
 * double-start by refusing if the head role is already live, then delegates
 * to the host's registered instantiator — the existing
 * `instantiateAgentGroup` / `setAgentGroupInstantiator` arm that was finished
 * and never called.
 *
 * Double-start reconciliation: if an active, unparented terminal whose role
 * matches the team's head role is already running, refuse with a specific
 * message naming it. Never spawn a second head under a collision-counter
 * name — that is the drifting-terminal-name defect. A failed liveness check
 * does not block start (the terminal is the product); the instantiator's own
 * caps still guard.
 *
 * `liveTerminals` returns a flat array of active terminals with at least
 * `{ role, friendlyName, parentInstanceId, status }`. `instantiator` is the
 * host's `(group, workspaceRoot) => result` arm.
 */
export async function startTeamById(opts: {
    db: any;
    teamId: string;
    workspaceRoot: string;
    liveTerminals: () => Promise<Array<{ role?: string; friendlyName?: string; parentInstanceId?: any; status?: string }>>;
    instantiator: (group: any, workspaceRoot: string) => Promise<any>;
}): Promise<any> {
    const { db, teamId, workspaceRoot, liveTerminals, instantiator } = opts;
    if (!db) { return { success: false, error: 'Kanban DB not ready' }; }
    if (!teamId) { return { success: false, error: 'Missing team id' }; }

    const team = await resolveTeamById(db, teamId);
    if (!team) { return { success: false, error: `No team found with id '${teamId}'` }; }

    // Double-start: refuse if the head role is already live as an unparented
    // (head) terminal. A delegate is parented by construction, so it cannot
    // match here; a shared member is unparented but a head-role shared member
    // colliding with its own team's start is an operator edge case where
    // refusing is the safe answer.
    try {
        const live = await liveTerminals();
        const headRole = team.headRole;
        const existing = (Array.isArray(live) ? live : []).find(t =>
            t && t.status === 'active' && t.role === headRole && !t.parentInstanceId);
        if (existing) {
            return {
                success: false,
                error: `Team "${team.name}" head role "${headRole}" is already live as "${existing.friendlyName}". Reuse that terminal or stop it first — a second head is not started.`,
            };
        }
    } catch (err: any) {
        console.warn(`[teamWiring] startTeamById: live-terminal check failed, proceeding:`, err);
    }

    return instantiator(team, workspaceRoot);
}

export interface WireSpawnedTeamOptions {
    db: any;
    headName: string;
    children: Array<{ friendlyName: string;[k: string]: any }>;
    /**
     * Member definitions carrying `relationship` and `scope`. When provided,
     * each child is matched to its definition by index (children are in the
     * same order as definitions, expanded by count — see spawnDelegates).
     * When absent (backward compat), every child gets `reports-to-head`.
     */
    members?: Array<{ role: string; count?: number; relationship?: string;[k: string]: any }>;
    /**
     * The team id — the same `id` registered into `terminals.groups` at wiring
     * time. When omitted, derived from `headName` (the same derivation the
     * group registration uses), so the team-scoped standing order and the
     * group always match.
     */
    teamId?: string;
    /**
     * The team prompt — prose carried as one `team`-scoped standing order
     * delivered to every member on every message. When omitted, a default
     * prompt is built from the callback instruction (head name interpolated)
     * plus `GIT_SAFETY_DIRECTIVE`.
     */
    prompt?: string;
    /**
     * Prose delivered to the HEAD of the team on every message, as one
     * `team-head`-scoped standing order. Optional: a team with no head prompt
     * installs no head order. Never defaulted — a fabricated head instruction
     * would be wrong for every team whose head is not a coding lead.
     */
    headPrompt?: string;
}

export interface WireSpawnedTeamResult {
    ok: boolean;
    error?: string;
    /**
     * The terminals-group id registered for this team. Returned so the create
     * response can hand it to the webview verbatim — the id formula below is
     * NOT to be duplicated client-side, where it would drift silently and the
     * grid would fail to seat the team with no error anywhere.
     * Absent when no group was registered (no children, or a failure above).
     */
    groupId?: string;
}

/**
 * Wire a head and its children: install standing orders and register a
 * terminals group. Idempotent on re-run — team-scoped orders are keyed on
 * `(scope, teamId)` and pair-scoped orders on `(parent, child)`. Returns
 * `{ ok, error? }` — never throws at the caller, never rolls back terminals.
 *
 * `db` absent → returns an error, does not crash the create.
 *
 * Team-scoped orders: one `team`-scoped standing order carries the team prompt
 * (callback + safety), delivered to every member on every message via
 * `applyStandingOrders`. The head is excluded by `selectOrders` (the head name
 * is stored in the order's `parent` field). This replaces the pre-teams pattern
 * of N per-member pair rows.
 *
 * Pair-scoped orders: `head-receives` relationship presets (researcher, reviewer,
 * tester, handoff, second-opinion) still emit one pair row each, installed ON
 * the head ABOUT the member — that framing is correct for them.
 */
export async function wireSpawnedTeam(opts: WireSpawnedTeamOptions): Promise<WireSpawnedTeamResult> {
    const { db, headName, children, members, prompt } = opts;

    if (!db) {
        return { ok: false, error: 'Kanban DB not ready' };
    }
    if (!headName || !Array.isArray(children) || children.length === 0) {
        return { ok: true };
    }

    const childNames: string[] = children
        .map(c => c?.friendlyName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (childNames.length === 0) {
        return { ok: true };
    }

    // ── Derive the team id (same as the group registration below) ─────
    const groupId = opts.teamId
        || ('team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_'));

    // ── Build the team prompt ─────────────────────────────────────────
    // The prompt is carried as one team-scoped standing order. When the caller
    // supplies a `prompt` (from the team definition), use it with {child}
    // interpolated to the head name. Otherwise build a default from the
    // callback instruction + GIT_SAFETY_DIRECTIVE (imported, not copied).
    const teamPromptInstruction = prompt
        ? prompt.replace(/\{child\}/g, headName)
        : `${AGENT_GROUP_CALLBACK_INSTRUCTION.replace(/\{child\}/g, headName)}\n${GIT_SAFETY_DIRECTIVE}`;

    // ── Resolve pair-scoped relationships per child ───────────────────
    // Walk the member definitions and children together — children are in the
    // same order as definitions, expanded by count (see spawnDelegates). When
    // `members` is absent (backward compat) or a member has no `relationship`,
    // default to `reports-to-head` — which now collapses into the team prompt
    // rather than generating a pair row.
    //
    // Only `head-receives` presets generate pair-scoped orders. `member-receives`
    // (reports-to-head) is carried by the team-scoped order above.
    interface ResolvedOrder {
        parentName: string;
        childName: string;
        instruction: string;
    }
    const resolvedPairOrders: ResolvedOrder[] = [];

    if (members && Array.isArray(members) && members.length > 0) {
        let childIdx = 0;
        for (const def of members) {
            const count = Math.max(1, Math.min(def.count || 1, 8));
            const relId = def.relationship || DEFAULT_MEMBER_RELATIONSHIP;
            const preset = resolvePresetMeta(relId);
            for (let i = 0; i < count && childIdx < childNames.length; i++) {
                const memberName = childNames[childIdx++];
                if (preset.direction === 'head-receives') {
                    // Order ON the head ABOUT the member — pair-scoped.
                    const instruction = resolvePreset(relId, headName, memberName);
                    resolvedPairOrders.push({ parentName: headName, childName: memberName, instruction });
                }
                // member-receives (reports-to-head) → carried by the team
                // prompt, no pair row.
            }
        }
    }
    // Fallback: no member definitions → all reports-to-head, carried by the
    // team prompt. No pair rows to generate.

    // ── Standing orders ──────────────────────────────────────────────
    // Serialised through mutateStandingOrders' own promise chain.
    //
    // Team-scoped orders are keyed on (scope, teamId) for idempotency — a
    // re-run after partial failure skips a team order that already exists.
    // Pair-scoped orders keep the (parent, child) key.
    try {
        await mutateStandingOrders(db, async (orders) => {
            const next = [...orders];

            // One team-scoped order carrying the team prompt. `parent` stores
            // the head name so `selectOrders` can exclude the head from
            // delivery (the head is in the group's members array but should
            // not receive the member prompt).
            const teamExists = next.some((o: StandingOrder) =>
                o.scope === 'team' && o.teamId === groupId);
            if (!teamExists) {
                next.push(makeStandingOrder(
                    headName,           // parent = head (for exclusion)
                    '',                 // child = empty (team-scoped, no child)
                    teamPromptInstruction,
                    'team',
                    groupId,
                ));
            }

            // Head-facing order. Keyed on (scope, teamId) exactly like the member
            // order, so a re-run of wireSpawnedTeam skips it rather than duplicating.
            // Same mutator as the team order above — do not split this into a second
            // mutateStandingOrders call; that reopens a read-modify-write window.
            const headPromptText = (opts.headPrompt || '').trim();
            if (headPromptText) {
                const headExists = next.some((o: StandingOrder) =>
                    o.scope === 'team-head' && o.teamId === groupId);
                if (!headExists) {
                    next.push(makeStandingOrder(
                        headName,   // parent = head (the delivery target for this scope)
                        '',         // child = '' — old-build safety, see selectOrders
                        headPromptText.replace(/\{head\}/g, headName),
                        'team-head',
                        groupId,
                    ));
                }
            }

            // Pair-scoped orders for head-receives presets.
            for (const ro of resolvedPairOrders) {
                const exists = next.some((o: StandingOrder) =>
                    o.parent === ro.parentName && o.child === ro.childName);
                if (!exists) {
                    next.push(makeStandingOrder(ro.parentName, ro.childName, ro.instruction));
                }
            }
            return next;
        });
    } catch (err: any) {
        return { ok: false, error: `Standing-order install failed: ${err?.message || err}` };
    }

    // ── Group registration ───────────────────────────────────────────
    // The backend becomes a second writer to a key the webview owns. The
    // write is serialised through _groupsWriteChain so two concurrent heads
    // do not drop one another's group. The caller pushes a
    // `terminalsGroupsChanged` broadcast after a successful registration so
    // open panels re-read the key before their next whole-array save can
    // clobber it.
    //
    // source: 'manual' — loadLayoutSettings (terminals.js) silently discards
    // any group whose source is not manual/role/worktree.
    //
    // NOT `members` — that name is taken by the member DEFINITIONS destructured
    // from opts above. Shadowing it here was a TS2451 redeclaration that broke
    // the build for the whole extension.
    const groupMembers = [headName, ...childNames];
    const layout = layoutForTeamSize(groupMembers.length);
    const group = {
        id: groupId,
        name: headName,
        source: 'manual' as const,
        layout,
        members: groupMembers,
        order: groupMembers,
    };

    try {
        const p = _groupsWriteChain.then(async () => {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            const current = Array.isArray(raw) ? raw : [];
            // Idempotent — skip if a group with this id already exists.
            if (current.some((g: any) => g && g.id === groupId)) { return; }
            const next = [...current, group];
            await db.setConfigJson(TERMINALS_GROUPS_KEY, next);
        });
        _groupsWriteChain = p.catch(() => {});
        await p;
    } catch (err: any) {
        // A failed group write must not undo a successful order install.
        return { ok: false, error: `Group registration failed: ${err?.message || err}` };
    }

    return { ok: true, groupId };
}

/**
 * Migrate existing per-member pair rows into a team-scoped order.
 *
 * Before this change, `wireSpawnedTeam` wrote one `(member, head)` pair row
 * per member, each carrying `PRE_REWRITE_CALLBACK_INSTRUCTION`. This function
 * recognises those rows, groups them by head, and folds them into a single
 * `team`-scoped order carrying the default team prompt (callback + safety).
 * Unrecognised rows — operator-edited ad-hoc link-up orders, `head-receives`
 * presets — are left untouched.
 *
 * Pure: no DB writes. Called at the standing-orders read sites so the
 * transformation is applied before `applyStandingOrders` renders. The old
 * pair rows stay in the DB but are filtered from the rendered set; the
 * function is idempotent because the team-scoped order it produces is keyed
 * on `(scope, teamId)` and a second pass finds no recognisable pair rows to
 * convert (they were already replaced in the returned array).
 *
 * The recogniser matches the PRE-rewrite callback text — that is what is
 * actually on disk. Matching the post-rewrite constant would miss every
 * existing install's rows.
 */
export function migrateTeamPairOrders(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }

    // Find pair orders whose instruction is the pre-rewrite callback text.
    // In the `member-receives` direction, `parent` = member, `child` = head.
    // Group by head name (the `child` field).
    const groups = new Map<string, string[]>(); // headName → memberNames
    const recognised = new Set<string>(); // order ids to remove

    for (const o of orders) {
        if (!o || typeof o !== 'object') { continue; }
        // Only pair-scoped (or unscoped = pair default) orders are candidates.
        const scope = o.scope || 'pair';
        if (scope !== 'pair') { continue; }
        if (o.instruction !== PRE_REWRITE_CALLBACK_INSTRUCTION) { continue; }
        const headName = o.child;
        if (!headName) { continue; }
        const memberName = o.parent;
        if (!memberName) { continue; }

        if (!groups.has(headName)) { groups.set(headName, []); }
        groups.get(headName)!.push(memberName);
        recognised.add(o.id);
    }

    if (recognised.size === 0) { return orders; }

    // Build the replacement team-scoped orders.
    const migrated: StandingOrder[] = [];
    for (const [headName] of groups) {
        const teamId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
        const callbackText = AGENT_GROUP_CALLBACK_INSTRUCTION.replace(/\{child\}/g, headName);
        const instruction = `${callbackText}\n${GIT_SAFETY_DIRECTIVE}`;
        migrated.push(makeStandingOrder(
            headName,   // parent = head (for selectOrders exclusion)
            '',         // child = empty (team-scoped, no child)
            instruction,
            'team',
            teamId,
        ));
    }

    // Return the array with recognised pair rows removed and team-scoped
    // orders added. If a team-scoped order with the same teamId already
    // exists (e.g. from a prior wireSpawnedTeam call), do not duplicate.
    const existingTeamIds = new Set(
        orders.filter(o => o && o.scope === 'team' && o.teamId)
            .map(o => o.teamId!)
    );
    const newTeamOrders = migrated.filter(o => !existingTeamIds.has(o.teamId!));

    return [
        ...orders.filter(o => !recognised.has(o.id)),
        ...newTeamOrders,
    ];
}

/**
 * The terminal name recorded against a plan, or `''` when what is recorded is
 * not a terminal name. Pure and exported so both the API dispatch path
 * (`LocalApiServer._plausibleOriginTerminal`) and the drag path
 * (`TaskViewerProvider.handleKanbanTrigger`) apply the identical filter, and so
 * it is unit-testable on its own.
 *
 * `dispatched_terminal` is only ever a real name (written by
 * `attributePasteDispatch`). `dispatched_agent` can also be:
 *  - `'unknown'` — `_recordDispatchIdentity`'s no-terminal-name branch;
 *  - an IDE-shaped `"<IDE name> <role>"` string — its `isIdeDispatch` branch;
 *  - a bare role word — the paste-attribution path writes `msg.role` there.
 * None of those is a terminal name, and the group-membership requirement in
 * `resolveTeamScopedRoleTerminal` filters them in practice — but filter them
 * explicitly so a terminal an operator happened to name `coder` cannot become
 * an origin.
 */
export function plausibleOriginTerminal(record: any): string {
    const KNOWN_ROLE_WORDS = new Set([
        'planner', 'coder', 'lead', 'reviewer', 'intern', 'tester', 'analyst', 'researcher',
    ]);
    const terminal = String(record?.dispatchedTerminal || '').trim();
    if (terminal) { return terminal; }
    const agent = String(record?.dispatchedAgent || '').trim();
    if (!agent || agent === 'unknown') { return ''; }
    if (KNOWN_ROLE_WORDS.has(agent.toLowerCase())) { return ''; }
    const ide = String(record?.dispatchedIde || '').trim();
    if (ide && agent.startsWith(ide + ' ')) { return ''; }
    return agent;
}

/**
 * Resolve the terminal of `role` that belongs to the SAME registered team as
 * `originName`.
 *
 * `terminals.groups` is the authoritative roster: `wireSpawnedTeam` writes one
 * entry per started team whose `members` array holds the head plus every child,
 * including `scope: 'shared'` members (which are unparented and therefore
 * invisible to any `parentInstanceId`-based lookup). This is the only place team
 * membership is recorded, and until now the dispatch path never read it.
 *
 * Returns `null` — never a guess — when there is no group for the origin, no
 * member of that role, or no live candidate. The caller then falls back to the
 * workspace-wide resolution and MUST report that it did.
 *
 * Role matching uses the live terminal's own `role` field, never its name:
 * names are `${head}-${role}` by convention only and survive no rename.
 *
 * Pure over `(db, liveTerminals)` on purpose: the standalone host can call it
 * with `ptyFleetService.listActive()` without constructing a `TaskViewerProvider`.
 */
export async function resolveTeamScopedRoleTerminal(opts: {
    db: any;
    originName: string;
    role: string;
    /** Live terminals: `{ name, role }`. Caller supplies the union of the pty fleet and the VS Code registry. */
    liveTerminals: Array<{ name: string; role?: string }>;
    /** Same normaliser the existing role resolvers use, injected to avoid a provider import. */
    normalizeRole: (r: string | undefined) => string;
}): Promise<string | null> {
    const { db, originName, role, liveTerminals, normalizeRole } = opts;
    if (!db || !originName || !role) { return null; }

    let groups: any[] = [];
    try {
        groups = await db.getConfigJson('terminals.groups', []) as any[];
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    const wanted = normalizeRole(role);
    const liveByName = new Map<string, string>();
    for (const t of liveTerminals) {
        if (t && t.name) { liveByName.set(t.name, normalizeRole(t.role)); }
    }

    const candidatesIn = (g: any): string | null => {
        const roster: string[] = Array.isArray(g?.order) && g.order.length
            ? g.order
            : (Array.isArray(g?.members) ? g.members : []);
        for (const name of roster) {
            if (name === originName) { continue; }       // never dispatch to yourself
            if (liveByName.get(name) === wanted) { return name; }
        }
        return null;
    };

    // Preferred: the group the origin HEADS (its id is derived from the head name,
    // same derivation as wireSpawnedTeam's groupId).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    const headGroup = groups.find(g => g && g.id === headId);
    if (headGroup) {
        const hit = candidatesIn(headGroup);
        if (hit) { return hit; }
    }

    // Otherwise: first group (in stored order) that contains the origin AND a live
    // terminal of the wanted role. Deterministic, and a shared member legitimately
    // present in several groups resolves the same way from any of its heads.
    for (const g of groups) {
        if (!g || !Array.isArray(g.members) || !g.members.includes(originName)) { continue; }
        const hit = candidatesIn(g);
        if (hit) { return hit; }
    }
    return null;
}
