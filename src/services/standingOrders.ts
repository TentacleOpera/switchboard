import * as crypto from 'crypto';
import {
    composeStandingOrderFragments,
    getStandingOrderFragment,
    STANDING_ORDER_FRAGMENT_IDS,
    StandingOrderCompositionContext,
} from './standingOrderFragments';
import { substituteCliPath } from '../utils/cliPathToken';

export type StandingOrderScope = 'global' | 'team' | 'pair' | 'team-head' | 'role';

export interface StandingOrder {
    id: string;
    parent: string;
    child?: string;
    instruction?: string;
    fragments?: string[];
    createdAt: number;
    scope?: StandingOrderScope;
    teamId?: string;
    /** The role name this order applies to (e.g. 'planner', 'coder', 'reviewer', 'lead'). Used only when `scope === 'role'`. */
    role?: string;
    /**
     * Optional link to a {@link StandingOrderDefinition} in the definitions
     * library. When present, the `instruction` field is a denormalized copy
     * kept in sync by {@link syncDefinitionToAssignments} (eager, on
     * definition edit) and {@link reSyncAssignmentsToDefinitions} (lazy, on
     * read). Old builds that don't know about `definitionId` see the
     * `instruction` copy and work as before.
     */
    definitionId?: string;
}

/**
 * A reusable standing-order definition — the library entry. The
 * `instruction` is the canonical text; each {@link StandingOrder} that
 * references it via `definitionId` carries a denormalized copy of that
 * text, synced when the definition is edited. Stored at
 * {@link STANDING_ORDER_DEFINITIONS_CONFIG_KEY}.
 */
export interface StandingOrderDefinition {
    id: string;
    name: string;
    instruction: string;
    createdAt: number;
    fragmentId?: string;
}

export const STANDING_ORDERS_CONFIG_KEY = 'terminals.standingOrders';
export const STANDING_ORDER_DEFINITIONS_CONFIG_KEY = 'terminals.standingOrderDefinitions';
export const STANDING_ORDERS_MARKER = '=== STANDING ORDERS ===';

/**
 * Regex matching a COMPLETE standing-orders block — the marker, its body, and
 * the trailing `These apply to everything you do in this terminal until told
 * otherwise.` line — so a pre-existing appended block can be stripped before
 * appending a fresh one. Anchoring on the trailing line (not just the marker)
 * prevents a prompt that merely QUOTES the marker mid-text from being silently
 * truncated from that point to end-of-string. The block is always appended at
 * the end of a prompt, so matching to end-of-string after the trailing line is
 * correct. Leading newlines before the marker are consumed so the stripped
 * prompt does not gain a trailing blank line.
 */
const STANDING_ORDERS_BLOCK_RE =
    /\n*=== STANDING ORDERS ===\n[\s\S]*?These apply to everything you do in this terminal until told otherwise\.\n$/;

/**
 * Registered terminal groups (`terminals.groups` config key). Each group is
 * `{ id, name, members: string[], ... }` — `wireSpawnedTeam` writes one per
 * started team. The `team` scope resolves membership through this array.
 */
export type TerminalGroup = { id: string; name: string; members: string[]; [k: string]: any };

let _writeChain: Promise<unknown> = Promise.resolve();

/**
 * Run a read-mutate-write of the standing-orders config key through a
 * module-level promise chain. Concurrent add/delete/rename calls serialize,
 * so they cannot clobber each other.
 */
export async function mutateStandingOrders(
    db: any,
    mutator: (orders: StandingOrder[]) => Promise<StandingOrder[]>
): Promise<void> {
    const p = _writeChain.then(async () => {
        // `db` is host-agnostic (`any`), so the generic goes on the result, not the call.
        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];
        const next = await mutator(orders);
        await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, next);
    });
    _writeChain = p.catch(() => {});
    await p;
}

/**
 * Run a read-mutate-write of the standing-order-DEFINITIONS config key
 * through the SAME module-level promise chain as
 * {@link mutateStandingOrders}. Concurrent definition edits and assignment
 * syncs serialize, so they cannot clobber each other — but the two
 * config keys are written in separate read-mutate-write cycles, so a
 * crash between a definition write and the subsequent assignment sync is
 * NOT atomic. The lazy re-sync
 * ({@link reSyncAssignmentsToDefinitions}) is the recovery path.
 */
export async function mutateStandingOrderDefinitions(
    db: any,
    mutator: (defs: StandingOrderDefinition[]) => Promise<StandingOrderDefinition[]>
): Promise<void> {
    const p = _writeChain.then(async () => {
        const defs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
        const next = await mutator(defs);
        if (next !== defs) {
            await db.setConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, next);
        }
    });
    _writeChain = p.catch(() => {});
    await p;
}

/**
 * Eager sync: update the `instruction` field on every assignment whose
 * `definitionId` matches `definitionId`. Called immediately after a
 * definition's instruction is edited. The two writes (definition +
 * assignments) serialize through the shared {@link _writeChain} but are
 * not atomic — {@link reSyncAssignmentsToDefinitions} is the crash
 * recovery path.
 */
export async function syncDefinitionToAssignments(
    db: any,
    definitionId: string,
    instruction: string
): Promise<void> {
    await mutateStandingOrders(db, async (orders) => {
        let changed = false;
        const next = orders.map(o => {
            if (!o || o.definitionId !== definitionId) { return o; }
            if (o.instruction === instruction) { return o; }
            changed = true;
            return { ...o, instruction };
        });
        return changed ? next : orders;
    });
}

/**
 * Lazy re-sync (crash recovery): a PURE function that, for each order
 * with a `definitionId`, checks if its `instruction` matches the
 * definition's `instruction`. If not, updates the order's `instruction`.
 * Returns the corrected array, or the INPUT array BY REFERENCE when
 * nothing changed — the same identity-check pattern as
 * {@link migrateTeamPairOrders}, so the caller can avoid a write on every
 * prompt. Called lazily in `loadEffectiveStandingOrders`.
 *
 * When a definition has been deleted (no match in `definitions`), the
 * order's `instruction` copy is left as-is — the order still works, it
 * just no longer tracks a definition.
 */
export function reSyncAssignmentsToDefinitions(
    definitions: StandingOrderDefinition[],
    orders: StandingOrder[]
): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    if (!Array.isArray(definitions) || definitions.length === 0) { return orders; }
    const byId = new Map<string, StandingOrderDefinition>();
    for (const d of definitions) {
        if (d && d.id) { byId.set(d.id, d); }
    }
    let changed = false;
    const next = orders.map(o => {
        if (!o || !o.definitionId) { return o; }
        const def = byId.get(o.definitionId);
        if (!def) { return o; }
        if (o.instruction === def.instruction) { return o; }
        changed = true;
        return { ...o, instruction: def.instruction };
    });
    return changed ? next : orders;
}

/**
 * Assemble a new standing-order definition after client-side validation.
 */
export function makeStandingOrderDefinition(
    name: string,
    instruction: string,
    createdAt?: number,
    fragmentId?: string
): StandingOrderDefinition {
    return {
        id: crypto.randomUUID(),
        name,
        instruction,
        createdAt: createdAt || Date.now(),
        ...(fragmentId ? { fragmentId } : {}),
    };
}

export function resolveStandingOrderDefinitionInstruction(
    definition: StandingOrderDefinition,
    ctx: StandingOrderCompositionContext
): string {
    if (!definition.fragmentId) { return definition.instruction; }
    return composeStandingOrderFragments([definition.fragmentId], ctx).text;
}

/**
 * Idempotently ensure a definition exists for `instruction` text. If a
 * definition with the same `instruction` already exists, return its id
 * (deduplication by instruction text). Otherwise create one and persist
 * it via {@link mutateStandingOrderDefinitions}. Returns the definition
 * id. Used by `wireSpawnedTeam` to create definitions for team/head
 * prompts without duplicating on re-spawn.
 */
export async function ensureStandingOrderDefinition(
    db: any,
    instruction: string,
    name?: string,
    createdAt?: number
): Promise<string> {
    let resultId: string | undefined;
    await mutateStandingOrderDefinitions(db, async (defs) => {
        const existing = defs.find(d => d && d.instruction === instruction);
        if (existing) {
            resultId = existing.id;
            return defs;
        }
        const def = makeStandingOrderDefinition(
            name || instruction.slice(0, 60),
            instruction,
            createdAt
        );
        resultId = def.id;
        return [...defs, def];
    });
    return resultId!;
}

/** Replace parent and child names that match the renamed terminal. */
export async function rewriteStandingOrdersForRename(db: any, oldName: string, newName: string): Promise<void> {
    await mutateStandingOrders(db, async (orders) => {
        let changed = false;
        const next = orders.map(o => {
            if (o.parent === oldName) { changed = true; return { ...o, parent: newName }; }
            if (o.child === oldName) { changed = true; return { ...o, child: newName }; }
            return o;
        });
        if (!changed) { return orders; }
        return next;
    });
}

/** Resolve the scope of an order, defaulting absent scope to `pair` (shipped-state compat). */
function scopeOf(o: StandingOrder): StandingOrderScope {
    return o.scope || 'pair';
}

/**
 * Team standing of a seat, sourced from the registered team rosters
 * (`terminals.groups`) — NOT from persisted `team`/`team-head` order rows.
 * System orders are composed at delivery ({@link selectOrders}) and never
 * persisted, so the rows are gone; a team has its protocol because it is a
 * team (a spawned group claims the seat), not because a row was once written
 * for its head's name. Returns `inTeam: false` when no live spawned team
 * claims the seat — never a guess.
 *
 * `isSpawnedTeamGroup` (teamWiring.ts) is the team/non-team split — a
 * hand-saved Link-up pair group is NOT a team and must not receive team
 * protocol fragments. Inlined here to avoid a circular import
 * (teamWiring.ts imports from this module); the canonical helper stays the
 * single source every other consumer reads through.
 *
 * `members` is the resolved group's `members` array VERBATIM — head included,
 * flat, in stored order. `[]` when `inTeam` is false. Returned because the
 * head's commit trailers need its members' plan ids
 * (`lead-dispatched-commits-carry-no-stage-trailers.md`) and that plan must
 * NOT re-resolve the group: re-deriving the roster from `teamId` is impossible
 * (the id is a lossy slug of the head name) and re-deriving it from `groups`
 * is the second membership test this helper exists to prevent. One
 * resolution, one roster, two consumers.
 *
 * A seat that is both a head of one team and a member of another resolves as
 * **head**, and `members` is the roster of the team it *heads* — a head's
 * commit authority wins, because it is the seat other agents are reporting
 * to, and the plan ids it must carry are its own team's.
 *
 * The `orders` parameter is retained in the signature to avoid a wide
 * call-site change; team resolution no longer reads it.
 */
export function resolveTeamStanding(
    targetName: string,
    orders: StandingOrder[],
    groups: TerminalGroup[]
): {
    inTeam: boolean;
    isHead: boolean;
    teamId?: string;
    headName?: string;
    members: string[];
} {
    void orders;
    const isSpawnedTeam = (g: any): boolean => {
        if (!g || typeof g !== 'object') { return false; }
        if (g.teamKind === 'spawned') { return true; }
        return g.teamGroup === true
            && typeof g.id === 'string'
            && g.id.startsWith('team_');
    };
    // Head-first: a seat that heads any spawned team resolves as head, and
    // its team's roster is what the commit-trailer plan needs. The declared
    // head is `g.head` (stamped at spawn by `wireSpawnedTeam`), falling back
    // to `g.name` — never inferred from `members[0]`, which diverges when an
    // operator reorders.
    for (const g of groups) {
        if (!isSpawnedTeam(g) || !Array.isArray(g.members)) { continue; }
        const head = (typeof g.head === 'string' && g.head.length > 0)
            ? g.head
            : (typeof g.name === 'string' ? g.name : '');
        if (head && targetName === head && g.members.includes(targetName)) {
            return { inTeam: true, isHead: true, teamId: g.id, headName: head, members: g.members };
        }
    }
    // Not a head — check if the target is a non-head member of a spawned
    // team. The head exclusion (`head && targetName === head`) mirrors the
    // `team` branch in {@link selectOrders}, so the two cannot diverge on
    // who is a member vs a head.
    for (const g of groups) {
        if (!isSpawnedTeam(g) || !Array.isArray(g.members)) { continue; }
        const head = (typeof g.head === 'string' && g.head.length > 0)
            ? g.head
            : (typeof g.name === 'string' ? g.name : '');
        if (head && targetName === head) { continue; } // head exclusion
        if (g.members.includes(targetName)) {
            return { inTeam: true, isHead: false, teamId: g.id, headName: head || undefined, members: g.members };
        }
    }
    return { inTeam: false, isHead: false, members: [] };
}

/**
 * Resolve whether a team has registered rounds — the gate that switches a lead
 * head's standing orders from the hand-dispatch loop to the register/mark-done
 * loop (Coding Rounds feature). Reads the `coding_rounds` table DIRECTLY via
 * `db.getCodingRoundsByTeam(teamId)` — never inferred from dispatched-card
 * counts (a team with three dispatched cards and no registered rounds must
 * NOT behave as if it had rounds). Returns `false` on any missing input (no
 * db, no teamId, no resolver, a thrown read) — the safe default that keeps
 * the legacy dispatch + `done --from` pop instructions, so an unresolved team
 * is indistinguishable from a team that never registered rounds rather than
 * silently losing its dispatch instructions.
 */
export async function resolveHasRegisteredRounds(
    db: any,
    teamId: string | undefined | null
): Promise<boolean> {
    if (!db || !teamId) { return false; }
    try {
        const rounds = typeof db.getCodingRoundsByTeam === 'function'
            ? await db.getCodingRoundsByTeam(teamId)
            : undefined;
        return Array.isArray(rounds) && rounds.length > 0;
    } catch (err) {
        console.warn('[standingOrders] resolveHasRegisteredRounds failed:', err);
        return false;
    }
}

/**
 * Resolve whether the team `targetName` heads has registered rounds. Composes
 * {@link resolveTeamStanding} (same predicate `selectOrders` uses, so the
 * gate and the delivery layer cannot disagree on who is a head) with
 * {@link resolveHasRegisteredRounds}. Returns `false` when the target is not a
 * team head — the flag is only meaningful for lead heads, and a non-head
 * resolving `false` keeps its fragments untouched.
 */
export async function resolveHasRegisteredRoundsForSeat(
    db: any,
    targetName: string,
    orders: StandingOrder[],
    groups: TerminalGroup[]
): Promise<boolean> {
    const standing = resolveTeamStanding(targetName, orders, groups);
    if (!standing.inTeam || !standing.isHead || !standing.teamId) { return false; }
    return resolveHasRegisteredRounds(db, standing.teamId);
}

/**
 * Select the orders that apply to `targetName` given the registered groups and
 * the live terminal set.
 *
 * - `global`: always applies. No liveness gate — a global note must not vanish
 *   because some unrelated terminal exited.
 * - `team`: applies when `targetName` is a member of the group whose `id ===
 *   o.teamId`. A team order whose `teamId` matches no registered group renders
 *   for nobody rather than for everybody. No liveness gate. The head is
 *   excluded even though it is in the group's `members` array — the team
 *   prompt is for members only, and the head name is stored in `o.parent`.
 * - `team-head`: the complement of `team` — applies ONLY when `targetName ===
 *   o.parent` and that name is in the group's `members` array. This is the
 *   head-facing half of a team's prompt pair: `team` reaches members (head
 *   excluded), `team-head` reaches the head (members excluded). `o.child` is
 *   deliberately `''` so that an older build with no `team-head` branch falls
 *   through to the `pair` rule and evaluates `liveNames.has('')` → false,
 *   dropping the order instead of mis-delivering it to the wrong terminal.
 * - `role`: applies when the target terminal's role matches `o.role`. The
 *   target's role is resolved from `roleMap` (terminal name → role), passed
 *   by the caller from the terminal registry. When `roleMap` is absent
 *   (headless/test harness), role-scoped orders are skipped — no regression.
 * - `pair` (default): applies when `o.parent === targetName` and `o.child` is
 *   live. A note about a dead terminal is noise.
 */
function selectOrders(
    orders: StandingOrder[],
    targetName: string,
    liveNames: Set<string>,
    groups: TerminalGroup[],
    roleMap?: Map<string, string>
): { orders: StandingOrder[]; standing: ReturnType<typeof resolveTeamStanding> } {
    // Resolve the target's team standing once via the shared predicate, so
    // the delivery layer and this selector cannot diverge on what "is a
    // non-head team member" means.
    const standing = resolveTeamStanding(targetName, orders, groups);

    // System orders are composed at delivery from the canonical fragment
    // lists — never persisted. A team has its protocol because it is a team
    // (standing.inTeam), not because a row was once written for its head's
    // name. The synthetic orders carry `parent = headName` and `teamId =
    // group.id` so they flow through the SAME scope-selection branches
    // below as a persisted row would (head-exclusion for `team`, head-match
    // for `team-head`). Built per delivery from STANDING_ORDER_FRAGMENT_IDS
    // and the live composition context, so a fragment-body edit in src/ is
    // live on the next prompt for every team, including teams started
    // months ago. The fragment `applies` gates self-filter (e.g.
    // memberCompletion fires only for non-external heads, externalMemberCallback
    // only for external heads), so the union member list is safe for both.
    const synthetic: StandingOrder[] = [];
    if (standing.inTeam && standing.teamId && standing.headName) {
        if (standing.isHead) {
            synthetic.push({
                id: `synthetic-team-head:${standing.teamId}`,
                parent: standing.headName,
                child: '',
                fragments: [
                    STANDING_ORDER_FRAGMENT_IDS.codingHead,
                    STANDING_ORDER_FRAGMENT_IDS.reviewHead,
                    STANDING_ORDER_FRAGMENT_IDS.headCommit,
                    STANDING_ORDER_FRAGMENT_IDS.headCompletion,
                    STANDING_ORDER_FRAGMENT_IDS.headNext,
                    // orchestratorReport removed: it was gated on
                    // orchestratorPresent (always false in production) and
                    // told the head to write to .switchboard/mission-control/
                    // reports/ — a directory the host no longer writes and
                    // no reader could reach. The host now records turn-ends
                    // as plan_events rows unconditionally (plan 171). The
                    // fragment ID stays recognized in standingOrderFragments.ts
                    // so persisted rows referencing it resolve cleanly.
                    STANDING_ORDER_FRAGMENT_IDS.subagentPolicy,
                ],
                createdAt: 0,
                scope: 'team-head',
                teamId: standing.teamId,
            });
        } else {
            synthetic.push({
                id: `synthetic-team:${standing.teamId}`,
                parent: standing.headName,
                child: '',
                fragments: [
                    STANDING_ORDER_FRAGMENT_IDS.memberCompletion,
                    STANDING_ORDER_FRAGMENT_IDS.memberWork,
                    STANDING_ORDER_FRAGMENT_IDS.externalMemberCallback,
                    STANDING_ORDER_FRAGMENT_IDS.gitSafety,
                    STANDING_ORDER_FRAGMENT_IDS.subagentPolicy,
                ],
                createdAt: 0,
                scope: 'team',
                teamId: standing.teamId,
            });
        }
    }
    // System orders FIRST, persisted rows after. The operator's text adds to the
    // protocol, so the protocol has to be the thing it is added to — a head whose
    // definition carries a `headPrompt` would otherwise read the operator's
    // instructions before the contract they modify.
    //
    // This is the same rule `resolveStandingOrderInstruction` applies WITHIN a
    // row (fragments, then the body); appending synthetic orders last applied the
    // opposite rule BETWEEN rows, and the two levels disagreed. The head case is
    // the one that exposes it, because a head's operator text lives on a separate
    // persisted row from its system fragments, while a member's system half has no
    // persisted row to be ordered against.
    const pool = synthetic.length > 0 ? [...synthetic, ...orders] : orders;

    const selected = pool.filter(o => {
        const scope = scopeOf(o);
        if (scope === 'global') {
            return true;
        }
        if (scope === 'role') {
            // An order with no `role` field is malformed — skip it rather
            // than mis-delivering to every terminal. When `roleMap` is
            // absent (headless/test harness), role-scoped orders are skipped
            // gracefully — no regression on existing call sites.
            if (!o.role) { return false; }
            if (!roleMap) { return false; }
            const targetRole = roleMap.get(targetName);
            return !!targetRole && targetRole === o.role;
        }
        if (scope === 'team') {
            if (!o.teamId) { return false; }
            const group = groups.find(g => g && g.id === o.teamId);
            if (!group || !Array.isArray(group.members)) { return false; }
            // Exclude the head — the team prompt is for members only. The
            // head name is stored in `o.parent` by wireSpawnedTeam.
            if (o.parent && targetName === o.parent) { return false; }
            return group.members.includes(targetName)
                && standing.inTeam && !standing.isHead && o.teamId === standing.teamId;
        }
        if (scope === 'team-head') {
            // The mirror image of `team`: this order is FOR the head and nobody
            // else. `o.parent` holds the head name (same field `team` uses for
            // its exclusion check), and `o.child` is deliberately '' so that an
            // older build — which has no case for this scope and falls through
            // to the pair rule — evaluates `liveNames.has('')` and drops the
            // order instead of mis-delivering it.
            if (!o.teamId) { return false; }
            const group = groups.find(g => g && g.id === o.teamId);
            if (!group || !Array.isArray(group.members)) { return false; }
            return !!o.parent && targetName === o.parent && group.members.includes(targetName)
                && standing.isHead && o.teamId === standing.teamId;
        }
        // pair (default)
        return o.parent === targetName && o.child !== undefined && liveNames.has(o.child);
    });
    return { orders: selected, standing };
}

export interface StandingOrderRenderOptions {
    orchestratorPresent?: boolean;
    attended?: boolean;
    /**
     * The seat's resolved subagent policy, threaded from
     * `KanbanProvider.resolveSeatPromptOptions` so the subagent-policy standing
     * order fragment composes the canonical directive into the standing-orders
     * block on the same delivery channel as git safety. Absent → `'default'`
     * → the fragment emits nothing (a seat with no policy set gains no order).
     */
    subagentPolicy?: 'noSubagents' | 'useSubagents' | 'customSubagent' | 'default';
    customSubagentName?: string;
    /**
     * True when the target's team has at least one row in `coding_rounds`.
     * Resolved live by the composition-root delivery seams (the prompt-append
     * paths and the standing-orders applier in BOTH hosts) via
     * {@link resolveHasRegisteredRounds} — never inferred from card counts.
     * Absent → false (the safe default: a team whose rounds could not be
     * resolved keeps the legacy dispatch + `done --from` pop instructions
     * rather than silently dropping them). Only the lead-head fragments
     * consult it.
     */
    hasRegisteredRounds?: boolean;
}

function compositionContext(
    targetName: string,
    standing: ReturnType<typeof resolveTeamStanding>,
    groups: TerminalGroup[],
    roleMap?: Map<string, string>,
    options: StandingOrderRenderOptions = {}
): StandingOrderCompositionContext {
    const group = standing.teamId ? groups.find(g => g && g.id === standing.teamId) : undefined;
    const headName = standing.headName || (typeof group?.head === 'string' ? group.head : '') || (typeof group?.name === 'string' ? group.name : '');
    const headRole = (typeof group?.headRole === 'string' && group.headRole) || (headName ? roleMap?.get(headName) : '') || '';
    return {
        targetName,
        inTeam: standing.inTeam,
        isHead: standing.isHead,
        teamId: standing.teamId || '',
        headName,
        headRole,
        members: standing.members,
        reviewerSeat: standing.members.some(name => roleMap?.get(name) === 'reviewer'),
        workKind: headRole === 'planner' ? 'plan' : 'feature',
        pacing: group?.pacing === 'seat' ? 'seat' : 'head',
        orchestratorPresent: options.orchestratorPresent === true,
        attended: options.attended !== false,
        externalHead: group?.externalHead === true,
        subagentPolicy: options.subagentPolicy,
        customSubagentName: options.customSubagentName,
        hasRegisteredRounds: options.hasRegisteredRounds === true,
    };
}

/**
 * The completion-protocol handshake as a standing order. Tells the agent to
 * run `switchboard done --from` when ALL work is complete. Stored with
 * `${terminalName}` and `${cliPath}` placeholders, interpolated at delivery
 * time with the terminal's own name — no "check this txt file" and no
 * "<your terminal name>" placeholder.
 *
 * This replaced the prompt-injected CODING_COMPLETION_REPORT_DIRECTIVE. Copy-
 * prompt buttons produce clean prompts without this directive; the standing
 * order delivers it only to terminals connected to Switchboard.
 *
 * Uses the CLI form (`switchboard done --from`), NOT the old
 * `POST /kanban/queue/done` form — the CLI resolves the port itself, so no
 * `${port}` interpolation is needed for this order.
 */
export const COMPLETION_DIRECTIVE_ORDER_INSTRUCTION = `COMPLETION REPORT: When you have finished implementing ALL parts of the plan, run \`\${cliPath} done --from "\${terminalName}"\` (or \`switchboard done --from "\${terminalName}"\`). This signals task completion to the kanban board — the system clears your card's activity light and notifies your lead. Do NOT report after finishing individual parts — only when ALL work is complete. Also append a brief summary (3-5 sentences) to the END of the original plan file for the record. Do NOT skip the completion report.`;

const COMPLETION_DIRECTIVE_ORDER_ID_PREFIX = 'completion-directive:role:';

/**
 * Install (or update) the completion-directive standing order for a role.
 * Called when a terminal is created or a role is assigned, and during upgrade
 * migration. Idempotent — uses a deterministic ID so re-installation replaces,
 * not duplicates. The order text carries `${terminalName}` and `${cliPath}`
 * placeholders interpolated at delivery time, so no terminal name is needed
 * at install time. Installs once per role (not per terminal) — `parent` is
 * `''` because a role-scoped order applies to all terminals with that role.
 */
export async function installCompletionDirectiveOrder(
    db: any,
    role: string
): Promise<void> {
    const id = COMPLETION_DIRECTIVE_ORDER_ID_PREFIX + role;
    const instruction = COMPLETION_DIRECTIVE_ORDER_INSTRUCTION;
    await mutateStandingOrders(db, async (orders) => {
        const filtered = orders.filter(o => o.id !== id);
        filtered.push({
            id,
            parent: '',
            child: '',
            instruction,
            createdAt: Date.now(),
            scope: 'role',
            role,
        });
        return filtered;
    });
}

/** Coding roles that receive the completion-directive standing order. */
export const COMPLETION_DIRECTIVE_ROLES = ['coder', 'intern', 'lead', 'reviewer'];

export function resolveStandingOrderInstruction(o: StandingOrder, ctx: StandingOrderCompositionContext): string {
    // A body ADDS to the fragments; it never replaces them. Compose fragments
    // first, then append the operator-authored `instruction` after them. A
    // row carrying only a body renders only that body — correct, because the
    // system half no longer lives on rows at all (it is composed at delivery
    // by selectOrders). A row carrying only fragments renders only fragments.
    const parts: string[] = [];
    if (Array.isArray(o.fragments) && o.fragments.length > 0) {
        const composed = composeStandingOrderFragments(o.fragments, ctx);
        if (composed.unknown.length) {
            console.warn(`[standingOrders] Unknown fragment id(s) on order '${o.id}': ${composed.unknown.join(', ')}`);
        }
        if (composed.text) { parts.push(composed.text); }
    }
    if (typeof o.instruction === 'string' && o.instruction.length > 0) { parts.push(o.instruction); }
    return parts.join('\n\n');
}

/**
 * Render a single order line. Only `pair` emits the `- Regarding terminal "X":`
 * framing; `global` and `team` render the instruction as a plain rule. Getting
 * this wrong produces the incoherent "Regarding terminal undefined" line this
 * refactor exists to remove.
 */
function renderOrder(o: StandingOrder, ctx: StandingOrderCompositionContext): string {
    const instruction = resolveStandingOrderInstruction(o, ctx);
    if (!instruction) { return ''; }
    const scope = scopeOf(o);
    if (scope === 'pair') {
        const child = o.child;
        if (!child) { return ''; }
        return `- Regarding terminal "${child}": ${instruction}\n`;
    }
    return `- ${instruction}\n`;
}

/** Strip a pre-existing standing-orders block from `prompt`. */
export function stripStandingOrdersBlock(prompt: string): string {
    return prompt.replace(STANDING_ORDERS_BLOCK_RE, '');
}

/**
 * Render a standalone standing-orders block (marker + rules + trailing line)
 * for the orders that apply to `targetName`. Returns `null` when no orders
 * apply — the caller should send no prompt in that case.
 *
 * This is the shared rendering core used by both `applyStandingOrders` (which
 * appends the block as a suffix on a prompt) and the establish/clear delivery
 * path (which sends the block as a standalone prompt via `ptySendPrompt`).
 * Extracting it avoids duplicating the selection + scope-rank + rendering
 * logic across the two consumers.
 *
 * The `roleMap` parameter (terminal name → role) is used to resolve
 * `role`-scoped orders. When absent, role-scoped orders are skipped.
 */
export interface StandingOrderInterpolationContext {
    /** The terminal's own name, interpolated into `${terminalName}` placeholders. */
    terminalName: string;
}

export function renderStandaloneOrdersBlock(
    orders: StandingOrder[],
    targetName: string,
    liveNames: Set<string>,
    groups: TerminalGroup[],
    roleMap?: Map<string, string>,
    options: StandingOrderRenderOptions = {},
    interpolationContext?: StandingOrderInterpolationContext
): string | null {
    const selected = selectOrders(orders, targetName, liveNames, groups, roleMap);
    if (selected.orders.length === 0) {
        return null;
    }
    const ctx = compositionContext(targetName, selected.standing, groups, roleMap, options);

    // Render safeguard-bearing scopes (global, role, team) before pair so that
    // whatever renders last is the least safety-critical. Truncation is gone,
    // so this is moot for correctness today — but deterministic order is
    // better than not, and a future re-introduction of a cap would eat the
    // right end. Stable sort preserves creation order within each scope.
    // `role` sits between `global` and `team`/`team-head` (both at rank 2) so
    // role-level instructions render after the global baseline but before the
    // team-specific prompt — a role order is broader than a team order but
    // narrower than a global one.
    const scopeRank: Record<StandingOrderScope, number> = { global: 0, role: 1, 'team-head': 2, team: 2, pair: 3 };
    const sorted = [...selected.orders].sort(
        (a, b) => scopeRank[scopeOf(a)] - scopeRank[scopeOf(b)]
    );
    // Interpolate ${terminalName} placeholders at delivery time. The completion
    // directive standing order stores the placeholder; it is replaced with the
    // actual terminal name here. Orders without placeholders are unchanged.
    const interpolated = interpolationContext
        ? sorted.map(o => ({
              ...o,
              instruction: typeof o.instruction === 'string'
                  ? o.instruction.replace(/\$\{terminalName\}/g, interpolationContext.terminalName)
                  : o.instruction,
          }))
        : sorted;
    const rendered = interpolated.map(o => renderOrder(o, ctx)).filter(Boolean);
    if (rendered.length === 0) { return null; }

    let block = `\n\n${STANDING_ORDERS_MARKER}\n`;
    for (const line of rendered) {
        block += line;
    }
    block += `These apply to everything you do in this terminal until told otherwise.\n`;
    // Emission seam: fragment text carries the `<cliPath>` token because the
    // fragments are module constants with byte-identical webview mirrors and
    // cannot interpolate. Unsubstituted, the agent is handed
    // `node "<cliPath>" done …` — a command that cannot run.
    return substituteCliPath(block);
}

/**
 * Idempotent. Returns `prompt` unchanged when there is nothing to add.
 *
 * The fifth parameter (`groups`) is the registered `terminals.groups` array,
 * used to resolve `team`-scoped order membership. It defaults to `[]` so
 * existing two-argument call sites that only have `pair` orders keep working.
 *
 * The sixth parameter (`roleMap`) is a terminal-name → role map used to
 * resolve `role`-scoped orders. It defaults to `undefined` so existing call
 * sites (and the test suite) keep working — role-scoped orders are simply
 * skipped when no map is provided.
 */
export function applyStandingOrders(
    prompt: string,
    targetName: string,
    orders: StandingOrder[],
    liveNames: Set<string>,
    groups: TerminalGroup[] = [],
    roleMap?: Map<string, string>,
    options: StandingOrderRenderOptions = {},
    interpolationContext?: StandingOrderInterpolationContext
): string {
    if (!prompt) { return prompt; }

    // Strip any pre-existing standing-orders block so a prompt that already
    // carries one (a lead quoting its own block to a coder, or a Shift-drop
    // paste the client mirror already blocked) does not end up with two blocks
    // or silently lose the target's own orders. The marker is the
    // cross-boundary de-duplication token; strip + re-append preserves the
    // "one block per prompt" invariant the old bail-on-marker guard enforced,
    // without dropping the target's orders when the incoming text happens to
    // contain the marker.
    const cleanPrompt = stripStandingOrdersBlock(prompt);

    const block = renderStandaloneOrdersBlock(orders, targetName, liveNames, groups, roleMap, options, interpolationContext);
    if (block === null) {
        if (groups.some(g => Array.isArray(g?.members) && g.members.includes(targetName))) {
            const rejected = orders.map(o => ({
                parent: o.parent,
                child: o.child,
                scope: scopeOf(o),
            }));
            console.warn(
                `[standingOrders] Target "${targetName}" is a member of a registered team group, but matched 0 of ${orders.length} standing orders. Rejected orders:`,
                rejected
            );
        }
        return substituteCliPath(cleanPrompt);
    }
    return substituteCliPath(cleanPrompt) + block;
}

/** Save-time validation. Returns an error string, or null when acceptable. */
export function validateInstruction(text: unknown): string | null {
    if (typeof text !== 'string' || !text.trim()) { return 'Instruction is required'; }
    if (text.includes(STANDING_ORDERS_MARKER)) { return 'Instruction may not contain the standing-orders marker'; }
    return null;
}

/** Assemble a new standing order after client-side validation. */
export function makeStandingOrder(
    parent: string,
    child: string,
    instruction: string,
    scope?: StandingOrderScope,
    teamId?: string,
    role?: string,
    definitionId?: string
): StandingOrder {
    return {
        id: crypto.randomUUID(),
        parent,
        child,
        instruction,
        createdAt: Date.now(),
        ...(scope ? { scope } : {}),
        ...(teamId ? { teamId } : {}),
        ...(role ? { role } : {}),
        ...(definitionId ? { definitionId } : {}),
    };
}

export function makeFragmentStandingOrder(
    parent: string,
    child: string,
    fragments: string[],
    scope: StandingOrderScope,
    teamId?: string,
    role?: string
): StandingOrder {
    const unknown = fragments.filter(id => !getStandingOrderFragment(id));
    if (unknown.length) { throw new Error(`Unknown standing-order fragment id(s): ${unknown.join(', ')}`); }
    return {
        id: crypto.randomUUID(),
        parent,
        child,
        fragments: [...fragments],
        createdAt: Date.now(),
        scope,
        ...(teamId ? { teamId } : {}),
        ...(role ? { role } : {}),
    };
}

export function materializeStandingOrderForInspection(
    order: StandingOrder,
    groups: TerminalGroup[],
    roleMap?: Map<string, string>,
    options: StandingOrderRenderOptions = {}
): StandingOrder {
    if (typeof order.instruction === 'string' || !order.fragments?.length) { return order; }
    const group = order.teamId ? groups.find(g => g && g.id === order.teamId) : undefined;
    const targetName = scopeOf(order) === 'team-head'
        ? order.parent
        : (scopeOf(order) === 'team'
            ? (group?.members || []).find((name: string) => name !== order.parent) || order.parent
            : order.parent);
    const standing = resolveTeamStanding(targetName, [order], groups);
    const ctx = compositionContext(targetName, standing, groups, roleMap, options);
    return { ...order, instruction: resolveStandingOrderInstruction(order, ctx) };
}

/**
 * Deterministic id prefix for the reviewer-callback override order installed
 * on a coder during delegation-mode review. The id is `review-callback:<coderName>`
 * so the order can be found and removed without scanning instruction text.
 */
const REVIEW_CALLBACK_ID_PREFIX = 'review-callback:';

/**
 * Install a pair-scoped standing order on `coderName` that redirects its
 * completion callback to `reviewerName` during a review-fix loop. The
 * coder's team-scoped "report to lead" order stays in place — this pair
 * order is more specific (names the reviewer explicitly) and is rendered
 * alongside the team order so the coder knows to report to the reviewer
 * for review-fix work.
 *
 * Idempotent: if an order with the same deterministic id already exists,
 * it is replaced (not duplicated).
 */
export async function installReviewerCallbackOrder(
    db: any,
    coderName: string,
    reviewerName: string
): Promise<void> {
    const id = REVIEW_CALLBACK_ID_PREFIX + coderName;
    const instruction =
        `${reviewerName} is your reviewer for this review cycle. When you complete fix instructions from the reviewer, `
        + `report back to it — node "<cliPath>" verb ptySendPrompt `
        + `'{"name":"${reviewerName}","data":"<your report>","clearBeforePrompt":false}' (or switchboard verb ptySendPrompt) `
        + `— naming what you changed and the verification results. Do not wait to be asked.`;
    await mutateStandingOrders(db, async (orders) => {
        const filtered = orders.filter(o => o.id !== id);
        filtered.push({
            id,
            parent: coderName,
            child: reviewerName,
            instruction,
            createdAt: Date.now(),
            scope: 'pair',
        });
        return filtered;
    });
}

/**
 * Remove the reviewer-callback override order from `coderName`, restoring
 * the coder's default callback target (the team lead). No-op when no such
 * order exists.
 */
export async function removeReviewerCallbackOrder(
    db: any,
    coderName: string
): Promise<void> {
    const id = REVIEW_CALLBACK_ID_PREFIX + coderName;
    await mutateStandingOrders(db, async (orders) => {
        const next = orders.filter(o => o.id !== id);
        return next.length === orders.length ? orders : next;
    });
}

