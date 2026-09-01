import * as crypto from 'crypto';
import {
    composeStandingOrderFragments,
    getStandingOrderFragment,
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
 * Team standing of a seat, derived from the SAME facts `selectOrders` uses:
 * the group roster (`terminals.groups`) plus the head name carried on each
 * team-scoped order's `parent`. Returns `inTeam: false` when no live team
 * claims the seat — never a guess.
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
    // Head-first: a seat that heads any team resolves as head, and its team's
    // roster is what the commit-trailer plan needs. The team-head scope carries
    // the head name in `o.parent`; `!!o.parent` is the gate that makes an
    // empty-parent team-head order resolve as not-head (and thus not-in-team
    // via this path).
    for (const o of orders) {
        if (scopeOf(o) !== 'team-head') { continue; }
        if (!o.teamId) { continue; }
        const group = groups.find(g => g && g.id === o.teamId);
        if (!group || !Array.isArray(group.members)) { continue; }
        if (!!o.parent && targetName === o.parent && group.members.includes(targetName)) {
            return { inTeam: true, isHead: true, teamId: o.teamId, headName: o.parent, members: group.members };
        }
    }
    // Head-second: a `team-head` order exists ONLY when the team was wired with a
    // non-empty headPrompt (`wireSpawnedTeam`), which is true for exactly one of
    // the three shipped team types and for no operator-created team that left the
    // head-prompt box empty. The head name is nevertheless always recorded — the
    // ALWAYS-written `team` order stores it in `parent` precisely so the head can
    // be excluded from member delivery. Resolve headship from that same fact, or
    // a headPrompt-less team gags its members into `dontCommit` while its head
    // keeps the shipped `notSpecified` default and is told to commit nothing —
    // a completed body of work with no committer, which is the exact asymmetry
    // this gate exists to prevent. Runs as its own pass, before the member pass,
    // so "head wins" holds regardless of the order rows' array order.
    for (const o of orders) {
        if (scopeOf(o) !== 'team') { continue; }
        if (!o.teamId) { continue; }
        const group = groups.find(g => g && g.id === o.teamId);
        if (!group || !Array.isArray(group.members)) { continue; }
        if (!!o.parent && targetName === o.parent && group.members.includes(targetName)) {
            return { inTeam: true, isHead: true, teamId: o.teamId, headName: o.parent, members: group.members };
        }
    }
    // Not a head of any team — check if the target is a non-head member of a
    // team-scope order's group. The head exclusion (`o.parent && targetName ===
    // o.parent`) is the SAME check `selectOrders`' team branch uses, so the two
    // cannot diverge on who is a member vs a head.
    for (const o of orders) {
        if (scopeOf(o) !== 'team') { continue; }
        if (!o.teamId) { continue; }
        const group = groups.find(g => g && g.id === o.teamId);
        if (!group || !Array.isArray(group.members)) { continue; }
        if (o.parent && targetName === o.parent) { continue; } // head exclusion
        if (group.members.includes(targetName)) {
            return { inTeam: true, isHead: false, teamId: o.teamId, headName: o.parent || undefined, members: group.members };
        }
    }
    return { inTeam: false, isHead: false, members: [] };
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
    const selected = orders.filter(o => {
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
    };
}

export function resolveStandingOrderInstruction(o: StandingOrder, ctx: StandingOrderCompositionContext): string {
    if (typeof o.instruction === 'string') { return o.instruction; }
    if (!Array.isArray(o.fragments) || o.fragments.length === 0) { return ''; }
    const composed = composeStandingOrderFragments(o.fragments, ctx);
    if (composed.unknown.length) {
        console.warn(`[standingOrders] Unknown fragment id(s) on order '${o.id}': ${composed.unknown.join(', ')}`);
    }
    return composed.text;
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
export function renderStandaloneOrdersBlock(
    orders: StandingOrder[],
    targetName: string,
    liveNames: Set<string>,
    groups: TerminalGroup[],
    roleMap?: Map<string, string>,
    options: StandingOrderRenderOptions = {}
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
    const rendered = sorted.map(o => renderOrder(o, ctx)).filter(Boolean);
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
    options: StandingOrderRenderOptions = {}
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

    const block = renderStandaloneOrdersBlock(orders, targetName, liveNames, groups, roleMap, options);
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
