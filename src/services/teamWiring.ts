import {
    mutateStandingOrders,
    mutateStandingOrderDefinitions,
    makeStandingOrder,
    makeFragmentStandingOrder,
    makeStandingOrderDefinition,
    reSyncAssignmentsToDefinitions,
    materializeStandingOrderForInspection,
    listCoreStandingOrders,
    StandingOrder,
    StandingOrderDefinition,
    StandingOrderScope,
    TerminalGroup,
    STANDING_ORDERS_CONFIG_KEY,
    STANDING_ORDER_DEFINITIONS_CONFIG_KEY,
} from './standingOrders';
import {
    composeStandingOrderFragments,
    GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY,
    STANDING_ORDER_FRAGMENT_IDS,
    StandingOrderCompositionContext,
    TEAM_HEAD_COMMIT_FRAGMENT_BODY,
} from './standingOrderFragments';
import { resolvePreset, resolvePresetMeta, DEFAULT_MEMBER_RELATIONSHIP } from './linkPresets';
import { substituteCliPath } from '../utils/cliPathToken';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { bootstrapTeamReportsDirectory } from './ScheduledJobsService';
import * as fs from 'fs';
import * as path from 'path';

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
 * Standing-order template for an agent running in any local terminal that
 * Switchboard cannot push into (plain shell, iTerm, tmux pane, editor chat
 * pane). The agent registers itself, heartbeats, polls for work, and reports
 * done — all via HTTP endpoints, never via host files. The heartbeat interval
 * is ≤60s to stay within the dispatch-routing liveness threshold
 * (`_getAliveAutobanTerminalRegistry` uses 60_000ms). See plan
 * `register-an-agent-in-any-local-terminal.md`.
 */
export const EXTERNAL_AGENT_PULL_INSTRUCTION =
    'You are running in a terminal Switchboard cannot push into. To receive work, pull it.\n'
    + 'Every call below goes through the CLI: `node "<cliPath>" api <METHOD> <path> \'<json>\'`. '
    + 'Do NOT make raw HTTP requests. Anything that changes state is covered by a CSRF guard — a request '
    + 'with no `Origin`, no `Sec-Fetch-Site` and no `X-Switchboard-Client` marker is refused with '
    + '403 `cross-site request rejected`. The CLI sets that marker; curl and hand-built fetches do not. '
    + 'Note the shape of that failure: GET is exempt, so your polling would keep working while every '
    + 'register and heartbeat is refused — the board looks reachable while you are not actually registered.\n'
    + '1. REGISTER: `node "<cliPath>" api POST /agents/register \'{"seat":"<your name>","role":"<role>","workspaceRoot":"<root>","cwd":"<cwd>"}\'`. '
    + 'Save the returned token — you need it for every subsequent call.\n'
    + '2. HEARTBEAT: `node "<cliPath>" api POST /agents/heartbeat \'{"seat":"<your name>","token":"<token>"}\'` every 50 seconds (≤60s).\n'
    + '3. POLL: `node "<cliPath>" api GET "/agents/inbox?seat=<your name>&token=<token>"` — returns pending dispatch items. Poll every 5-10 seconds.\n'
    + '4. DONE: When you finish a dispatched item, report completion with the CLI — `node "<cliPath>" done` for your own work, or `node "<cliPath>" accept --plan "<planId>"` if you are a lead accepting a subtask. Do NOT POST the completion endpoints directly: they are state-changing, so the CSRF guard refuses any request without an `X-Switchboard-Client` marker, and the CLI is what sets it.\n'
    + 'The CLI resolves the host and port itself — you do not need the port and must not probe for it.';

/**
 * Every layout the terminals panel will LOAD — the keys of `LAYOUTS` in
 * terminals.js.
 *
 * Use this to decide whether a stored `layout` on an existing roster row names a
 * real grid. `'2v'` is in the set and matters: it is a first-class operator choice
 * with its own layout button that `layoutForGroupSwitch` honours, and any narrower
 * whitelist here would revert precisely the one mode that can only have come from a
 * human.
 *
 * A team is no longer sized at spawn — it registers with TERMINALS_AUTO_LAYOUT and
 * the panel resolves the grid from the roster on every entry, so the slot ladder this
 * file used to carry (and the `layoutForTeamSize` that walked it) is gone. Nothing
 * here picks a concrete mode any more; it only validates one it is handed.
 *
 * Pinned to terminals.js by `standing-orders-marker-contract.test.js`.
 */
export const TERMINALS_LAYOUT_MODES: ReadonlySet<string> = new Set([
    '1', '2h', '2v', '1x3', '2x2', '2x3', '3x3',
]);

/**
 * The panel's layout PREFERENCE sentinel: "size this group's grid to its roster".
 * Mirrors `AUTO_LAYOUT` in terminals.js. Not a rendered layout and deliberately not
 * a member of TERMINALS_LAYOUT_MODES, which is pinned byte-identical to the panel's
 * `LAYOUTS` keys.
 */
export const TERMINALS_AUTO_LAYOUT = 'auto';

/**
 * Every layout value the panel will LOAD from a stored group row — the rendered
 * modes plus the 'auto' preference. Use this, never TERMINALS_LAYOUT_MODES, to decide
 * whether an existing row's `layout` is keepable: validating a stored 'auto' against
 * the rendered modes would overwrite it with a computed size on the next spawn, which
 * is precisely the "the team grew and the grid did not" defect 'auto' exists to end.
 */
export const TERMINALS_STORABLE_LAYOUTS: ReadonlySet<string> = new Set([
    TERMINALS_AUTO_LAYOUT, ...TERMINALS_LAYOUT_MODES,
]);

/**
 * Read a team group's pacing mode. Tri-state: absent OR `'head'` → `'head'`;
 * only a literal `'seat'` reads as `'seat'`. This is the compatibility contract
 * for ~4,000 installs — a stale writer defaulting a boolean to `false` could
 * silently flip the whole install base to seat pacing, which is why the field
 * is tri-state and absent means head. One read site, used by the pop
 * (subtask 1), the watch (subtask 3), and `Run queue`'s status text.
 */
export function readTeamPacing(group: any): 'head' | 'seat' {
    return group && group.pacing === 'seat' ? 'seat' : 'head';
}

/**
 * Pair-programming intensity carried on a team definition. The team field is
 * INTENSITY ONLY (`off | on | aggressive`); the host-routing dimension that the
 * board enum's `cli-cli`/`cli-ide`/`ide-cli`/`ide-ide` values carry is implicit
 * in the team's roster (the lead and coder seats are the team's own terminals).
 *
 * Default `'on'` for a team that has not set one — a team is a lead plus
 * cheaper seats, and the default should use them (see the plan "Pair
 * Programming Belongs to the Team"). An invalid/absent value reads as `'on'`
 * because teams are unreleased: there is no installed base whose prior choice
 * this default could surprise, and the structural argument for on-by-default
 * is the whole reason the field exists on the team at all.
 */
export type TeamPairProgrammingIntensity = 'off' | 'on' | 'aggressive';

export function readTeamPairProgramming(group: any): TeamPairProgrammingIntensity {
    const v = group && group.pairProgramming;
    if (v === 'off') { return 'off'; }
    if (v === 'aggressive') { return 'aggressive'; }
    return 'on';
}

/**
 * Resolve the team **definition** (`terminals.agentGroups` row) whose live
 * spawned group the given terminal heads (or belongs to). This is the
 * team-scoped entry point for the pair-programming field: a dispatch that
 * targets a team's head terminal resolves its definition here, then reads
 * `pairProgramming` via {@link readTeamPairProgramming}.
 *
 * Mirrors {@link resolveTeamMembersForHead}'s group lookup (same `team_<head>`
 * id derivation, same bare-key merge, same "group the origin heads, else first
 * group containing the origin" order) but returns the DEFINITION rather than
 * the roster, via {@link resolveDefinitionForGroup}. Returns `null` when the
 * terminal heads no team, the definition was deleted, or the role-match
 * fallback is ambiguous — callers fall back to the board/global value.
 */
export async function resolveTeamDefinitionForHeadTerminal(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
}): Promise<any | null> {
    const { db, settings, originName } = opts;
    if ((!db && !settings) || !originName) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    // Preferred: the group the origin HEADS (same id derivation as
    // resolveTeamMembersForHead and wireSpawnedTeam).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    let headGroup = groups.find(g => g && g.id === headId);
    // Otherwise: first group (in stored order) that contains the origin.
    if (!headGroup) {
        headGroup = groups.find(g =>
            g && Array.isArray(g.members) && g.members.includes(originName));
    }
    if (!headGroup) { return null; }
    return resolveDefinitionForGroup(db, headGroup);
}

/**
 * Resolve the PAIR BAND for a terminal from its POSITION on its team, not from
 * its role string.
 *
 * The team's HEAD takes Band B (Complex / Risky); its SEATS take Band A
 * (Routine). That is the whole rule, and it is why a `coder` seat on the Feature
 * team and a `coder` head on the Coding team get different bands from the same
 * role string. Inferring the band from the role told BOTH seats of a
 * coder-headed team to do only Routine work, and nobody did the complex half.
 *
 * `counterpartRole` names the OTHER half so the prose can say who is doing it:
 * for a head, the first seat role on the roster that can take routine work; for
 * a seat, the team's head role. Absent when the team has no other half — the
 * prose then names no counterpart rather than guessing.
 *
 * Returns `null` when the terminal belongs to no team — the non-team path, where
 * the caller keeps the historical role mapping and tags it `'role-default'`.
 */
export async function resolveTeamPairBandForTerminal(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
}): Promise<{
    band: 'A' | 'B';
    source: 'team-head' | 'team-seat';
    counterpartRole?: string;
    teamId?: string;
} | null> {
    const { db, settings, originName } = opts;
    if ((!db && !settings) || !originName) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    // Same id derivation as resolveTeamMembersForHead and wireSpawnedTeam: the
    // group the origin HEADS. `head` is read, never inferred from order[0] —
    // the two diverge when an operator reorders.
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    let group = groups.find(g => g && g.id === headId);
    let isHead = Boolean(group);
    if (!group) {
        group = groups.find(g => g && Array.isArray(g.members) && g.members.includes(originName));
        if (!group) { return null; }
        isHead = teamHeadName(group) === originName;
    }

    const def = await resolveDefinitionForGroup(db, group);
    if (!def) { return null; }
    const members: any[] = Array.isArray(def.members) ? def.members : [];
    const headRole = typeof def.headRole === 'string' ? def.headRole : undefined;
    const seatRole = members.find((m: any) => m && (m.role === 'coder' || m.role === 'intern'))?.role
        || members.find((m: any) => m && typeof m.role === 'string' && m.role)?.role;

    return isHead
        ? { band: 'B', source: 'team-head', counterpartRole: seatRole, teamId: def.id }
        : { band: 'A', source: 'team-seat', counterpartRole: headRole, teamId: def.id };
}

// ─── tmux session name derivation ─────────────────────────────────────────
// tmux session names cannot contain `.` or `:` and should be shell-safe.
// Team names are free-form user strings, so sanitize to `[a-z0-9_-]` and
// prefix with `lc-` to namespace LABCOM-owned sessions (distinguishes
// from user sessions like `board`). All tmux invocations use execFile with
// an argv array (Part 1's contract), so the session name is passed as a
// single argv element to `-s` — never interpolated into a command string.
export function deriveTmuxSessionName(teamName: string): string {
    // `lc-` for LABCOM. The prefix is load-bearing, not decoration: it separates the
    // board's sessions from the operator's own in `tmux ls`, and lets cleanup match
    // `^lc-` without touching theirs. It was `sb-`, the old product name.
    return 'lc-' + String(teamName || 'team')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50);
}

// ─── Shared seat-name derivation ──────────────────────────────────────────
// Both the PTY fleet and the tmux seating callback must produce IDENTICAL
// friendlyName values for the same team — dispatch attribution, completion
// reports, and standing-order delivery all key on the name. The fleet's
// `create()` applies a collision counter (`${role}-${n}` when the base name
// is taken); the tmux path must use the same derivation. These helpers
// extract the name-derivation logic so both backends call one function.
//
// The collision counter checks a `taken` set that the caller populates as
// it allocates names. The fleet populates it from `this.terminals`; the
// tmux path populates it from pane titles already in the session.

/**
 * Derive a seat name with collision counter, mirroring `PtyFleetService.create()`.
 * If `baseName` is free, use it. If not, fall back to `${role}-${counter}`.
 */
export function deriveSeatName(baseName: string, role: string, taken: Set<string>): string {
    let name = baseName || `${role}-1`;
    if (!taken.has(name)) {
        taken.add(name);
        return name;
    }
    let counter = 1;
    do {
        counter++;
        name = `${role}-${counter}`;
    } while (taken.has(name));
    taken.add(name);
    return name;
}

/**
 * Derive the base name for a per-team (parented) delegate, mirroring
 * `spawnDelegates` at `ptyFleetService.ts:978-979`.
 * `${parentName}-${label||role}${suffix}` where suffix is `-${i+1}` if count > 1.
 */
export function deriveDelegateBaseName(
    parentName: string,
    def: { label?: string; role: string; count?: number },
    index: number
): string {
    const count = Math.max(1, def.count || 1);
    const suffix = count > 1 ? `-${index + 1}` : '';
    return `${parentName}-${def.label || def.role}${suffix}`;
}

/**
 * Derive the name for a shared member, mirroring `spawnDelegates` at
 * `ptyFleetService.ts:925-929`.
 * `${teamName}-${label||role}${suffix}` where suffix is `-${i+1}` if count > 1.
 */
export function deriveSharedMemberName(
    teamName: string,
    def: { label?: string; role: string; count?: number },
    index: number
): string {
    const count = Math.max(1, def.count || 1);
    const suffix = count > 1 ? `-${index + 1}` : '';
    return `${teamName}-${def.label || def.role}${suffix}`;
}

/**
 * The queue/done instruction appended to the team-scoped standing order for
 * head-paced team coders. Tells the coder to POST /kanban/queue/done when it
 * has finished ALL work on the dispatched plan — not after individual parts.
 * This is the explicit completion signal that replaces the unreliable mtime-
 * based file-watcher detection. The endpoint clears the card's activity light
 * and fires the turn-end notification to the lead.
 *
 * **Two copies only: this one and the `terminals.js` mirror** (which cannot
 * import). `stage-marker-commit-contract.test.js` gates both halves.
 */
export const TEAM_CODER_QUEUE_DONE_INSTRUCTION =
    'When you have finished ALL parts of the dispatched plan, run node "<cliPath>" done '
    + '(or switchboard done). '
    + 'This signals completion — the system clears your activity light and notifies your lead. '
    + 'Do NOT report after finishing individual parts — only when ALL work is complete. '
    + 'If you cannot complete it, run node "<cliPath>" done '
    + '--outcome failed with a one-line reason.';

/**
 * The standing-order body installed at `global` scope so a standalone agent
 * (not on any team) reports done itself — there is no team head to report to
 * and no team-scoped order to carry the instruction.
 *
 * Installed by {@link installGlobalQueueDoneOrder} on the first non-team queue
 * dispatch (the fallback path in `_runQueuePop`). `global` scope applies to ALL
 * terminals (standingOrders `selectOrders` returns true for every terminal),
 * which is harmless to non-coding terminals (they have no dispatched card to
 * complete) and redundant — not conflicting — for team agents who already have
 * a team-scoped order with the same instruction.
 */
export const GLOBAL_QUEUE_DONE_ORDER_BODY = GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY;

/**
 * Deterministic id for the global queue/done standing order, so it can be
 * found and removed without scanning instruction text. One order at `global`
 * scope — the id is unique.
 */
const GLOBAL_QUEUE_ORDER_ID = 'global-queue-done:global';

/**
 * Install the `global`-scoped `queue/done` standing order so a standalone
 * agent (not on any team) knows to POST `queue/done` when it finishes a
 * dispatched card. Idempotent: if the order already exists, the mutation is a
 * no-op. Serialized through `mutateStandingOrders`' own chain.
 *
 * Called from `_runQueuePop` on the non-team fallback path (when `from` is a
 * live terminal not on any team). The order persists across sessions — it is
 * installed once and stays until manually removed.
 */
export async function installGlobalQueueDoneOrder(db: any): Promise<void> {
    if (!db) return;
    await mutateStandingOrders(db, async (orders) => {
        if (orders.some(o => o.id === GLOBAL_QUEUE_ORDER_ID)) {
            return orders;
        }
        const order = makeFragmentStandingOrder(
            '', '', [STANDING_ORDER_FRAGMENT_IDS.globalCompletion, STANDING_ORDER_FRAGMENT_IDS.subagentPolicy], 'global',
        );
        // makeStandingOrder mints a random id; overwrite with the deterministic
        // one so a re-run finds it rather than duplicating.
        return [...orders, { ...order, id: GLOBAL_QUEUE_ORDER_ID }];
    });
}

/** Config key the terminals webview owns for `terminals.groups`. */
export const TERMINALS_GROUPS_KEY = 'switchboard.prompts.terminals.groups';

/**
 * Settings accessor interface for scoped settings access without importing KanbanProvider.
 */
export interface TerminalGroupsSettingsAccessor {
    /**
     * Sync in the extension host (`KanbanProvider._getScopedSetting` reads a
     * sql.js DB synchronously), async in hosts that await a store — every caller
     * awaits, so both shapes satisfy this. Do NOT narrow to `Promise<T>`: it
     * rejects the extension host's own accessor.
     */
    get<T>(key: string, defaultValue: T): T | Promise<T>;
    set<T>(key: string, value: T): void | Promise<void>;
}

export interface MutateTerminalGroupsOptions {
    db?: {
        getConfigJson: (key: string, fallback: any) => Promise<any>;
        /** `KanbanDatabase.setConfigJson` resolves `boolean` — the result is unused. */
        setConfigJson: (key: string, value: any) => Promise<any>;
    };
    settings?: TerminalGroupsSettingsAccessor;
}

/**
 * Module-level promise chain serialising `terminals.groups` read-modify-write
 * cycles, in the style of `mutateStandingOrders` and
 * `KanbanProvider._mutateAgentGroups`. Two heads spawning concurrently must
 * not drop one another's group — the webview saves the WHOLE in-memory array,
 * so a stale read clobbers a concurrent write.
 */
let _groupsWriteChain: Promise<unknown> = Promise.resolve();

/**
 * Ledger of bare-key group ids already imported into TERMINALS_GROUPS_KEY.
 *
 * The bare row is never deleted (downgrade safety, per the plan), so without a
 * ledger the import re-runs on EVERY mutation and an operator who deletes a
 * migrated team group gets it back on their next save — forever. Recording the
 * ids makes the import genuinely once-per-id: a row the operator later removes
 * stays removed, while a bare id written by a downgraded build is still new and
 * still imports.
 */
const TERMINALS_GROUPS_BARE_IMPORTED_KEY = 'switchboard.prompts.terminals.groups.bareImportedIds';

/**
 * Flag existing team groups in the terminals.groups array with `teamGroup: true`.
 * Team groups have IDs starting with 'team_' (from wireSpawnedTeam's groupId
 * derivation). Manual groups (`grp_`) are ephemeral in-memory session state
 * and do not live in this durable store.
 *
 * Returns `null` when nothing changed (already fully flagged), so the caller
 * does not write. Returns the converted array otherwise.
 *
 * This function is pure — it does not touch the DB.
 */
export function migrateTeamGroupFlags(groups: any[]): any[] | null {
    if (!Array.isArray(groups) || groups.length === 0) { return null; }
    let changed = false;
    const next = groups.map(g => {
        if (!g || typeof g !== 'object') { return g; }
        if (g.id && typeof g.id === 'string' && g.id.startsWith('team_') && !g.teamGroup) {
            changed = true;
            return { ...g, teamGroup: true };
        }
        return g;
    });
    return changed ? next : null;
}

/**
 * Mutate terminal groups atomically inside _groupsWriteChain.
 * Handles bare 'terminals.groups' legacy migration once per id on first read.
 *
 * A failure to READ the current array propagates — it must never be treated as
 * "there was nothing stored", because the transform that follows WRITES. The
 * sql.js heap-exhaustion failure this repo has hit before makes every read a
 * candidate for throwing, and defaulting to `[]` there wipes the roster the
 * guard exists to protect. Callers already handle a throw: `wireSpawnedTeam`
 * turns it into `{ ok: false }`, and the saveSetting arms into an error result.
 */
export async function mutateTerminalGroups(
    opts: MutateTerminalGroupsOptions,
    transform: (current: any[]) => any[] | Promise<any[]>
): Promise<any[]> {
    const { db, settings } = opts;
    let result: any[] = [];
    const p = _groupsWriteChain.then(async () => {
        let current: any[] = [];
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            current = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
            current = Array.isArray(raw) ? [...raw] : [];
        }

        // Shipped bare-key migration: import bare 'terminals.groups' rows this
        // workspace has not imported before. Best effort — a legacy row that
        // cannot be read must not fail a save of the current array.
        let newlyImported: string[] = [];
        if (db) {
            try {
                const bareRaw = await db.getConfigJson('terminals.groups', []);
                if (Array.isArray(bareRaw) && bareRaw.length > 0) {
                    const ledgerRaw = await db.getConfigJson(TERMINALS_GROUPS_BARE_IMPORTED_KEY, []);
                    const imported = new Set<string>(
                        Array.isArray(ledgerRaw) ? ledgerRaw.filter((x: any) => typeof x === 'string') : []
                    );
                    const existingIds = new Set(current.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bareRaw) {
                        if (!g || typeof g.id !== 'string' || imported.has(g.id)) { continue; }
                        newlyImported.push(g.id);
                        // Prefixed wins on an id collision — the row is already
                        // here, so only the ledger entry is new.
                        if (!existingIds.has(g.id)) {
                            current.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort migration */ }
        }

        const migrated = migrateTeamGroupFlags(current);
        if (migrated !== null) {
            current = migrated;
        }

        // Migration: manual groups (`grp_`) are ephemeral in-memory session state,
        // never stored in the durable config DB alongside teams. Filter out any
        // legacy `grp_` rows on read.
        current = current.filter((g: any) => !g?.id || typeof g.id !== 'string' || !g.id.startsWith('grp_'));

        const next = await transform(current);
        const validated = (Array.isArray(next) ? next : [])
            .filter((g: any) => !g?.id || typeof g.id !== 'string' || !g.id.startsWith('grp_'));

        if (settings) {
            await settings.set(TERMINALS_GROUPS_KEY, validated);
        } else if (db) {
            await db.setConfigJson(TERMINALS_GROUPS_KEY, validated);
        }

        // Ledger AFTER the array write. Marking an id imported before the write
        // lands would strand it: the next pass skips it and the group is in
        // neither row.
        if (db && newlyImported.length > 0) {
            try {
                const ledgerRaw = await db.getConfigJson(TERMINALS_GROUPS_BARE_IMPORTED_KEY, []);
                const imported = Array.isArray(ledgerRaw) ? ledgerRaw.filter((x: any) => typeof x === 'string') : [];
                await db.setConfigJson(
                    TERMINALS_GROUPS_BARE_IMPORTED_KEY,
                    [...new Set([...imported, ...newlyImported])]
                );
            } catch { /* a lost ledger entry costs one extra idempotent import */ }
        }
        result = validated;
    });
    _groupsWriteChain = p.catch(() => {});
    await p;
    return result;
}

/**
 * The webview's whole-array save of `terminals.groups`, guarded.
 *
 * ONE implementation for both `saveSetting` arms (`KanbanService.saveSetting`
 * and `KanbanProvider`'s inline fallback). Two copies of this merge is the
 * partial fix the plan named: the next edit lands in one of them.
 *
 * `unseen = stored \ (baseIds ∪ clientIds)` — the ids the client never read and
 * is not sending are appended back. A missing or malformed `baseIds` means "saw
 * nothing", which degrades to a full union: the safe direction, and what an
 * older webview build (which sends no `baseIds`) needs.
 */
export async function saveTerminalGroupsGuarded(opts: {
    db?: MutateTerminalGroupsOptions['db'];
    settings?: TerminalGroupsSettingsAccessor;
    value: any[];
    baseIds?: unknown;
}): Promise<any[]> {
    const { db, settings, value } = opts;
    const baseIdSet = new Set<string>(
        Array.isArray(opts.baseIds) ? opts.baseIds.filter((id: any): id is string => typeof id === 'string') : []
    );
    const clientIds = new Set(value.map((g: any) => g && g.id).filter(Boolean));
    return mutateTerminalGroups({ db, settings }, (current) => {
        const unseen = current.filter((g: any) => g && g.id && !baseIdSet.has(g.id) && !clientIds.has(g.id));
        return [...value, ...unseen];
    });
}

/** Config key for agent group definitions (team templates). */
const AGENT_GROUPS_CONFIG_KEY = 'terminals.agentGroups';

/**
 * Membership-read provenance for a team's `enabled` flag. Copied VERBATIM from
 * the column union (`agentConfig.ts` `KanbanColumnDefinition.enabledSource`) —
 * a team only ever writes `'config'` or `'default'`, but two nearly-identical
 * source enums is the two-catalogues trap in miniature, so this takes the whole
 * union rather than a narrower copy.
 */
export type TeamEnabledSource = 'config' | 'legacy-db-config' | 'default' | 'structural' | 'unknown';

/** Work kinds an implementation team can declare it accepts. */
export type TeamWorkKind = 'feature' | 'plan';

/**
 * Read a team's in-use switch, tagged with WHO decided it. A team that exists
 * is not automatically a team that plays, and "off because it ships off" must
 * never read the same as "off because the operator switched it off" — that is
 * the repo's fallback rule applied to a membership read.
 *
 * An absent flag reads as enabled with source `'unknown'`: the seed and the
 * Teams tab both write the field explicitly, so absence means a row that
 * predates the field, and the source says so rather than pretending a default
 * was configured.
 */
export function readTeamEnabled(group: any): { value: boolean; source: TeamEnabledSource } {
    if (!group || typeof group !== 'object') { return { value: false, source: 'unknown' }; }
    const raw = group.enabled;
    const source: TeamEnabledSource =
        group.enabledSource === 'config' || group.enabledSource === 'default'
            || group.enabledSource === 'legacy-db-config' || group.enabledSource === 'structural'
            ? group.enabledSource
            : 'unknown';
    if (raw === true || raw === false) { return { value: raw, source }; }
    return { value: true, source: 'unknown' };
}

/** Convenience predicate — `readTeamEnabled(g).value`. */
export function isTeamEnabled(group: any): boolean {
    return readTeamEnabled(group).value;
}

/**
 * The refusal text for an explicit start of a switched-off team. Names the
 * switch, so the operator is never left guessing why a rail click did nothing.
 */
export function teamDisabledMessage(group: any): string {
    const name = (group && group.name) || (group && group.id) || 'This team';
    const { source } = readTeamEnabled(group);
    const because = source === 'default'
        ? 'it ships switched off'
        : source === 'config'
            ? 'it was switched off in the Teams tab'
            : 'its in-use switch is off';
    return `'${name}' is switched off (${because}). Switch it on in the Teams tab to start it.`;
}

/**
 * Read the work kinds a team accepts, tagged with the source. `'default'` means
 * the team declares nothing — the routing was by absence, not by declaration,
 * and the resolver says so rather than treating silence as a match.
 */
export function readTeamAcceptedKinds(group: any): { value: TeamWorkKind[] | null; source: 'config' | 'default' } {
    const raw = group && group.acceptedKinds;
    if (Array.isArray(raw)) {
        const kinds = raw.filter((k: any): k is TeamWorkKind => k === 'feature' || k === 'plan');
        if (kinds.length > 0) {
            const source = group.acceptedKindsSource === 'config' ? 'config' as const : 'default' as const;
            return { value: kinds, source };
        }
    }
    return { value: null, source: 'default' };
}

/**
 * How a team takes part in AUTOMATED board dispatch — drag-and-drop onto a
 * column, command-console dispatch, the queue pop, the bulk role fan-out.
 *
 * It does NOT govern the copy-prompt buttons: those put a prompt on the
 * clipboard for the operator to paste into a head by hand, and every team is
 * reachable that way regardless of this field. The distinction is the point —
 * a team can be hands-on-only without becoming unusable.
 *
 *  - `'pool'` — head and seats join the role pool. The ordinary team.
 *  - `'head-only-when-sole'` — the seats NEVER receive a dispatch, and the head
 *    receives one only when no `'pool'` team of the same head role is live. This
 *    is the peer-planner shape: three seats drafting ONE problem in parallel,
 *    which unrelated queue items break outright rather than merely crowd.
 *  - `'never'` — neither head nor seats are ever an automated target.
 */
export type TeamAutomatedDispatch = 'pool' | 'head-only-when-sole' | 'never';

/**
 * Read the dispatch policy, tagged with WHO decided it. This is a routing read,
 * so an absent field must not read like a configured one: absence is `'pool'`
 * with source `'unknown'`, and every shipped default states its policy outright.
 */
export function readTeamAutomatedDispatch(
    group: any
): { value: TeamAutomatedDispatch; source: 'config' | 'default' | 'unknown' } {
    const raw = group && group.automatedDispatch;
    const valid = raw === 'pool' || raw === 'head-only-when-sole' || raw === 'never';
    if (!valid) { return { value: 'pool', source: 'unknown' }; }
    const source = group.automatedDispatchSource === 'config'
        ? 'config' as const
        : group.automatedDispatchSource === 'default'
            ? 'default' as const
            : 'unknown' as const;
    return { value: raw, source };
}

/**
 * The live terminal names that must NOT receive an automated dispatch, each with
 * the rule that excluded it — so "why did this seat not get the card?" is
 * answerable after the fact rather than inferred from an empty pool.
 *
 * Head-versus-seat is decided from the live `terminals.groups` row, not from the
 * definition's roster: the row's `name` IS the head's terminal name (set by
 * `wireSpawnedTeam`) and its `members` are the live seat names, so a team that
 * spawned with fewer seats than its roster declares is still read correctly.
 *
 * `'head-only-when-sole'` releases its head only when no `'pool'` team shares its
 * head role AND is live — which is the "only Multi-agent planning is up" case,
 * where plans should reach its head one at a time rather than fail.
 */
export async function resolveAutomatedDispatchExclusions(opts: {
    db: any;
    /** Live terminal names — the caller's liveness view, never re-derived here. */
    liveNames: Set<string> | string[];
}): Promise<{ excluded: Set<string>; reasons: Map<string, string> }> {
    const excluded = new Set<string>();
    const reasons = new Map<string, string>();
    const { db } = opts;
    const live = opts.liveNames instanceof Set ? opts.liveNames : new Set(opts.liveNames || []);
    if (!db) { return { excluded, reasons }; }

    let groups: any[] = [];
    try {
        const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
        groups = Array.isArray(raw) ? [...raw] : [];
    } catch { return { excluded, reasons }; }
    try {
        const bare = await db.getConfigJson('terminals.groups', []) as any[];
        if (Array.isArray(bare) && bare.length > 0) {
            const seen = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
            for (const g of bare) {
                if (g && typeof g.id === 'string' && !seen.has(g.id)) { groups.push(g); seen.add(g.id); }
            }
        }
    } catch { /* best effort */ }
    if (groups.length === 0) { return { excluded, reasons }; }

    // Resolve every live team group to its definition once.
    const resolved: Array<{ group: any; def: any; policy: TeamAutomatedDispatch; head?: string }> = [];
    for (const g of groups) {
        if (!g || !isSpawnedTeamGroup(g)) { continue; }
        // `wireSpawnedTeam` writes `head` and `name` to the SAME value, but only
        // `head` is the declared field. Fall back to `name` for any row written
        // before it existed: without this a legacy row resolves no head, the team
        // is skipped, and the exclusion silently does nothing — which looks
        // exactly like "this team was allowed to dispatch".
        const head = teamHeadName(g) || (typeof g.name === 'string' && g.name ? g.name : undefined);
        if (!head || !live.has(head)) { continue; }
        let def: any = null;
        try { def = await resolveDefinitionForGroup(db, g); } catch { def = null; }
        resolved.push({ group: g, def, policy: readTeamAutomatedDispatch(def).value, head });
    }

    // Which head roles have a live `'pool'` team? That is what releases a
    // `'head-only-when-sole'` head — or holds it back.
    const pooledHeadRoles = new Set<string>();
    for (const r of resolved) {
        if (r.policy !== 'pool') { continue; }
        const role = r.def && typeof r.def.headRole === 'string' ? r.def.headRole.toLowerCase() : '';
        if (role) { pooledHeadRoles.add(role); }
    }

    for (const r of resolved) {
        if (r.policy === 'pool') { continue; }
        const def = r.def || {};
        const teamLabel = def.name || def.id || r.group.id;
        const members: string[] = Array.isArray(r.group.members) ? r.group.members : [];
        // Seats: excluded under BOTH non-pool policies, unconditionally.
        for (const m of members) {
            if (!m || m === r.head) { continue; }
            excluded.add(m);
            reasons.set(m, `seat of '${teamLabel}' (automatedDispatch=${r.policy}) — its seats never receive automated dispatch`);
        }
        if (r.policy === 'never') {
            if (r.head) {
                excluded.add(r.head);
                reasons.set(r.head, `head of '${teamLabel}' (automatedDispatch=never)`);
            }
            continue;
        }
        // 'head-only-when-sole': the head is a target only when nothing pooled
        // shares its head role.
        const role = typeof def.headRole === 'string' ? def.headRole.toLowerCase() : '';
        if (role && pooledHeadRoles.has(role) && r.head) {
            excluded.add(r.head);
            reasons.set(r.head, `head of '${teamLabel}' (automatedDispatch=head-only-when-sole) — a pooled '${role}'-headed team is live and takes the dispatch`);
        }
    }
    return { excluded, reasons };
}

/**
 * Durable commit instruction appended to every team-head standing order.
 * This is NOT the per-dispatch GIT POLICY block (branch/push/safety clauses
 * are composed per-dispatch by buildGitPolicyBlock). This is the durable
 * instruction that survives in the head's standing orders so the lead sees
 * it on every message that carries standing orders — including turn-end
 * notifications, which do not carry the per-dispatch GIT POLICY block.
 */
export const TEAM_HEAD_COMMIT_INSTRUCTION = ` ${TEAM_HEAD_COMMIT_FRAGMENT_BODY}`;

/**
 * The POST-rewrite Coding team `headPrompt` — subtask-level, single-action.
 * The lead never writes a review prompt and never hands work to a reviewer;
 * it finishes each subtask, commits, posts completion for that subtask, and
 * asks for the next card via /kanban/queue/next. `{head}` is substituted by
 * `wireSpawnedTeam` (`:719`) and by the order converter with the live head name.
 *
 * Card-movement rules:
 *  - Never move a card backwards — only Mission Control may do that.
 *  - Never move a card to a new column yourself: card movement is handled
 *    by the kanban board, not by team leads.
 *  - Why exceptions must be named explicitly: if an API payload carries
 *    `targetColumn`, an absolute prohibition reads as "do not make that
 *    call" and leads stop making legitimate calls. When no exception exists,
 *    card movement is unconditional.
 *  - "advance" language removed entirely to prevent misinterpretation, and
 *    card movement is never described as the lead's role.
 *
 * This IS the Feature team default's `headPrompt` — it is referenced by
 * `DEFAULT_TEAM_DEFINITIONS` below, not hand-copied into a second catalogue. The
 * webview gallery that carried the second copy (`SHIPPED_TEAM_TYPES` in
 * `agent-control.js`) is deleted: there is one catalogue now.
 * The client mirror (`NEW_CODING_HEAD_PROMPT_CLIENT`) was retired when system
 * protocol composition moved to delivery-time fragment composition.
 */
export const NEW_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. '
    + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
    + 'Read the plan, dispatch based on it, review against it — never modify its content. '
    + 'Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Your team\'s seats are the '
    + 'ptyListTerminals rows whose parentInstanceId matches your SWITCHBOARD_AGENT_INSTANCE_ID — role alone '
    + 'is not a membership test, and a standalone seat of the same role is not yours to drive. Take the '
    + 'subtask\'s recommendedRole as the routing decision; do not invent complexity tiers. Before sending any '
    + 'seat a revert or stand-down, confirm with git diff that the state you are undoing exists. When a seat fails '
    + 'review on the same subtask twice, do not send that subtask to that seat in that same context again. '
    + 'Work down this ladder and take the first rung that applies, naming the specific defects in every dispatch: '
    + '(1) clear that seat\'s context — `node "<cliPath>" verb ptyClearTerminal \'{"name":"<the seat>"}\'` — then '
    + 're-dispatch the subtask to it with a prompt naming exactly what to fix; a cleared seat is a fresh attempt, '
    + 'not a third one, and you may do this once per seat per subtask; (2) hand the subtask to an idle seat on your '
    + 'team that has not worked on it, clearing it first if it holds unrelated context; (3) escalate one rung along '
    + 'intern → coder → lead; (4) if the outstanding fix is small and localized, make it yourself; (5) only when every '
    + 'rung above is exhausted, stop and report to the human instead of dispatching again (or unattended: the host '
    + 'records the blocked card as a plan_events row — proceed to the next queue item). Say in your status report '
    + 'which rung you took and why. Never report a subtask blocked for want of a higher seat without having tried '
    + 'rungs 1, 2 and 4. When a coder reports a subtask finished, note it and '
    + 'dispatch the next subtask to an idle seat that has not already worked on it — do not stack '
    + 'subtasks on the same coder, or it will hit its context limit mid-task. One subtask per '
    + 'cleared seat before rotation. When a coder finishes its turn, the system delivers a '
    + 'completion prompt into this terminal — you do not need to check, wait, or watch for it. '
    + 'Do not sleep, poll, loop, or run any timer to find out whether a coder is done. '
    + 'Dispatch what is dispatchable, close out what is closable, and end your turn. '
    + 'An idle lead is the correct resting state, not a failure. '
    + 'Do not send anything to the reviewer, and do not write review '
    + 'instructions — that is not your job. '
    + 'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself — that is not your role. '
    + 'When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message. '
    + 'run node "<cliPath>" accept --plan "<the subtask\'s planId>" '
    + 'against the API base named in your SWITCHBOARD STATUS line. '
    + 'The card stays where it is. Completion is asserted, never inferred from board position. '
    + 'run node "<cliPath>" next (or switchboard next); '
    + 'if it returns a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop.';

export const NEW_REVIEW_TEAM_HEAD_PROMPT =
    'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself. '
    + 'You lead this review team. When a feature lands in your terminal, assign its subtask plans to your '
    + 'reviewer seats in batches of up to two per reviewer. The review turn is read-only: reviewers append '
    + 'their findings to the plan files and report back. When all reviewers report, triage findings into four '
    + 'categories: (1) needs no fixing, (2) fixes needed, (3) follow-ups needed for deferred issues or remaining '
    + 'risks, (4) did not meet intent. Apportion categories 2 and 3 back to the reviewer that reviewed them '
    + '(file-disjoint where possible) via node "<cliPath>" verb ptySendPrompt \'{"name":"<reviewer seat>","data":"<fix instructions — name each file, the issue, and the fix needed. Tell the reviewer to run verification checks (typecheck/tests as applicable) and include results in their report.>","clearBeforePrompt":false,"seatBlock":false}\'. '
    + 'Do not fix categories 1 or 4. Write one markdown artifact to the plans '
    + 'folder (.switchboard/plans/) covering deferred items, remaining risks, and intent failures. '
    + 'When review and fixes are complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message. '
    + 'When the review passes, run node "<cliPath>" next (or switchboard next); if it returns a dispatched card, work it; if it returns '
    + 'dispatched: null, report that the queue is empty and stop.';

/**
 * The Multi-agent planning head prompt — fan-out, then synthesise. Roster-agnostic
 * by construction: the head enumerates its own seats from `ptyListTerminals` by
 * the `<head>-` name prefix `spawnDelegates` guarantees, so an operator who edits
 * the roster does not invalidate the prompt. `{head}` is substituted with the
 * live head name by `wireSpawnedTeam`.
 *
 * Every agent-facing call is the CLI verb, never raw HTTP — see the directives
 * rule the rest of the shipped prompts follow.
 */
export const MULTI_AGENT_PLANNING_HEAD_PROMPT =
    'You lead this team and you do not write the plan alone. When you are given something to '
    + 'plan — a memo, a ticket, a bug report, a request — split it into one investigation angle '
    + 'per member and hand each member its own angle BEFORE you write anything. '
    + 'Find your members first: run node "<cliPath>" verb ptyListTerminals \'{}\' (or switchboard verb ptyListTerminals) '
    + 'and take the active terminals whose friendlyName starts with "{head}-". Dispatch to each by name with '
    + 'node "<cliPath>" verb ptySendPrompt \'{"name":"<member>","data":"<that member\'s angle>","clearBeforePrompt":false}\'. '
    + 'Each member is a separate agent that cannot see this '
    + 'conversation, so every dispatch must state the problem, that member\'s angle, and what '
    + 'to report back, standing on its own. Give different members different angles — never '
    + 'the same question twice. Then wait for their reports and synthesise them into ONE plan, '
    + 'naming which findings came from which member. If a member never reports, say so in the '
    + 'plan rather than dropping its angle quietly. If you have no members, say so and plan alone.';

/**
 * The Coding team head prompt — a coder head that takes the Complex / Risky half
 * of ONE plan while its intern takes the Routine half, integrates both, commits,
 * asserts completion and pops the queue. Deliberately light: no reviewer seat, no
 * review hop, no lead dispensing work. A plan that needs reviewing goes to the
 * Review team as its own dispatch.
 */
export const CODING_TEAM_HEAD_PROMPT =
    'You head this team and you write code yourself. This team is two seats and one plan: you take the '
    + 'Complex / Risky (Band B) half and your intern seat takes the Routine (Band A) half, in parallel. '
    + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
    + 'THE BOARD DISPATCHES YOUR INTERN\'S HALF, NOT YOU. When this card was sent to you, the system sent the Routine '
    + '(Band A) half to your intern seat at the same time — you do not write it a prompt, and you must not use ptySendPrompt '
    + 'to hand it work. The intern has JUST started and will NOT be finished yet, so do not check its work at the start. '
    + 'Begin your Complex implementation immediately and only check and integrate the intern\'s Routine work as a final step '
    + 'before declaring completion. Your team\'s seats are the ptyListTerminals rows whose parentInstanceId matches your '
    + 'SWITCHBOARD_AGENT_INSTANCE_ID. '
    + 'This team has no reviewer seat and no review hop; your integration check is the review. '
    + 'Before sending the intern a revert or stand-down, confirm with git diff that the state you are undoing exists. '
    + 'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself — that is not your role. '
    + 'When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message. '
    + 'run node "<cliPath>" accept --plan "<the plan\'s planId>" '
    + 'against the API base named in your SWITCHBOARD STATUS line. '
    + 'The card stays where it is. Completion is asserted, never inferred from board position. '
    + 'run node "<cliPath>" next (or switchboard next); '
    + 'if it returns a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop.';

/**
 * The five default team definitions. Present on every board, none deletable, each
 * carrying an in-use switch — four ship on, Multi-agent planning ships off.
 *
 * Ids are FIXED and stable. `feature-implementation` keeps its id and is named
 * *Feature team*; the name *Coding* belongs to `coding-team`, the two-seat team a
 * single plan goes to. Rail order is array order.
 *
 * `enabled` / `enabledSource` are stamped at seed time so a membership read can
 * always answer "which source decided this team is in play?" — never absent, never
 * a bare default that reads like a configured value.
 *
 * `pairProgramming` is written EXPLICITLY on every row whose identity depends on
 * it, rather than left absent for `readTeamPairProgramming` to default to `'on'`:
 * "on because it ships on" and "on because nobody set it" must not be the same read.
 *
 * NO default carries a `scope: 'shared'` member. `commandlessRoles`
 * (`agentGroupInstantiation.ts`) skips shared members outright, so a shared seat's
 * role is reported by nothing — an unconfigured researcher would spawn as a bare
 * shell with no surface naming it. Shared scope also spawns unparented and escapes
 * the delegate cap. Every role on every shipped default is a counted candidate.
 */
export const DEFAULT_TEAM_DEFINITIONS: any[] = [
    {
        id: 'planning-team',
        name: 'Planning',
        headRole: 'planner',
        // A team picks ONE machine — head and every delegate spawn on it. See
        // the plan `agents-are-saved-per-machine-and-a-team-picks-one`.
        machine: 'local',
        members: [
            { role: 'planner', count: 2, label: '' },
            // An ordinary per-team seat, deliberately NOT a shared one — see
            // the note above this array.
            { role: 'researcher', count: 1, label: '', scope: 'per-team', relationship: 'reports-to-head' },
        ],
        purpose: 'Turns tickets and ideas into plans, with a researcher seat so the planner never hands research back to you.',
        prompt: '{child} is your head agent. When you finish a task, report to it — node "<cliPath>" verb ptySendPrompt '
            + '\'{"name":"{child}","data":"<your report>","clearBeforePrompt":false}\' (or switchboard verb ptySendPrompt) '
            + '— naming what you changed and what to review. Do not wait to be asked.\n'
            + 'Research the context for the plan — read the codebase, trace dependencies, and identify root causes. '
            + 'Report your findings to {child} for synthesis into the plan.\n'
            + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
            + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
            + 'commit first, then correct forward. '
            + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
            + 'other agents may be working the same tree.',
        enabled: true,
        enabledSource: 'default',
        // Pooled: head and seats are ordinary automated-dispatch targets.
        automatedDispatch: 'pool',
        automatedDispatchSource: 'default',
    },
    {
        id: 'feature-implementation',
        name: 'Feature team',
        headRole: 'lead',
        machine: 'local',
        // Two coders and an INTERN, not three coders. The three-coder roster came
        // from the older member-less preset constant and was carried forward
        // unexamined; the implementation team the operator actually ran was
        // lead + 2 × coder + 1 × intern. A feature's subtasks are not uniformly
        // complex, and the cheap seat is the one that makes the roster worth its
        // RAM on a box where board-plus-agents wants 2 GB.
        members: [
            { role: 'coder', count: 2, label: '' },
            { role: 'intern', count: 1, label: '', scope: 'per-team', relationship: 'reports-to-head' },
        ],
        purpose: 'Takes a whole feature and dispatches its subtasks across coder and intern seats.',
        acceptedKinds: ['feature'],
        acceptedKindsSource: 'default',
        pairProgramming: 'on',
        prompt: '{child} is your head agent. When you finish a task, report to it — node "<cliPath>" verb ptySendPrompt '
            + '\'{"name":"{child}","data":"<your report>","clearBeforePrompt":false}\' (or switchboard verb ptySendPrompt) '
            + '— naming what you changed and what to review. Do not wait to be asked.\n'
            + 'Work the subtask you were handed to completion and report it to {child}. Work only that subtask — '
            + 'another seat on this team holds the next one.\n'
            + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
            + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
            + 'commit first, then correct forward. '
            + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
            + 'other agents may be working the same tree.',
        headPrompt: NEW_CODING_HEAD_PROMPT,
        enabled: true,
        enabledSource: 'default',
        // Pooled: head and seats are ordinary automated-dispatch targets.
        automatedDispatch: 'pool',
        automatedDispatchSource: 'default',
    },
    {
        id: 'coding-team',
        name: 'Coding',
        headRole: 'coder',
        machine: 'local',
        members: [
            { role: 'intern', count: 1, label: '', scope: 'per-team', relationship: 'reports-to-head' },
        ],
        purpose: 'Takes a single plan and splits it by complexity: the coder takes Band B, the intern takes Band A.',
        acceptedKinds: ['plan'],
        acceptedKindsSource: 'default',
        // Written explicitly and NOT switchable off in the Teams tab: a coder and
        // an intern with no split are two seats doing undifferentiated work, which
        // is not this team. The control for "I do not want this" is the team switch.
        pairProgramming: 'on',
        prompt: '{child} is your head agent. When you finish a task, report to it — node "<cliPath>" verb ptySendPrompt '
            + '\'{"name":"{child}","data":"<your report>","clearBeforePrompt":false}\' (or switchboard verb ptySendPrompt) '
            + '— naming what you changed and what to review. Do not wait to be asked.\n'
            + 'You are the Routine (Band A) half of a two-seat team. Work the routine, low-risk steps of the plan '
            + '{child} hands you — it takes the Complex / Risky half itself and integrates your work before anything ships. '
            + 'Do not take on the complex half, and do not wait on {child} to finish before reporting yours.\n'
            + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
            + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
            + 'commit first, then correct forward. '
            + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
            + 'other agents may be working the same tree.',
        headPrompt: CODING_TEAM_HEAD_PROMPT,
        enabled: true,
        enabledSource: 'default',
        // Pooled: head and seats are ordinary automated-dispatch targets.
        automatedDispatch: 'pool',
        automatedDispatchSource: 'default',
    },
    {
        id: 'review-team',
        name: 'Review',
        headRole: 'reviewer',
        machine: 'local',
        members: [
            { role: 'reviewer', count: 2, label: '' },
        ],
        purpose: 'Reviews a feature across reviewer seats in read-only batches, triages findings, and fixes only what it reviewed.',
        prompt: '{child} is your head agent. When you finish a task, report to it — node "<cliPath>" verb ptySendPrompt '
            + '\'{"name":"{child}","data":"<your report>","clearBeforePrompt":false}\' (or switchboard verb ptySendPrompt) '
            + '— naming what you changed and what to review. Do not wait to be asked.\n'
            + 'In the review turn, perform a read-only review of your assigned plans, append your findings under ## Review Findings to the plan files, and report back to {child}. Do not modify code during the review turn.\n'
            + 'When {child} apportions fixes back to you in the fix turn, implement the fixes for the plans you reviewed, run verification checks, and report back.\n'
            + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
            + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
            + 'commit first, then correct forward. '
            + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
            + 'other agents may be working the same tree.',
        headPrompt: NEW_REVIEW_TEAM_HEAD_PROMPT,
        enabled: true,
        enabledSource: 'default',
        // Pooled: head and seats are ordinary automated-dispatch targets.
        automatedDispatch: 'pool',
        automatedDispatchSource: 'default',
    },
    {
        id: 'multi-agent-planning',
        name: 'Multi-agent planning',
        headRole: 'planner',
        machine: 'local',
        // Its OWN jet, not the planner one. This team and `planning-team` are both
        // `planner`-headed and are meant to run AT THE SAME TIME — one for bulk
        // planning, this one for harder work the operator oversees by hand. Art
        // keyed on head role alone drew them identically, so the rail and the
        // TEAMS tab said "same team" about two teams that are not. `jet` is the
        // team's identity; `icon` (operator-picked) still overrides it.
        jet: 'multi-agent-planning',
        // Peer planners, not a research pool. Three planner seats draft the SAME
        // problem independently and the head reconciles the drafts. A planner
        // member cannot recursively spawn a planner team — the auto-start guard is
        // `!parentInstanceId && !_isTeamMember` and members are parented by
        // construction.
        members: [
            { role: 'planner', count: 3, label: '', scope: 'per-team', relationship: 'reports-to-head' },
            { role: 'researcher', count: 1, label: '', scope: 'per-team', relationship: 'reports-to-head' },
        ],
        purpose: 'Three planners draft the same problem independently; the head reconciles the drafts into one plan.',
        prompt: '{child} is your head agent. When you finish a task, report to it — node "<cliPath>" verb ptySendPrompt '
            + '\'{"name":"{child}","data":"<your report>","clearBeforePrompt":false}\' (or switchboard verb ptySendPrompt) '
            + '— naming what you changed and what to review. Do not wait to be asked.\n'
            + 'You are one of several planners working the same problem from different angles. Draft your own '
            + 'plan for the angle you were given — read the code, trace the dependencies, name the root cause '
            + 'and the risks — and report it to {child}, which reconciles every draft into one plan. Do not '
            + 'coordinate with the other planners and do not write the final plan yourself.\n'
            + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
            + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
            + 'commit first, then correct forward. '
            + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
            + 'other agents may be working the same tree.',
        headPrompt: MULTI_AGENT_PLANNING_HEAD_PROMPT,
        // Present and OFF. Not hidden, not deleted — greyed in the Teams tab with
        // its switch, or there is no way back on.
        enabled: false,
        enabledSource: 'default',
        // Its SEATS never receive an automated dispatch, and its head only when
        // no pooled `planner`-headed team is live. Three peer planners draft ONE
        // problem in parallel; handing them unrelated queue items does not merely
        // crowd the team, it breaks the topology. The operator drives this team by
        // hand — the kanban copy-prompt buttons put the planning prompt on the
        // clipboard and it is pasted into the head, which this field never gates.
        automatedDispatch: 'head-only-when-sole',
        automatedDispatchSource: 'default',
    },
];

/** Every shipped default's id. Derived, never typed — a default added above
 *  joins this set by construction. Used by the delete refusal (a default is
 *  undeletable) and by the setup surface's recommended-role derivation. */
export const DEFAULT_TEAM_IDS: ReadonlySet<string> = new Set(
    DEFAULT_TEAM_DEFINITIONS.map(d => d && d.id).filter((id: any): id is string => typeof id === 'string')
);

/** True when `id` names one of the five shipped defaults. */
export function isDefaultTeamId(id: any): boolean {
    return typeof id === 'string' && DEFAULT_TEAM_IDS.has(id);
}

/**
 * The recommended agent set for first run: the union of `headRole` and member
 * roles across the defaults that ship ENABLED. DERIVED, never typed — a
 * hard-coded list drifts the moment a default's roster changes and the failure
 * is silent, a team whose new role nobody was told to configure. `intern`
 * entering the set is the proof: it arrives because a roster changed.
 *
 * Deriving from the ENABLED set is what keeps first run at six commands.
 * Enabling a disabled team still has to surface any role it needs that is not
 * configured — that is the `commandlessRoles` report, fired at enable time.
 */
export function recommendedAgentRoles(definitions: any[] = DEFAULT_TEAM_DEFINITIONS): string[] {
    const roles = new Set<string>();
    for (const def of definitions) {
        if (!def || typeof def !== 'object') { continue; }
        if (!readTeamEnabled(def).value) { continue; }
        if (typeof def.headRole === 'string' && def.headRole) { roles.add(def.headRole); }
        for (const m of Array.isArray(def.members) ? def.members : []) {
            if (m && typeof m.role === 'string' && m.role) { roles.add(m.role); }
        }
    }
    return [...roles].sort();
}

/**
 * The shipped starter, resolved BY ID. It was `DEFAULT_TEAM_DEFINITIONS[1]` — a
 * positional alias that breaks silently when the array grows, and the array grew
 * to five.
 */
export const SEEDED_AGENT_GROUP: any =
    DEFAULT_TEAM_DEFINITIONS.find(d => d && d.id === 'feature-implementation');


/**
 * Convert existing agent groups to the team shape. Runs on every read
 * path that can trigger auto-start, so it is impossible for the
 * auto-start trigger to observe un-migrated data.
 *
 * One step, one pass: add `scope: 'per-team'` and
 * `relationship: 'reports-to-head'` defaults to every member that lacks them —
 * the final member shape. Preserves `label` and any unknown keys on each
 * member. Per-member `startupCommand` is retired (plan:
 * `agents-are-saved-per-machine-and-a-team-picks-one`) and stripped on read.
 *
 * There is NO head-role collision step. It marked the loser of a shared
 * `headRole` `unassigned: true`, which only ever meant "not the auto-start
 * default" — and auto-start is retired, so the flag gated nothing while reading,
 * in the UI, exactly like a disabled state. Two flags that both look like "off"
 * is the two-copies-disagreeing trap, and the shipped set has two
 * `planner`-headed teams by design. Two teams sharing a head role is an ordinary
 * configuration that nothing objects to; the in-use switch (`enabled`) is the
 * only thing that takes a team out of play.
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
    const next: any[] = [];

    // ── Step 1: convert member shape ─────────────────────────────────
    for (const group of groups) {
        if (!group || typeof group !== 'object') {
            // Defensive: skip non-object entries rather than dropping them.
            next.push(group);
            continue;
        }

        let g = { ...group };

        // Machine threading (plan: agents-are-saved-per-machine-and-a-team-picks-one):
        // a team with no `machine` field defaults to `'local'`. Stamp it on
        // read so the spawn path and the UI see a concrete value, and persist
        // the cleaned shape. A non-string or empty machine is repaired to
        // `'local'` — never silently to another machine.
        if (typeof g.machine !== 'string' || !g.machine) {
            g.machine = 'local';
            changed = true;
        }

        // Retire the `startOnLoad` field (clear-on-read). Auto-start is gone —
        // a stored `startOnLoad: true` that does nothing is the
        // fallback-indistinguishable-from-a-value anti-pattern, so strip it on
        // read and persist the cleaned shape. All other keys (icon, pacing,
        // headPrompt, members, startWorktree) are preserved — only `startOnLoad`
        // is cleared.
        if (g.startOnLoad !== undefined) {
            delete g.startOnLoad;
            changed = true;
        }

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
            // Per-member startupCommand is retired (plan:
            // agents-are-saved-per-machine-and-a-team-picks-one). Strip it on
            // read and persist the cleaned shape — a team resolves every member
            // from its one machine's command map. Preserve label and any
            // unknown keys.
            if (converted.startupCommand !== undefined) {
                delete converted.startupCommand;
                changed = true;
            }
            // Split-team guard: a member must NEVER carry its own machine. The
            // team's machine is the only machine; a per-member machine would
            // silently split the team across two hosts. Strip and persist.
            if (converted.machine !== undefined) {
                delete converted.machine;
                changed = true;
            }
            return converted;
        });
        // Always reseat the array: this is also what converts a group with a
        // missing or non-array `members` into a member-less team (the `changed`
        // flag for that case is set above, before the array is normalised).
        g = { ...g, members: convertedMembers };

        next.push(g);
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
        // reports-to-head). Per-member startupCommand is retired (plan:
        // agents-are-saved-per-machine-and-a-team-picks-one) — drop it on
        // import; the imported team defaults to `machine: 'local'`. Also drop
        // any per-member `machine` (split-team guard).
        const members = delegates
            .filter(d => d && typeof d === 'object')
            .map((d: any) => {
                const { startupCommand: _dropCmd, machine: _dropMachine, ...rest } = d;
                return {
                    ...rest,
                    scope: d.scope ?? 'per-team',
                    relationship: d.relationship ?? 'reports-to-head',
                };
            });

        if (members.length === 0) { continue; }

        const team = {
            id: 'imported-delegates-' + role + '-' + Date.now().toString(36),
            name: role.charAt(0).toUpperCase() + role.slice(1) + ' team',
            headRole: role,
            machine: 'local',
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
 * Look up a team definition whose `headRole` matches the given role.
 *
 * Returns the first ENABLED match or null. Two teams may share a head role —
 * the shipped set has two `planner`-headed teams — so this is a first-by-stored-
 * order match, not a uniqueness constraint. A switched-off team is never the
 * answer: the switch has to change what the board does, or it is decorative.
 * The converter runs in-memory on the raw DB read before matching, so it is
 * impossible for the caller to observe un-migrated data — even on an install
 * that has never opened the TEAMS tab in the current session.
 *
 * NOT an auto-start trigger any more. This once fired when an unparented
 * terminal was created whose role headed a team, spawning the team around it.
 * That trigger is gone — a team is started explicitly, from its rail icon or by
 * the controller — and the docblock that still described it sent readers looking
 * for a spawn path that does not exist.
 *
 * The only remaining caller is the autoban DISPATCH TARGET lookup in
 * `_selectAutobanTerminal`, which asks "does a team head this role?" in order to
 * pick an existing terminal, never to create one. The lookup is a read-only DB
 * query. The in-memory conversion is not persisted here — `_loadAgentGroups`
 * does the persist when the TEAMS tab is opened.
 */
export async function findTeamForHeadRole(db: any, headRole: string): Promise<any | null> {
    if (!db || !headRole) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        // Run the converter in-memory before matching so the caller never
        // observes un-migrated data — even on an install that has never opened
        // the TEAMS tab in the current session. The converter adds member-shape
        // defaults (scope/relationship); it is idempotent and returns null when
        // nothing changed, so the steady-state cost is one comparison per lookup
        // and no write.
        const converted = migrateAgentGroups(groups) ?? groups;
        // A switched-off team is not a candidate — it exists, it does not play.
        return converted.find(g => g && g.headRole === headRole && isTeamEnabled(g)) || null;
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
 * almost-miss. An operator can build a custom team with a head and no
 * seats (deliberately opting out of the pool), so a `{ team, root }` with
 * zero members is a legitimate answer and must be reported distinctly
 * from `null`. Collapsing the two is the bug that made the original
 * failure invisible. The shipped presets are NOT member-less — they
 * carry their pools — so a zero-member result on a preset is unexpected
 * and worth investigating, but the predicate must still distinguish it
 * from `null`.
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
 * Resolve a team definition by id REGARDLESS of its in-use switch. Runs the
 * migration converter in-memory before matching (same guarantee as
 * `findTeamForHeadRole`: the caller never observes un-migrated data).
 *
 * This is the raw lookup. Use it only where a disabled team is still the right
 * answer — resolving the definition behind a live group, or reading the switch
 * itself in order to explain a refusal. Everything that puts a team INTO PLAY
 * goes through {@link resolveTeamById}, which refuses a disabled one.
 *
 * There is no on-demand re-seed here any more. It existed because a default
 * could be deleted; defaults are undeletable now (`_deleteAgentGroup` refuses a
 * default id), so a default can no longer be missing and a second resurrection
 * site is just a second writer on a read path.
 */
export async function resolveTeamByIdIncludingDisabled(db: any, teamId: string): Promise<any | null> {
    if (!db || !teamId) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        const converted = migrateAgentGroups(groups) ?? groups;
        return converted.find(g => g && g.id === teamId) || null;
    } catch (err) {
        console.warn(`[teamWiring] resolveTeamByIdIncludingDisabled('${teamId}') failed:`, err);
        return null;
    }
}

/**
 * Resolve a single team definition by id for a path that will PUT IT IN PLAY —
 * the explicit-start verb and the rail click behind it.
 *
 * A switched-off team is refused (returns `null`) and the refusal is logged
 * naming the switch. Enable-and-start would make the switch unfalsifiable: the
 * operator switches a team off, clicks its slot, and it starts anyway. Callers
 * that want to tell the operator WHY re-read the definition with
 * {@link resolveTeamByIdIncludingDisabled} and render {@link teamDisabledMessage}.
 */
export async function resolveTeamById(db: any, teamId: string): Promise<any | null> {
    const found = await resolveTeamByIdIncludingDisabled(db, teamId);
    if (!found) { return null; }
    if (!isTeamEnabled(found)) {
        const { source } = readTeamEnabled(found);
        console.log(
            `[teamWiring] resolveTeamById('${teamId}'): refused — team is switched off `
            + `(enabledSource=${source}).`
        );
        return null;
    }
    return found;
}

/**
 * Whether a `terminals.groups` row is a spawned team (as opposed to a
 * hand-saved selection). A spawned team carries `teamKind: 'spawned'`; a
 * legacy row written by an older build lacks the field but is still a team
 * when `teamGroup === true` AND its id is `team_`-prefixed (the flag
 * `migrateTeamGroupFlags` stamps on every `team_`-prefixed row). A
 * hand-saved selection has neither `teamKind` nor a `team_` id.
 *
 * Every consumer that branches on "is this a real team?" MUST call this
 * rather than testing `teamGroup` alone — this helper is the single seam
 * the rest of the feature builds on.
 */
export function isSpawnedTeamGroup(g: any): boolean {
    if (!g || typeof g !== 'object') { return false; }
    if (g.teamKind === 'spawned') { return true; }
    // Legacy compat: a team_-prefixed row written before teamKind existed.
    return g.teamGroup === true
        && typeof g.id === 'string'
        && g.id.startsWith('team_');
}

/**
 * The declared head terminal name for a spawned team group. Reads the
 * `head` field (stamped at spawn by `wireSpawnedTeam`), NEVER infers from
 * `order[0]` — the two diverge when an operator reorders, and a consumer
 * that infers will disagree with one that reads `head`. Returns
 * `undefined` for a group that has no declared head (a hand-saved
 * selection or a legacy row written before this change). Callers must
 * handle `undefined` by falling back to `order[0]` or `name` as
 * appropriate — but that fallback is the caller's choice, not this
 * helper's.
 */
export function teamHeadName(g: any): string | undefined {
    if (!g || typeof g !== 'object') { return undefined; }
    return typeof g.head === 'string' && g.head.length > 0 ? g.head : undefined;
}

/**
 * Resolve the team **definition** (`terminals.agentGroups` row) that
 * produced a live `terminals.groups` row. Resolution order:
 *
 * 1. `g.definitionId` → `resolveTeamById` (the exact path, for groups
 *    written by this build onward). Falls through to step 2 if the
 *    definition was deleted while the team runs.
 * 2. Fallback for pre-existing groups with no `definitionId`: match the
 *    group's `headRole` against `headRole` across
 *    `terminals.agentGroups`, accepting ONLY a unique match. Uses the
 *    same migration converter as `findTeamForHeadRole`, but demands
 *    uniqueness — an ambiguous role match returns `null` rather than
 *    guessing. Not filtered by the in-use switch: this resolves the
 *    definition behind a group that is ALREADY LIVE, and a team switched
 *    off while it runs still has a definition.
 * 3. Otherwise `null`. Every consumer must render a sane default when
 *    this returns `null`.
 *
 * No backfill migration, no rewrite of existing rows. The fallback covers
 * already-running teams for the life of their session; the next spawn
 * writes the precise link.
 *
 * Temporal edge case: a definition whose `headRole` was edited after
 * spawn no longer matches the live terminal's role. Acceptable —
 * resolves on next spawn.
 */
export async function resolveDefinitionForGroup(db: any, g: any): Promise<any | null> {
    if (!db || !g || typeof g !== 'object') { return null; }
    // 1. Exact path: the definition id stamped at spawn.
    if (typeof g.definitionId === 'string' && g.definitionId.length > 0) {
        const def = await resolveTeamByIdIncludingDisabled(db, g.definitionId);
        if (def) { return def; }
        // Fall through to role-match if the definition was deleted.
    }
    // 2. Role-match fallback for legacy groups (no definitionId, or a
    //    deleted definition). Same migration as findTeamForHeadRole, but
    //    demands a UNIQUE match — two definitions sharing a head role is
    //    ambiguous, and the shipped set has two `planner`-headed teams.
    const headRole = typeof g.headRole === 'string' && g.headRole.length > 0
        ? g.headRole : undefined;
    if (!headRole) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        const converted = migrateAgentGroups(groups) ?? groups;
        const matches = converted.filter((def: any) =>
            def && def.headRole === headRole);
        return matches.length === 1 ? matches[0] : null;
    } catch (err) {
        console.warn(`[teamWiring] resolveDefinitionForGroup role-match failed:`, err);
        return null;
    }
}

/**
 * True when a group is the shipped starter (`SEEDED_AGENT_GROUP`) — id, name,
 * headRole, the seeded member array (3 × coder), and no extra keys.
 * Exact-value, never heuristic: an operator-authored team differs by at least
 * one field (a renamed group, a different count, an added/edited member, an
 * extra key) and must NOT match. A group that matches every field has
 * demonstrably never been edited by the operator.
 *
 * ONE tolerance, and it is not a heuristic: the two member-shape defaults
 * `migrateAgentGroups` step 1 stamps — `scope: 'per-team'` and
 * `relationship: 'reports-to-head'` — are accepted AT THEIR DEFAULT VALUES.
 * They have to be. `_loadAgentGroups` seeds the group, runs the converter, and
 * PERSISTS the converted result, so the shape that reaches disk is never the
 * literal in `DEFAULT_TEAM_DEFINITIONS`; a strict key-set match returns false
 * for every seed that has ever been loaded, `hasAuthoredTeams` then reads a
 * seed-only root as authored, and `listTeamsInRoots` stops there — the exact
 * phantom-seed bug this predicate exists to prevent. (Member-less presets hid
 * this: with `members: []` the converter changed nothing, so nothing was
 * written back.) A member carrying a NON-default scope/relationship is the
 * operator's edit and still fails the match.
 */
const SEED_MEMBER_MIGRATION_DEFAULTS: Record<string, string> = {
    scope: 'per-team',
    relationship: 'reports-to-head',
};

/**
 * Group-level keys the SEED gained after rows had already been persisted, and
 * which a pre-upgrade row therefore does not carry. Same tolerance as `machine`
 * above, and for the same reason: a strict key-set match reads every row written
 * before the key existed as AUTHORED, `hasAuthoredTeams` then reports a seed-only
 * root as authored, and `listTeamsInRoots` stops there — the phantom-seed bug
 * this predicate exists to prevent.
 *
 * `listTeamsInRoots` reads `terminals.agentGroups` RAW and never seeds, so a root
 * the operator has not opened since the upgrade still holds the pre-upgrade shape
 * and the one-shot reset has not touched it. Both shapes are live at once.
 *
 * ABSENCE is tolerated; a DIFFERENT value is not. An operator who renamed the
 * team, retyped its prompt, changed its pair intensity or flipped its in-use
 * switch has authored it, and must still fail the match.
 */
const SEED_STRUCTURAL_KEYS: readonly string[] = ['members', 'machine'];

export function isUntouchedSeed(group: any): boolean {
    if (!group || typeof group !== 'object') { return false; }
    if (group.id !== SEEDED_AGENT_GROUP.id) { return false; }
    if (group.name !== SEEDED_AGENT_GROUP.name) { return false; }
    if (group.headRole !== SEEDED_AGENT_GROUP.headRole) { return false; }
    const members = group.members;
    const seedMembers = SEEDED_AGENT_GROUP.members;
    if (!Array.isArray(members) || members.length !== seedMembers.length) { return false; }
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const sm = seedMembers[i];
        if (!m || m.role !== sm.role || m.count !== sm.count) { return false; }
        if ((m.label || '') !== (sm.label || '')) { return false; }
        // Per-member startupCommand is retired (plan:
        // agents-are-saved-per-machine-and-a-team-picks-one). A seed member has
        // no startupCommand key; an authored one may still carry a stale empty
        // string from a prior release, which is the same as absent.
        if ((m.startupCommand || '') !== (sm.startupCommand || '')) { return false; }
        // Keys beyond the seed's own are allowed ONLY for the two converter
        // defaults (at their default values) and for the RETIRED
        // `startupCommand` key at its blank seed value. The retired key has to
        // be tolerated: every release before
        // `agents-are-saved-per-machine-and-a-team-picks-one` seeded members
        // with `startupCommand: ''` and PERSISTED them, so a strict key-set
        // match reads every already-written seed as authored — the phantom-seed
        // bug this predicate exists to prevent. A NON-blank value is the
        // operator's edit and still fails the match (the check above).
        const smKeys = new Set(Object.keys(sm));
        for (const key of Object.keys(m)) {
            if (smKeys.has(key)) { continue; }
            if (key === 'startupCommand') {
                if ((m[key] || '') !== '') { return false; }
                continue;
            }
            if (!(key in SEED_MEMBER_MIGRATION_DEFAULTS)) { return false; }
            if (m[key] !== SEED_MEMBER_MIGRATION_DEFAULTS[key]) { return false; }
        }
        // Every seed key must still be present.
        for (const key of smKeys) {
            if (!(key in m)) { return false; }
        }
    }
    // Check for extra keys on the group itself (e.g. scope, relationship
    // already added by a prior partial migration — those mean it was
    // touched, even if the members matched).
    // The team's machine must match the seed's (`local`). Compared BY VALUE
    // with an absent key defaulting to `local`, and excluded from the key-set
    // match below: a seed persisted before the machine field existed has no
    // `machine` key, and a strict key-set match would read it as authored (the
    // phantom-seed bug). `migrateAgentGroups` stamps the key on read, so both
    // shapes are live at once.
    if ((group.machine || 'local') !== (SEEDED_AGENT_GROUP.machine || 'local')) { return false; }
    // The late-added seed keys: tolerated when ABSENT (a row persisted before the
    // key existed), required to MATCH when present (an edited value is the
    // operator's authorship). Compared by JSON so `acceptedKinds` — an array —
    // compares by value rather than by identity.
    // Compare BY VALUE against the seed, in both directions. This replaced a
    // hand-maintained allowlist of "keys the seed gained late", which had to be
    // extended by hand every time a default grew a field and broke this predicate
    // silently in between — twice in one day (enabled/enabledSource/acceptedKinds,
    // then jet/automatedDispatch). The rule below needs no maintenance:
    //
    //   - a seed key ABSENT on the group   → tolerated (a row persisted before the
    //     key existed; listTeamsInRoots reads raw and never re-seeds, so those rows
    //     stay live indefinitely)
    //   - a seed key PRESENT but different → the operator authored it → not a seed
    //   - a key on the group the seed does not have → the operator added it
    //
    // `members` and `machine` are handled above with their own tolerances.
    const structural = (k: string) => SEED_STRUCTURAL_KEYS.indexOf(k) >= 0;
    for (const key of Object.keys(SEEDED_AGENT_GROUP)) {
        if (structural(key)) { continue; }
        if (!(key in group)) { continue; }
        if (JSON.stringify(group[key]) !== JSON.stringify(SEEDED_AGENT_GROUP[key])) { return false; }
    }
    for (const key of Object.keys(group)) {
        if (structural(key)) { continue; }
        if (!(key in SEEDED_AGENT_GROUP)) { return false; }
    }
    return true;
}

/** A candidate root carries operator intent only if it has at least one team
 *  that is not the auto-seed. A root holding nothing but the seed must not
 *  shadow a root that holds real definitions — that is exactly how a phantom
 *  seeded row hid the operator's real team. */
function hasAuthoredTeams(groups: any[]): boolean {
    return Array.isArray(groups) && groups.some(g => g && !isUntouchedSeed(g));
}

/**
 * Read team definitions from the first candidate root that holds authored
 * teams, nearest-first. Migrates in memory (same guarantee as
 * findTeamForHeadRole / resolveTeamById) and NEVER writes — this is the read
 * path for the terminals panel, and a read must not seed.
 *
 * Returns `{ teams, root }`, or `{ teams: [], root: null }` when no candidate
 * holds authored teams. The caller decides what to show for the empty case.
 */
export async function listTeamsInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>
): Promise<{ teams: any[]; root: string | null }> {
    for (const root of roots) {
        let db: any;
        try { db = await getDb(root); }
        catch (err) { console.warn(`[teamWiring] Team list: DB unavailable for '${root}':`, err); continue; }
        if (!db) { continue; }
        try {
            const raw = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, null) as any[] | null;
            if (!Array.isArray(raw) || !hasAuthoredTeams(raw)) { continue; }
            return { teams: migrateAgentGroups(raw) ?? raw, root };
        } catch (err) {
            console.warn(`[teamWiring] Team list: read failed for '${root}':`, err);
        }
    }
    return { teams: [], root: null };
}

/** The id-resolving twin. Walks the SAME candidate order as listTeamsInRoots so
 *  the team the picker listed is the team START resolves. Returns the matched
 *  db alongside the team so the caller does not re-open a second, different one. */
export async function resolveTeamByIdInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>,
    teamId: string
): Promise<{ team: any; root: string; db: any } | null> {
    for (const root of roots) {
        let db: any;
        try { db = await getDb(root); }
        catch { continue; }
        if (!db) { continue; }
        const team = await resolveTeamById(db, teamId);
        if (team) { return { team, root, db }; }
    }
    return null;
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
    if (!team) {
        // Distinguish "no such team" from "switched off". resolveTeamById refuses
        // a disabled team, and a refusal that reads as "not found" would send the
        // operator hunting for a definition that is sitting right there in the
        // Teams tab with its switch off.
        const disabled = await resolveTeamByIdIncludingDisabled(db, teamId);
        if (disabled) { return { success: false, error: teamDisabledMessage(disabled) }; }
        return { success: false, error: `No team found with id '${teamId}'` };
    }

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
    settings?: TerminalGroupsSettingsAccessor;
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
     * The team prompt — operator-authored prose carried as one `team`-scoped
     * standing order delivered to every member on every message. When omitted,
     * nothing is persisted: the system protocol (member completion, work, git
     * safety, subagent policy) is composed at delivery from code and never
     * lives on a row.
     */
    prompt?: string;
    /**
     * Prose delivered to the HEAD of the team on every message, as one
     * `team-head`-scoped standing order. Optional: a team with no head prompt
     * installs no head order. Never defaulted — a fabricated head instruction
     * would be wrong for every team whose head is not a coding lead.
     */
    headPrompt?: string;
    /**
     * True when the team lead is a non-terminal external agent (Antigravity /
     * Cursor / IDE chat). Workers receive the external-member-callback fragment
     * (composed at delivery) to write reports to
     * .switchboard/teams/<teamId>/reports/, skips installing a team-head
     * standing order, and excludes the headName from group.members
     * (workers only).
     */
    externalHead?: boolean;
    /**
     * The head's role ('lead', 'planner', 'reviewer', etc.). Persisted into the
     * live group object so readers like resolveCodingRolesFromGroups can filter
     * on it without cross-referencing terminals.agentGroups. Defaults to 'lead'
     * — wireSpawnedTeam is only called for team groups, and every coding team's
     * head role is 'lead'.
     */
    headRole?: string;
    /**
     * External-headed teams only: fired once the group registration has landed,
     * with the roster that was actually persisted. The caller regenerates
     * `.switchboard/teams/<teamId>/head-prompt.md` from it. Passed as a callback
     * rather than imported directly because the writer lives in
     * agentGroupInstantiation, which already imports this module — calling it
     * from here would close an import cycle.
     */
    regenerateHeadPrompt?: (info: { groupId: string; memberNames: string[] }) => Promise<void> | void;
    /**
     * Queue pacing for this team — `'head'` (default) or `'seat'`. Persisted
     * onto the registered `terminals.groups` row so the pop (subtask 1), the
     * watch (subtask 3), and `Run queue`'s status text read it through
     * {@link readTeamPacing}. Absent behaves identically to `'head'` — the
     * compatibility contract for the whole install base. When `'seat'`,
     * `_runQueuePop` skips in-flight checks. Owned by subtask 3; the caller copies it from the team
     * template (`terminals.agentGroups`).
     */
    pacing?: 'head' | 'seat';
    /**
     * The team template id (`terminals.agentGroups` row id) this live group was
     * spawned from. Persisted onto the registered `terminals.groups` row so a
     * pacing flip on the template can find and update the live group(s) without
     * a fragile name match. Absent for teams spawned outside the template path
     * (the pty-verb path) — those carry no template and cannot be toggled from
     * the TEAMS tab. Owned by subtask 3.
     */
    templateId?: string;
    /**
     * The team **definition** id (`terminals.agentGroups` row id) this live
     * group was spawned from — the precise link back to the template that
     * produced the team. Distinct from `templateId` (which subtask 3 owns
     * for pacing flips): `definitionId` is the identity link every
     * team-scoped consumer reads through `resolveDefinitionForGroup`.
     *
     * Absent for teams spawned outside the definition path (the pty-verb
     * path, or a manual spawn with no `group`). When absent,
     * `resolveDefinitionForGroup` falls back to a role-match. Persisted
     * onto the registered `terminals.groups` row so any surface can
     * resolve a running terminal to its team and read that team's
     * properties (icon, name, head, roster) without re-deriving the link.
     */
    definitionId?: string;
    /**
     * The workspace root for writing the run-scoped member orders file
     * (`.switchboard/teams/<teamId>/member-orders.md`). When provided,
     * `wireSpawnedTeam` writes the file after the group registration lands,
     * mirroring the head-prompt file pattern for external-headed teams. Absent
     * for callers that have no workspace root (tests, headless harnesses) —
     * no file is written. All four production call sites pass it; the write is
     * still skipped when `.switchboard/` does not exist, so an absent file is a
     * real state and the turn-end reminder existence-checks the path before
     * naming it.
     */
    workspaceRoot?: string;
    /**
     * The team's machine id — a team is one machine (`delegateMachineId` is
     * uniform across it). Threaded to `writeMemberOrdersFile` so the
     * `<cliPath>` tokens in member-orders.md resolve to THAT machine's CLI
     * (its configured `cliPath`, or bare `switchboard` resolved by the
     * remote's PATH) — never the board host's absolute binary path, which
     * does not exist on the remote box. Absent → `'local'` (today's output).
     */
    machineId?: string;
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
 * Write `.switchboard/teams/<teamId>/member-orders.md` — the durable,
 * re-readable orders file for team members, mirroring the head's
 * `head-prompt.md`. A member under context pressure attends to a file it is
 * pointed at; without this file, the completion recipe delivered once at
 * dispatch is gone by the time it is needed hours later.
 *
 * The file contains the composed member standing orders (the completion
 * fragment for regular teams, the file-report callback for external-headed
 * teams) plus git safety and work obligations. It is run-scoped: it names
 * this head, this team, this port, and is replaced on the next team start.
 * `.switchboard/*` is gitignored, so the file is never committed.
 */
export async function writeMemberOrdersFile(
    workspaceRoot: string,
    teamId: string,
    opts: {
        headName: string;
        headRole?: string;
        children: Array<{ friendlyName: string; role?: string }>;
        externalHead?: boolean;
        pacing?: 'head' | 'seat';
        /** The team's machine — one per team; resolves the `<cliPath>` tokens
         *  to that machine's CLI rather than the host's. Absent → local. */
        machineId?: string;
    }
): Promise<string | null> {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    // Same guard as writeHeadPromptFile / bootstrapTeamReportsDirectory:
    // `.switchboard` is created by the extension's own scaffolder, never by a
    // writer that happens to want a subdirectory. `mkdir -p` here would litter
    // a non-Switchboard workspace with a half-built control directory.
    if (!fs.existsSync(sbDir)) { return null; }
    const teamDir = path.join(sbDir, 'teams', teamId);
    await fs.promises.mkdir(teamDir, { recursive: true });

    const { headName, headRole, children, externalHead, pacing } = opts;
    const childNames = children.map(c => c.friendlyName).filter(n => typeof n === 'string' && n.length > 0);
    const reviewerSeat = children.some(c => String(c.role || '').toLowerCase() === 'reviewer');

    // Compose the member standing orders from the same fragments
    // `wireSpawnedTeam` installs as the team-scoped standing order. The
    // fragment body functions carry the `<cliPath>` token; substitute it
    // before writing so the file contains a runnable command, not a token.
    const memberFragments = externalHead
        ? [STANDING_ORDER_FRAGMENT_IDS.externalMemberCallback, STANDING_ORDER_FRAGMENT_IDS.gitSafety, STANDING_ORDER_FRAGMENT_IDS.subagentPolicy]
        : [STANDING_ORDER_FRAGMENT_IDS.memberCompletion, STANDING_ORDER_FRAGMENT_IDS.memberWork, STANDING_ORDER_FRAGMENT_IDS.gitSafety, STANDING_ORDER_FRAGMENT_IDS.subagentPolicy];

    const ctx: StandingOrderCompositionContext = {
        targetName: childNames[0] || '',
        inTeam: true,
        isHead: false,
        teamId,
        headName,
        headRole: headRole || 'lead',
        members: childNames,
        reviewerSeat,
        workKind: (headRole || 'lead') === 'planner' ? 'plan' : 'feature',
        pacing: pacing === 'seat' ? 'seat' : 'head',
        orchestratorPresent: false,
        attended: false,
        externalHead: !!externalHead,
    };

    const composed = composeStandingOrderFragments(memberFragments, ctx);
    // Record which source answered for each static fragment. member-orders.md is
    // a SNAPSHOT written to disk, so a body that resolved from the compiled
    // default (cold cache, no store row) is frozen into the file until the team
    // is re-wired — "which store answered?" has to be answerable after the fact.
    const fragmentSources = Object.entries(composed.sources);
    if (fragmentSources.length) {
        console.log(`[teamWiring] member-orders fragment sources for team '${teamId}': ${fragmentSources.map(([id, src]) => `${id}=${src}`).join(', ')}`);
    }
    // Resolve `<cliPath>` to the TEAM's machine (plan: a-remote-machines-cli-
    // path-and-working-directory). This file is read by seats on that machine —
    // the host's absolute binary path does not exist there. A remote machine
    // resolves to its configured cliPath or bare `switchboard` (PATH answers on
    // the remote); absent/local resolves today's host invocation unchanged.
    const cliInvocation = await GlobalIntegrationConfigService.resolveCliInvocationForMachineId(opts.machineId).catch(() => undefined);
    const ordersText = substituteCliPath(composed.text, undefined, cliInvocation);

    const content = `# Member Orders — Team ${headName}

You are a member of this team. Read this file to re-orient before reporting
your completion. Your standing orders are below.

## Team Roster
- **Head:** ${headName}
${childNames.map(n => `- **Member:** ${n}`).join('\n')}

## Your Standing Orders

${ordersText}
`;

    const filePath = path.join(teamDir, 'member-orders.md');
    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
}

/**
 * Wire a head and its children: install standing orders and register or update
 * a terminals group so the roster reflects the most recent spawn. Idempotent on
 * re-run — team-scoped orders are keyed on `(scope, teamId)` and pair-scoped orders
 * on `(parent, child)`. Group roster rows are upserted with freshly computed
 * members/order/layout while preserving existing custom properties. Returns
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
 * handoff, second-opinion) still emit one pair row each, installed ON
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
    // The operator-authored prompt (from the team definition) is carried as
    // one team-scoped standing order. {child} is interpolated to the head name
    // and {teamId} to the groupId. When the definition carries no `prompt`,
    // nothing is persisted — the system protocol is composed at delivery
    // (selectOrders) and never lives on a row.
    const teamPromptInstruction = prompt
        ? prompt.replace(/\{child\}/g, headName).replace(/\{teamId\}/g, groupId)
        : undefined;

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
    //
    // Under the definitions library model, the team prompt and head prompt
    // become definitions (created via ensureStandingOrderDefinition, which
    // deduplicates by instruction text); the orders become assignments
    // referencing them via `definitionId`. The `instruction` copy stays on
    // the assignment so the delivery path (selectOrders / renderOrder) and
    // old builds are unchanged. Each team gets its own definitions (the team
    // prompt includes the head name and team ID interpolated, making it
    // unique per team). When a team is deleted, its definitions orphan in
    // the library — the operator can delete them from the UI. This is an
    // accepted limitation.

    // Compute the head instruction text BEFORE creating the definition.
    // The firstCoder resolution depends only on children/members/childNames,
    // not on the persisted orders, so it is safe to compute here.
    let headInstruction: string | undefined;
    if (!opts.externalHead) {
        let firstCoder = children.find(c => c?.role === 'coder')?.friendlyName || '';
        if (!firstCoder && members && Array.isArray(members)) {
            let childIdx = 0;
            for (const def of members) {
                const count = Math.max(1, Math.min(def.count || 1, 8));
                for (let i = 0; i < count && childIdx < childNames.length; i++) {
                    const memberName = childNames[childIdx++];
                    if (def.role === 'coder' && !firstCoder) {
                        firstCoder = memberName;
                    }
                }
            }
        }
        const headPromptText = (opts.headPrompt || '').trim();
        if (headPromptText) {
            let replacedText = headPromptText.replace(/\{head\}/g, headName);
            if (firstCoder) {
                replacedText = replacedText.replace(/\{coder\}/g, firstCoder);
            } else if (headPromptText.includes('{coder}')) {
                // No coder child was found for this team, but the head prompt
                // references {coder}. Fail the spawn loudly: leaving the
                // placeholder unsubstituted would install a standing order
                // that ptySendPrompts a terminal literally named "{coder}"
                // every round and fails silently. A fallback that behaves
                // like a real value (a head prompt that looks complete but
                // addresses a non-existent seat) is the codebase's named
                // failure mode — refuse the spawn instead.
                return {
                    ok: false,
                    error: `Team "${groupId}" head prompt references {coder} but no coder seat is on the team (head=${headName}). Add a coder member or change the head prompt.`,
                };
            }
            headInstruction = replacedText;
        }
    }

    try {
        await mutateStandingOrders(db, async (orders) => {
            const next = [...orders];

            // Team-scoped order: ONLY when the operator authored a prompt.
            // System protocol is composed at delivery (selectOrders) and never
            // persisted, so a team with no authored prompt writes no row at
            // all. Keyed on (scope, teamId) for idempotency — a re-run skips
            // an existing authored row rather than duplicating. Same mutator
            // as the head order and pair rows below — do not split into a
            // second mutateStandingOrders call; that reopens the
            // read-modify-write window.
            if (teamPromptInstruction) {
                const teamExists = next.some((o: StandingOrder) =>
                    o.scope === 'team' && o.teamId === groupId);
                if (!teamExists) {
                    next.push(makeStandingOrder(headName, '', teamPromptInstruction, 'team', groupId));
                }
            }

            // Head-facing order: ONLY when the operator authored a headPrompt.
            // System head protocol is composed at delivery; no row is written
            // for a team whose definition left the head-prompt box empty.
            // Skipped for external heads — no head terminal.
            if (!opts.externalHead && headInstruction) {
                const headExists = next.some((o: StandingOrder) =>
                    o.scope === 'team-head' && o.teamId === groupId);
                if (!headExists) {
                    next.push(makeStandingOrder(headName, '', headInstruction, 'team-head', groupId));
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
    // The backend writes to the unified terminals.groups key through
    // mutateTerminalGroups. The write is serialised through _groupsWriteChain
    // so two concurrent heads do not drop one another's group. The caller
    // pushes a `terminalsGroupsChanged` broadcast after a successful
    // registration so open panels re-read the key before their next
    // whole-array save can clobber it.
    //
    // For external-headed teams, exclude the headName from members and order —
    // the head is a non-terminal agent and should not appear in getGroupMembers.
    const groupMembers = opts.externalHead
        ? [...childNames]
        : [headName, ...childNames];
    // No team is sized at spawn any more. Deciding a pane count once, from the roster
    // as it stood that second, is what froze a grown team at its first day's size; the
    // panel now resolves a team's grid from its roster every time it is entered.
    //
    // This field is written only to keep the row loadable — the panel's two load
    // filters still require a valid `layout` — and 'auto' is the honest value for it:
    // no fixed size. The operator's actual preference lives in `layoutPref`, which
    // only the layout picker writes, so a deliberate cap and an absent choice are
    // finally distinguishable. A row without `layoutPref` sizes from its roster, which
    // is every row that predates this change.
    const layout = TERMINALS_AUTO_LAYOUT;
    // Persisted so a reader can tell "members[0] is the head" from "the head is not a
    // seat at all". Without it the terminals panel crowns members[0] — which for an
    // external-headed team is the first CODER, since the head is excluded above.
    const externalHead = opts.externalHead === true;
    // Pacing: copy from the template (opts.pacing) onto the registered group.
    // Absent → omit the key entirely so the row stays byte-identical to a
    // pre-subtask-3 install (absent reads as 'head' through readTeamPacing).
    // Only a literal 'seat' is written; 'head' is the default and is expressed
    // by absence, never by an explicit field, so a stale writer cannot flip the
    // install base by defaulting a boolean.
    const pacingField = opts.pacing === 'seat' ? { pacing: 'seat' as const } : {};
    const templateIdField = opts.templateId ? { templateId: opts.templateId } : {};
    // Identity link: definitionId (when known), head (declared, not inferred
    // from order[0]), teamKind (positive marker that this manual group is a
    // real spawned team). definitionId is conditional (absent for pty-verb
    // spawns with no definition); head and teamKind are always written — they
    // are known at every spawn and are the fields every consumer reads through
    // isSpawnedTeamGroup / teamHeadName / resolveDefinitionForGroup.
    const definitionIdField = opts.definitionId ? { definitionId: opts.definitionId } : {};
    const group = {
        id: groupId,
        name: headName,
        headRole: opts.headRole || 'lead',
        source: 'manual' as const,
        teamGroup: true,
        teamKind: 'spawned' as const,
        head: headName,
        layout,
        members: groupMembers,
        order: groupMembers,
        externalHead,
        ...pacingField,
        ...templateIdField,
        ...definitionIdField,
    };

    try {
        await mutateTerminalGroups({ db, settings: opts.settings }, (current) => {
            // Upsert — the freshly spawned team is the whole truth for members and
            // order. Replace stale members (not union), preserve operator-authored
            // layout and any unknown keys from existing group objects.
            const idx = current.findIndex((g: any) => g && g.id === groupId);
            if (idx === -1) {
                return [...current, group];
            }
            const existing = current[idx];
            const { pacing: _existingPacing, ...existingWithoutPacing } = (existing && typeof existing === 'object') ? existing : {};
            void _existingPacing;
            const merged = (existing && typeof existing === 'object')
                ? {
                    ...existingWithoutPacing,
                    id: groupId,
                    name: headName,
                    headRole: opts.headRole || 'lead',
                    source: 'manual' as const,
                    teamGroup: true,
                    teamKind: 'spawned' as const,
                    head: headName,
                    layout: (typeof existing.layout === 'string' && TERMINALS_STORABLE_LAYOUTS.has(existing.layout))
                        ? existing.layout
                        : layout,
                    members: groupMembers,
                    order: groupMembers,
                    externalHead,
                    ...pacingField,
                    ...templateIdField,
                    ...definitionIdField,
                }
                : group;
            const next = [...current];
            next[idx] = merged;
            return next;
        });
    } catch (err: any) {
        // A failed group write must not undo a successful order install.
        return { ok: false, error: `Group registration failed: ${err?.message || err}` };
    }

    // Head-prompt regeneration (external heads only). Runs AFTER the group write
    // so the file describes the persisted roster, never a roster the write
    // rejected. A failure here leaves a stale file, not a broken team, so it
    // must not fail the wiring.
    if (opts.externalHead && opts.regenerateHeadPrompt) {
        try { await opts.regenerateHeadPrompt({ groupId, memberNames: groupMembers }); }
        catch (err) { console.warn('[teamWiring] regenerateHeadPrompt failed:', err); }
    }

    // Member orders file — the durable, re-readable orders file for team
    // members, mirroring the head's `head-prompt.md`. Written for ALL teams
    // (regular and external-headed) when a workspace root is available. A
    // failure here leaves a missing file, not a broken team: the turn-end
    // reminder existence-checks the path and names the completion route
    // instead. Note the standing-order fragments name this file
    // UNCONDITIONALLY, so a skipped write does leave that one pointer dangling
    // in the establish-time block — acceptable because the block it sits in
    // carries the full recipe anyway, which is exactly what the file duplicates.
    // Runs AFTER the group write so `groupId` is the persisted team id.
    if (opts.workspaceRoot && childNames.length > 0) {
        try {
            await writeMemberOrdersFile(opts.workspaceRoot, groupId, {
                headName,
                headRole: opts.headRole,
                children: children as Array<{ friendlyName: string; role?: string }>,
                externalHead: opts.externalHead,
                pacing: opts.pacing,
                machineId: opts.machineId,
            });
        } catch (err) { console.warn('[teamWiring] writeMemberOrdersFile failed:', err); }

        // Bootstrap the team reports directory for normal (terminal-lead)
        // teams. The memberCompletion standing order fragment tells workers to
        // write report files to .switchboard/teams/<teamId>/reports/ — the
        // status pane reads this inbox. Without the directory the write fails
        // silently and the pane reads idle even while the seat is working.
        // External-headed teams already bootstrap this in
        // instantiateExternalHeadedTeam; this is the twin for terminal-lead
        // teams. Same lazy guard: returns null when .switchboard is absent.
        if (!opts.externalHead) {
            try {
                await bootstrapTeamReportsDirectory(opts.workspaceRoot, groupId);
            } catch (err) { console.warn('[teamWiring] bootstrapTeamReportsDirectory failed:', err); }
        }
    }

    return { ok: true, groupId };
}

/**
 * Drop pre-rewrite per-member pair rows carrying the legacy callback text that
 * named `.switchboard/api-server-port.txt`. These are system-authored rows
 * from before the team-scoped order existed; system orders are now composed at
 * delivery ({@link selectOrders}) and never persisted, so the rows are DROPPED
 * (not folded into a team-scoped order, which would itself be a system row
 * violating the "no system-authored text on disk" invariant). Operator-authored
 * Link-up pair rows are untouched — they do not carry this text.
 *
 * Pure: no DB writes of its own. Called through {@link loadEffectiveStandingOrders},
 * which persists the result once. Idempotent: a second pass finds nothing to
 * drop. **Returns the input array BY REFERENCE when it recognises nothing** —
 * `loadEffectiveStandingOrders` stakes its "did anything change?" test on that
 * identity, so a refactor that always returns a fresh array turns the one-time
 * persist into a write on every prompt.
 */
export function migrateTeamPairOrders(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    let changed = false;
    const next = orders.filter(o => {
        if (!o || typeof o !== 'object') { return true; }
        const scope = o.scope || 'pair';
        if (scope !== 'pair') { return true; }
        if (typeof o.instruction === 'string' && o.instruction.includes('.switchboard/api-server-port.txt')) {
            changed = true;
            return false;
        }
        return true;
    });
    return changed ? next : orders;
}

/** Backup config key for standing orders before first migration persist. */
export const STANDING_ORDERS_PREMIGRATION_BAK_KEY = 'terminals.standingOrders.premigration.bak';

/**
 * Copy pre-migration standing orders to backup key once if not already present.
 */
async function backupOnce(db: any, raw: StandingOrder[]): Promise<void> {
    if (!db || typeof db.getConfigJson !== 'function' || typeof db.setConfigJson !== 'function') {
        return;
    }
    const existing = await db.getConfigJson(STANDING_ORDERS_PREMIGRATION_BAK_KEY, null);
    if (existing === null || existing === undefined) {
        await db.setConfigJson(STANDING_ORDERS_PREMIGRATION_BAK_KEY, raw);
    }
}

/**
 * Migrate existing orders into the definitions library. For each order with
 * an `instruction` but no `definitionId`, find or create a definition with
 * the same instruction text (deduplication), then stamp `definitionId` on
 * the order. Persists both the new definitions
 * (via {@link mutateStandingOrderDefinitions}) and the stamped orders (via
 * {@link mutateStandingOrders}).
 *
 * **Gate:** `orders.some(o => !o.definitionId && o.instruction)` — if every
 * order already has a `definitionId` (or no instruction), returns the input
 * BY REFERENCE (no write). This preserves the identity short-circuit that
 * prevents a write on every prompt.
 *
 * **Self-healing:** the two writes (definitions + orders) are not atomic —
 * they serialize through the shared `_writeChain`. If the process crashes
 * between them, definitions are written but orders are not stamped. The
 * next `loadEffectiveStandingOrders` re-runs this function, the gate fails
 * (orders still lack `definitionId`), finds the existing definitions by
 * instruction text (deduplication), and stamps `definitionId`.
 *
 * Returns the stamped array (or the input by reference when the gate
 * doesn't fire).
 */
async function migrateToDefinitions(db: any, orders: StandingOrder[]): Promise<StandingOrder[]> {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    // Gate: any order with instruction but no definitionId?
    if (!orders.some(o => o && !o.definitionId && o.instruction)) {
        return orders; // identity short-circuit — no write
    }

    // Read existing definitions and build an instruction→definition index.
    const rawDefs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
    const defs = Array.isArray(rawDefs) ? rawDefs : [];
    const byInstruction = new Map<string, StandingOrderDefinition>();
    for (const d of defs) {
        if (d && d.id && d.instruction) { byInstruction.set(d.instruction, d); }
    }

    // Find or create a definition for each unique instruction that lacks one.
    const newDefs: StandingOrderDefinition[] = [];
    for (const o of orders) {
        if (!o || o.definitionId || !o.instruction) { continue; }
        if (byInstruction.has(o.instruction)) { continue; }
        const def = makeStandingOrderDefinition(
            o.instruction.slice(0, 60),
            o.instruction,
            o.createdAt || Date.now()
        );
        byInstruction.set(o.instruction, def);
        newDefs.push(def);
    }

    // Persist new definitions (if any were created). If this fails, do NOT
    // stamp orders — a dangling definitionId (pointing to a definition that
    // was never persisted) would permanently break the library link, since
    // the migration gate would pass on the next read (orders already have
    // definitionId) and reSyncAssignmentsFromDefinitions would find no match
    // (definition not in DB) and leave the instruction as-is. Returning
    // orders unstamped lets the next read retry the whole migration.
    let defsPersisted = true;
    if (newDefs.length > 0) {
        try {
            await mutateStandingOrderDefinitions(db, async (current) => {
                const existingIds = new Set(
                    current.filter(d => d && d.id).map(d => d.id)
                );
                return [...current, ...newDefs.filter(d => !existingIds.has(d.id))];
            });
        } catch (err) {
            console.warn('[teamWiring] definitions migration: persist definitions failed:', err);
            defsPersisted = false;
        }
    }
    if (!defsPersisted) {
        return orders; // identity — next read retries
    }

    // Stamp orders with definitionId (in-memory) and persist.
    const stamp = (arr: StandingOrder[]): StandingOrder[] => {
        let changed = false;
        const next = arr.map(o => {
            if (!o || o.definitionId || !o.instruction) { return o; }
            const def = byInstruction.get(o.instruction);
            if (!def) { return o; }
            changed = true;
            return { ...o, definitionId: def.id };
        });
        return changed ? next : arr;
    };

    const stamped = stamp(orders);
    if (stamped !== orders) {
        try {
            await mutateStandingOrders(db, async (current) => stamp(current));
        } catch (err) {
            console.warn('[teamWiring] definitions migration: persist orders failed:', err);
        }
    }
    return stamped;
}

/**
 * Lazy re-sync wrapper: reads definitions from the DB, runs the pure
 * {@link reSyncAssignmentsToDefinitions} transform, and persists the
 * corrected orders if anything drifted. The crash-recovery path for the
 * eager sync ({@link syncDefinitionToAssignments}). Returns the input BY
 * REFERENCE when no order has a `definitionId` or nothing drifted.
 */
async function reSyncAssignmentsFromDefinitions(db: any, orders: StandingOrder[]): Promise<StandingOrder[]> {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    if (!orders.some(o => o && o.definitionId)) { return orders; }
    const rawDefs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
    const defs = Array.isArray(rawDefs) ? rawDefs : [];
    const resynced = reSyncAssignmentsToDefinitions(defs, orders);
    if (resynced === orders) { return orders; }
    try {
        await mutateStandingOrders(db, async (current) =>
            reSyncAssignmentsToDefinitions(defs, current)
        );
    } catch (err) {
        console.warn('[teamWiring] definitions re-sync persist failed:', err);
    }
    return resynced;
}

/**
 * One-time clean break: drop system-authored standing-order rows. Teams have
 * never shipped, so there is no install base to migrate — system orders are
 * composed at delivery ({@link selectOrders}) and never persisted. The
 * persisted store must hold only what a human authored.
 *
 * Recognises system rows by:
 *  - deterministic id prefix (`context-aware-completion:`, `composed-head:`)
 *    stamped by the retired `wireSpawnedTeam` system-install path; OR
 *  - `instruction` text naming the bare `.switchboard/api-server-port.txt`
 *    path (legacy system rows with uuid ids).
 *
 * Operator-authored rows (Link-up pair rows, authored team/head prompts,
 * role-scoped notes) are untouched. Returns the input BY REFERENCE when
 * nothing changed, so {@link loadEffectiveStandingOrders} can avoid a write
 * on every prompt.
 */
export function dropSystemAuthoredRows(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    let changed = false;
    const next = orders.filter(o => {
        if (!o || typeof o !== 'object') { return true; }
        const id = typeof o.id === 'string' ? o.id : '';
        // Synthetic ids are unambiguous — these rows are system-minted by
        // construction, at any scope.
        if (id.startsWith('context-aware-completion:') || id.startsWith('composed-head:')) {
            changed = true;
            return false;
        }
        // SCOPE GUARD. The port-file recogniser is a heuristic on TEXT, not proof
        // of authorship, so it is confined to `pair` rows — the per-member callback
        // rows it was written for.
        //
        // Without this guard it reached every scope. On 2026-09-14 it removed an
        // operator's `team` and `team-head` rows, including the lead's
        // dispatch-by-recommendedRole rule and its two-failure escalation ladder,
        // because those instructions happened to mention the port file too. A rule
        // about per-member pair rows must not be able to take a team's orchestration
        // order as collateral.
        //
        // `migrateTeamPairOrders` has always guarded this way (`scope !== 'pair'` →
        // keep). This function did not, and the asymmetry was the whole defect.
        const scope = o.scope || 'pair';
        if (scope !== 'pair') { return true; }
        if (typeof o.instruction === 'string' && o.instruction.includes('.switchboard/api-server-port.txt')) {
            changed = true;
            return false;
        }
        return true;
    });
    return changed ? next : orders;
}

/**
 * The only server-side reader of terminals.standingOrders. Reads, applies the
 * pure transforms, persists the result once if anything changed, and returns the
 * effective set. A failed persist logs and returns the in-memory transform —
 * delivery never depends on the write.
 *
 * The system-row cleanup ({@link dropSystemAuthoredRows}) and the pair-row
 * cleanup ({@link migrateTeamPairOrders}) run first and persist once; both are
 * no-ops after the first successful persist. The definitions migration
 * ({@link migrateToDefinitions}) and the lazy re-sync
 * ({@link reSyncAssignmentsFromDefinitions}) follow; both are gated to avoid a
 * write on every prompt when nothing needs to change.
 */
export async function loadEffectiveStandingOrders(db: any): Promise<StandingOrder[]> {
    if (!db || typeof db.getConfigJson !== 'function') {
        return [];
    }
    const raw = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];

    // READ-TIME ONLY. The droppers below filter what is DELIVERED; they must never
    // be written back over the stored rows.
    //
    // This previously persisted the filtered array through `mutateStandingOrders`,
    // and on 2026-09-14 that deleted all six of an operator's standing orders —
    // including a `team-head` order carrying the lead's dispatch-by-recommendedRole
    // rule and its escalation ladder. `a-stale-standing-order-can-still-reach-a-live-agent.md`
    // had named this exact hazard before it happened:
    //
    //   "Persisting is destructive... Today they survive on disk and are only
    //    filtered at render — reversible. Persisting deletes them irreversibly."
    //
    // and recorded that `standing-orders-marker-contract.test.js:238-249` exists
    // specifically to assert the migration is NOT applied at the fetch level.
    //
    // Filtering at read is not a weaker fix: delivery applies the transforms every
    // time regardless, so an agent never receives a dropped row either way. The only
    // difference is whether the operator can get their rows back. They can now.
    //
    // Note `dropSystemAuthoredRows` has NO scope guard — it drops any row whose
    // instruction mentions the port file, `pair`, `team` and `team-head` alike. That
    // is why a rule about per-member pair rows removed team-scoped ones too.
    const effective0 = migrateTeamPairOrders(dropSystemAuthoredRows(raw));
    let effective = effective0;

    // Definitions migration (lazy, self-healing).
    try {
        effective = await migrateToDefinitions(db, effective);
    } catch (err) {
        console.warn('[teamWiring] definitions migration failed:', err);
    }

    // Lazy re-sync (crash recovery for the eager sync).
    try {
        effective = await reSyncAssignmentsFromDefinitions(db, effective);
    } catch (err) {
        console.warn('[teamWiring] definitions re-sync failed:', err);
    }

    return effective;
}

/** A persisted standing-order row annotated for the inspection surface. */
export interface InspectedStandingOrder extends StandingOrder {
    scope: StandingOrderScope;
    /**
     * The delivery-time read transforms ({@link dropSystemAuthoredRows},
     * {@link migrateTeamPairOrders}) remove this row from what agents receive,
     * but the row still sits in the store — it is shown, labeled, because
     * "on disk but never delivered" is exactly the stale-order failure the
     * surface exists to make visible.
     */
    dropped?: boolean;
    /**
     * The row's `definitionId` names a definition that no longer exists — its
     * `instruction` copy is still delivered but no longer tracks the library
     * entry (reSync finds no match and leaves it as-is).
     */
    stale?: boolean;
    /**
     * What is actually delivered when it differs from the on-disk
     * `instruction`: the resynced definition text, or the composed fragment
     * text for a fragment-bearing row (a fragments-only row has no persisted
     * `instruction` at all, so without this it would render blank).
     */
    effectiveInstruction?: string;
}

export interface StandingOrdersInspection {
    orders: InspectedStandingOrder[];
    definitions: StandingOrderDefinition[];
    coreOrders: Array<StandingOrder & { core: true }>;
}

/**
 * The ONE inspection read of the standing-orders store — shared by the
 * `getStandingOrders` verb (KanbanProvider, both hosts) and
 * `GET /terminals/standing-orders` (LocalApiServer) so the panel and the HTTP
 * surface cannot drift on what an order "is".
 *
 * Returns three things:
 *  - `orders`: every persisted row, annotated — `scope` defaulted to `pair`
 *    for shipped-state rows, `dropped`/`stale`/`effectiveInstruction` marking
 *    what the delivery path would do with the row (the transforms are
 *    read-time only, so a dropped row is still on disk and still listed).
 *  - `definitions`: the definitions library, verbatim.
 *  - `coreOrders`: the system-composed orders ({@link listCoreStandingOrders})
 *    — the population that governs agents without existing as rows. The tab
 *    must show both populations as such: a core order with no marking invites
 *    the edit-and-replace the additive contract forbids.
 *
 * `roleMap` (terminal name → role) is optional and only affects how the
 * composed text resolves role-dependent fragments; absent → the fragments that
 * consult it render their no-role variant.
 */
export async function inspectStandingOrders(
    db: any,
    roleMap?: Map<string, string>
): Promise<StandingOrdersInspection> {
    const raw = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];
    const rawArray = Array.isArray(raw) ? raw : [];
    const rawDefs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
    const definitions = Array.isArray(rawDefs) ? rawDefs : [];
    const definitionIds = new Set(definitions.map(d => d && d.id).filter(Boolean));

    // Groups: scoped key plus the legacy bare 'terminals.groups' merge every
    // reader performs — a team registered under the bare key only still gets
    // its core orders listed.
    let groups: TerminalGroup[] = [];
    try {
        const scoped = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
        groups = Array.isArray(scoped) ? [...scoped] : [];
        const bare = await db.getConfigJson('terminals.groups', []) as any[];
        if (Array.isArray(bare)) {
            const seen = new Set(groups.map(g => g && g.id).filter(Boolean));
            for (const g of bare) {
                if (g && typeof g.id === 'string' && !seen.has(g.id)) {
                    groups.push(g);
                    seen.add(g.id);
                }
            }
        }
    } catch (err) {
        // Logged, not silent: a failed groups read renders the same empty
        // coreOrders as "no teams exist", and the difference must be
        // recoverable after the fact.
        console.warn('[teamWiring] standing-orders inspection: groups read failed:', err);
    }

    // The pure half of loadEffectiveStandingOrders' transform chain, applied
    // for ANNOTATION rather than delivery. migrateToDefinitions is skipped —
    // it writes, and its only observable effect here (a stamped definitionId)
    // does not change what the row delivers.
    const kept = migrateTeamPairOrders(dropSystemAuthoredRows(rawArray));
    const keptSet = new Set(kept);
    const resynced = reSyncAssignmentsToDefinitions(definitions, kept);

    const orders: InspectedStandingOrder[] = rawArray.map(o => {
        const base: InspectedStandingOrder = {
            ...o,
            scope: (o.scope || 'pair') as StandingOrderScope,
        };
        if (!keptSet.has(o)) {
            base.dropped = true;
            return base;
        }
        const idx = kept.indexOf(o);
        const effective = (idx >= 0 ? resynced[idx] : o) || o;
        if (effective.instruction !== o.instruction) {
            base.effectiveInstruction = effective.instruction;
        }
        if (o.definitionId && !definitionIds.has(o.definitionId)) {
            base.stale = true;
        }
        // Fragment-bearing rows deliver composed fragment text (plus any
        // instruction body) — surface it, or a fragments-only row renders as
        // an empty instruction.
        if (Array.isArray(effective.fragments) && effective.fragments.length > 0) {
            try {
                const materialized = materializeStandingOrderForInspection(effective, groups, roleMap);
                if (typeof materialized.instruction === 'string'
                    && materialized.instruction !== effective.instruction) {
                    base.effectiveInstruction = materialized.instruction;
                }
            } catch { /* inspection degrades to the stored text */ }
        }
        return base;
    });

    let coreOrders: Array<StandingOrder & { core: true }> = [];
    try {
        coreOrders = await listCoreStandingOrders(groups, roleMap, db);
    } catch (err) {
        console.warn('[teamWiring] core standing-order inspection failed:', err);
    }

    return { orders, definitions, coreOrders };
}

/**
 * The terminal name recorded against a plan, or `''` when what is recorded is
 * not a terminal name. Pure and exported so both the API dispatch path
 * (`LocalApiServer._plausibleOriginTerminal`) and the drag path
 * (`TaskViewerProvider.handleKanbanTrigger`) apply the identical filter, and so
 * it is unit-testable on its own.
 *
 * `owner_seat` is only ever a real name (written by
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
    const terminal = String(record?.ownerSeat || '').trim();
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
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
    role: string;
    /** Live terminals: `{ name, role }`. Caller supplies the union of the pty fleet and the VS Code registry. */
    liveTerminals: Array<{ name: string; role?: string }>;
    /** Same normaliser the existing role resolvers use, injected to avoid a provider import. */
    normalizeRole: (r: string | undefined) => string;
}): Promise<string | null> {
    const { db, settings, originName, role, liveTerminals, normalizeRole } = opts;
    if ((!db && !settings) || !originName || !role) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        // Check legacy bare key if db present
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
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

/**
 * The roster of terminal names on the same registered team as `originName`
 * (the head itself plus its members), or null when `originName` names no
 * live team. Reads `terminals.groups` through the identical path
 * `resolveTeamScopedRoleTerminal` uses (same key, same legacy bare-key
 * merge, same head-id derivation, same `order`-then-`members` roster
 * preference) so the in-flight predicate in `dispatchNextFromQueue` derives
 * team membership from a card's `owner_seat` identically to
 * dispatch routing.
 *
 * Returns string rosters only — `wireSpawnedTeam` writes `members`/`order`
 * as arrays of terminal-name strings, so a spawned team always resolves
 * here. The gallery seed carries object members and is converted by
 * `migrateAgentGroups` at the read sites; this helper does not run that
 * converter (it is read-only and the caller is a membership oracle, not a
 * spawner), so a never-spawned gallery-only team may return null — which
 * is the correct answer for the in-flight check (no live team ⇒ no
 * in-flight refusal beyond the head-only fallback).
 */
export async function resolveTeamMembersForHead(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
}): Promise<string[] | null> {
    const { db, settings, originName } = opts;
    if ((!db && !settings) || !originName) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    // Preferred: the group the origin HEADS (same id derivation as
    // resolveTeamScopedRoleTerminal and wireSpawnedTeam).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    const headGroup = groups.find(g => g && g.id === headId);
    if (headGroup) {
        const roster = rosterOfGroup(headGroup);
        if (roster.length) { return roster; }
    }
    // Otherwise: first group (in stored order) that contains the origin.
    for (const g of groups) {
        if (!g) { continue; }
        const roster = rosterOfGroup(g);
        if (!roster.includes(originName)) { continue; }
        if (roster.length) { return roster; }
    }
    return null;
}

/**
 * Extract a roster of terminal-name strings from a registered group.
 *
 * Prefers `order`, falls back to `members`. Member entries may be either
 * plain name strings (the shape `wireSpawnedTeam` persists) OR objects
 * carrying a `friendlyName`/`name` field (the gallery seed shape, before
 * `migrateAgentGroups` converts them on its own read sites). Object members
 * are resolved to their `friendlyName` (then `name`) — NOT dropped — so a
 * roster that parsed but contained objects is not silently emptied.
 *
 * Dropping object members was the change-4 defect: `terminalsShareTeam` would
 * see an empty roster for an object-member group, fall through to
 * `roster.has(a) && roster.has(b)` === false, and return `false` — the
 * OPPOSITE of its own conservative `return true` direction on uncertainty,
 * silently disabling reviewer delegation. Resolving the names instead yields
 * the same answer the equivalent string roster would.
 *
 * Pure and exported so the roster-resolution contract is unit-testable
 * without driving the UI (change 8).
 */
export function rosterOfGroup(g: any): string[] {
    const roster: any[] = Array.isArray(g?.order) && g.order.length
        ? g.order
        : (Array.isArray(g?.members) ? g.members : []);
    const names: string[] = [];
    for (const n of roster) {
        if (typeof n === 'string') {
            if (n.length > 0) { names.push(n); }
            continue;
        }
        if (n && typeof n === 'object') {
            const resolved = typeof n.friendlyName === 'string' ? n.friendlyName
                : (typeof n.name === 'string' ? n.name : '');
            if (resolved.length > 0) { names.push(resolved); }
        }
    }
    return names;
}

/**
 * Check whether two terminals share any registered team.
 *
 * Reads `terminals.groups` with the same bare-key merge as
 * `resolveTeamMembersForHead`, extracts rosters consistently via
 * {@link rosterOfGroup} (prefers `order`, falls back to `members`, resolves
 * object members to their `friendlyName`), and returns true if ANY group
 * contains both `a` and `b`.
 *
 * Returns `true` (do NOT drop) when data is unavailable, reads fail, or no
 * groups exist — the conservative direction. The caller drops `originLead`
 * only when this returns `false`, i.e. there IS team data and the two
 * terminals are provably on no shared team.
 *
 * Use this instead of `resolveTeamMembersForHead` for cross-team membership
 * predicates: `resolveTeamMembersForHead` returns only one roster (the group
 * the origin heads, or the first containing it), which is insufficient for a
 * shared reviewer on multiple teams.
 */
export async function terminalsShareTeam(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    a: string;
    b: string;
}): Promise<boolean> {
    const { db, settings, a, b } = opts;
    if ((!db && !settings) || !a || !b || a === b) { return true; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return true; }
    if (!Array.isArray(groups) || groups.length === 0) { return true; }

    for (const g of groups) {
        const roster = new Set(rosterOfGroup(g));
        if (roster.has(a) && roster.has(b)) { return true; }
    }
    return false;
}

/**
 * Resolve the head (lead) terminal of the team a given terminal belongs to.
 *
 * Reads the SAME merged group set as {@link terminalsShareTeam} and
 * {@link resolveTeamMembersForHead}. For each group whose roster (resolved via
 * {@link rosterOfGroup}) contains `terminal`, returns the group's `head` field
 * (the live head seat name `wireSpawnedTeam` stamps). The first matching group
 * in stored order wins; a group with no `head` field is skipped (a head-less
 * row cannot delegate). Returns `null` when the terminal is on no registered
 * team, the data is unavailable, or no containing group carries a `head`.
 *
 * This is the reviewer-callback fix: when a cross-team guard drops an
 * `originLead` (the card's last dispatch target is on another team), the
 * reviewer still needs a lead to delegate to. Resolving the reviewer's OWN
 * lead — the head of the team the reviewer is a member of — keeps delegation
 * live for a shared reviewer with a same-team coder, instead of falling back
 * to fix-it-yourself.
 */
export async function resolveHeadForTerminal(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    terminal: string;
}): Promise<string | null> {
    const { db, settings, terminal } = opts;
    if ((!db && !settings) || !terminal) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    for (const g of groups) {
        if (!g) { continue; }
        const roster = rosterOfGroup(g);
        if (!roster.includes(terminal)) { continue; }
        const head = typeof g.head === 'string' && g.head.length > 0 ? g.head : '';
        if (head && head !== terminal) { return head; }
    }
    return null;
}

/**
 * Read the live registered groups (`switchboard.prompts.terminals.groups`
 * merged with the legacy `terminals.groups` bare key) and return a map from
 * each live group's identity link to its live `head` seat name.
 *
 * The map is keyed on BOTH the live group's `definitionId` (the
 * `terminals.agentGroups` row id it was spawned from) AND its `id`
 * (the deterministic `team_<headName>` group id), so a caller serving
 * team definitions can attach the live `head` to each definition row by
 * either link. Two teams sharing a `headRole` are then distinguishable on
 * the wire by their live head seat name, not by claim order alone.
 *
 * Returns an empty map when the data is unavailable or no live groups
 * carry a `head` — the caller leaves the definition's `head` unset, which
 * is the pre-change shape (no `head` key). Never throws.
 */
export async function resolveLiveGroupHeads(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
}): Promise<Map<string, string>> {
    const { db, settings } = opts;
    const out = new Map<string, string>();
    if (!db && !settings) { return out; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return out; }
    if (!Array.isArray(groups) || groups.length === 0) { return out; }

    for (const g of groups) {
        if (!g) { continue; }
        const head = typeof g.head === 'string' && g.head.length > 0 ? g.head : '';
        if (!head) { continue; }
        if (typeof g.definitionId === 'string' && g.definitionId.length > 0) {
            out.set(g.definitionId, head);
        }
        if (typeof g.id === 'string' && g.id.length > 0) {
            out.set(g.id, head);
        }
    }
    return out;
}

/**
 * Resolve the `pacing` field of the team headed by `originName`: `'seat'` when
 * the team is toggled to seat-paced dispatch, `'head'` otherwise. Reads the
 * SAME team group `resolveTeamMembersForHead` resolves (preferred: the group
 * the origin HEADS; otherwise the first group containing the origin), so the
 * pacing decision and the roster derive from one definition. Subtask 3 writes
 * the `pacing` field on the group; absent / non-`'seat'` reads as `'head'`,
 * which is byte-for-byte the pre-seat-pacing behaviour (the regression gate for
 * ~4,000 installs). Returns `'head'` when the head names no live team or the
 * field is absent — never null — so callers can use it as a defaulting oracle.
 */
export async function resolveTeamPacingForHead(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
}): Promise<'head' | 'seat'> {
    const { db, settings, originName } = opts;
    if ((!db && !settings) || !originName) { return 'head'; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return 'head'; }
    if (!Array.isArray(groups) || groups.length === 0) { return 'head'; }

    // Preferred: the group the origin HEADS (same id derivation as
    // resolveTeamMembersForHead / resolveTeamScopedRoleTerminal).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    let group: any = groups.find(g => g && g.id === headId);
    // Otherwise: first group (in stored order) that contains the origin.
    if (!group) {
        group = groups.find(g => g && Array.isArray(g.members) && g.members.includes(originName));
    }
    if (!group) { return 'head'; }
    return group.pacing === 'seat' ? 'seat' : 'head';
}

/**
 * Rewrite the `head` field on any `terminals.groups` row whose `head`
 * matches `oldName` — the group-record half of a terminal rename. Called
 * alongside `rewriteStandingOrdersForRename` (standingOrders.ts) so a
 * renamed head terminal's group record stays consistent with its standing
 * orders. The group `id` stays as-minted — it is an identity, not a
 * display name, and re-keying it would orphan every team-scoped standing
 * order (keyed `(scope, teamId)`).
 *
 * Uses `mutateTerminalGroups` (the serialized read-modify-write chain) so
 * a concurrent spawn cannot drop this rewrite. Preserves every unknown
 * key via the `...g` spread in the transform — only `head` is touched.
 */
export async function rewriteTeamGroupHeadForRename(
    db: any,
    oldName: string,
    newName: string
): Promise<void> {
    if (!db || !oldName || !newName || oldName === newName) { return; }
    try {
        await mutateTerminalGroups({ db }, (current) => {
            let changed = false;
            const next = current.map((g: any) => {
                if (g && typeof g === 'object' && g.head === oldName) {
                    changed = true;
                    return { ...g, head: newName };
                }
                return g;
            });
            return changed ? next : current;
        });
    } catch (err: any) {
        console.warn(`[teamWiring] rewriteTeamGroupHeadForRename failed:`, err?.message || err);
    }
}
