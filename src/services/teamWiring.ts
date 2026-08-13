import {
    mutateStandingOrders,
    makeStandingOrder,
    MAX_ORDERS,
    StandingOrder,
} from './standingOrders';
import { resolvePreset, resolvePresetMeta, DEFAULT_MEMBER_RELATIONSHIP } from './linkPresets';

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
 * The callback contract installed on every worker.
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
 */
export const AGENT_GROUP_CALLBACK_INSTRUCTION =
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
    // The first group by stored order keeps its head role; subsequent
    // groups with the same head role are marked unassigned. Non-destructive:
    // nothing is deleted. An unassigned team is visible, editable, and
    // does not auto-start. Re-assigning its head role to a free one makes
    // it active.
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
                if (g.unassignedReason !== `Head role '${headRole}' claimed by '${claimer}'`) {
                    g.unassignedReason = `Head role '${headRole}' claimed by '${claimer}'`;
                    changed = true;
                }
            }
            continue;
        }
        if (seenHeadRoles.has(headRole)) {
            // Collision — mark this group unassigned.
            const claimer = seenHeadRoles.get(headRole)!;
            g.unassigned = true;
            g.unassignedReason = `Head role '${headRole}' claimed by '${claimer}'`;
            changed = true;
            console.log(
                `[teamWiring] Migration: head-role collision on '${headRole}' — `
                + `'${g.name}' marked unassigned (claimed by '${claimer}').`
            );
        } else {
            seenHeadRoles.set(headRole, g.name || headRole);
        }
    }

    return changed ? next : null;
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
    } catch {
        return null;
    }
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
}

export interface WireSpawnedTeamResult {
    ok: boolean;
    error?: string;
}

/**
 * Wire a head and its children: install standing orders and register a
 * terminals group. Idempotent on re-run (skip an existing `(child, head)`
 * order pair; skip an existing group id). Returns `{ ok, error? }` — never
 * throws at the caller, never rolls back terminals.
 *
 * `db` absent → returns an error, does not crash the create.
 */
export async function wireSpawnedTeam(opts: WireSpawnedTeamOptions): Promise<WireSpawnedTeamResult> {
    const { db, headName, children, members } = opts;

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

    // ── Resolve relationships per child ──────────────────────────────
    // Walk the member definitions and children together — children are in the
    // same order as definitions, expanded by count (see spawnDelegates). When
    // `members` is absent (backward compat) or a member has no `relationship`,
    // default to `reports-to-head` — byte-identical to today's behaviour.
    //
    // Each resolved preset carries a `direction`:
    //  'member-receives' → order installed ON the member ABOUT the head
    //    (parent=member, child=head in standing-orders terms)
    //  'head-receives'   → order installed ON the head ABOUT the member
    //    (parent=head, child=member)
    //
    // Direction is read from the preset, never inferred from position — a
    // flipped order is silent and produces a coder that reports to nobody.
    interface ResolvedOrder {
        parentName: string;
        childName: string;
        instruction: string;
    }
    const resolvedOrders: ResolvedOrder[] = [];
    if (members && Array.isArray(members) && members.length > 0) {
        let childIdx = 0;
        for (const def of members) {
            const count = Math.max(1, Math.min(def.count || 1, 8));
            const relId = def.relationship || DEFAULT_MEMBER_RELATIONSHIP;
            const preset = resolvePresetMeta(relId);
            for (let i = 0; i < count && childIdx < childNames.length; i++) {
                const memberName = childNames[childIdx++];
                if (preset.direction === 'member-receives') {
                    // Order ON the member ABOUT the head.
                    const instruction = resolvePreset(relId, memberName, headName);
                    resolvedOrders.push({ parentName: memberName, childName: headName, instruction });
                } else {
                    // Order ON the head ABOUT the member.
                    const instruction = resolvePreset(relId, headName, memberName);
                    resolvedOrders.push({ parentName: headName, childName: memberName, instruction });
                }
            }
        }
    }
    // Fallback: no member definitions → today's behaviour (reports-to-head on
    // every child). An install with neither `scope` nor `relationship` must
    // behave exactly as it does today.
    if (resolvedOrders.length === 0) {
        for (const childName of childNames) {
            resolvedOrders.push({
                parentName: childName,
                childName: headName,
                instruction: AGENT_GROUP_CALLBACK_INSTRUCTION,
            });
        }
    }

    // ── Standing orders ──────────────────────────────────────────────
    // Serialised through mutateStandingOrders' own promise chain. The
    // MAX_ORDERS check is INSIDE the mutator so it reads the current state at
    // execution time, not a stale pre-flight read. Fail with a specific error
    // rather than silently installing a partial set.
    //
    // Idempotency key is (parent, child) — a re-run after partial failure
    // skips pairs that already exist. A head-receives order and a
    // member-receives order for the same pair have DIFFERENT (parent, child)
    // tuples, so they do not collide.
    try {
        await mutateStandingOrders(db, async (orders) => {
            const next = [...orders];
            let toAdd = 0;
            for (const ro of resolvedOrders) {
                const exists = next.some((o: StandingOrder) => o.parent === ro.parentName && o.child === ro.childName);
                if (!exists) { toAdd++; }
            }
            if (toAdd > 0 && next.length + toAdd > MAX_ORDERS) {
                throw new Error(
                    `Standing-orders cap: ${next.length} registered, ${toAdd} requested, `
                    + `${MAX_ORDERS} allowed in total — cannot wire team without exceeding the cap`
                );
            }
            for (const ro of resolvedOrders) {
                const exists = next.some((o: StandingOrder) => o.parent === ro.parentName && o.child === ro.childName);
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
    const groupId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
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

    return { ok: true };
}
