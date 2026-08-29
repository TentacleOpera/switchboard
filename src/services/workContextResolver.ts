/**
 * Shared work-context resolution and team-context helpers.
 *
 * Resolves a dispatch's canonical plan record host-side from the pinned workspace
 * database to derive the atomic work-context boundary:
 *   workContextKey = record.featureId || record.planId
 *
 * Pure and host-agnostic — usable by extension host, standalone host, and LocalApiServer.
 */

import { TERMINALS_GROUPS_KEY, isSpawnedTeamGroup, teamHeadName, type TerminalGroupsSettingsAccessor } from './teamWiring';

export interface WorkContextResolution {
    planId: string;
    featureId: string | null;
    workContextKey: string;
}

export interface ResolvedTeamGroup {
    id: string;
    name: string;
    head?: string;
    roster: string[];
    group: any;
}

/**
 * Resolve the canonical work-context key for a dispatch target.
 *
 * Feature subtask  → parent featureId
 * Feature card     → its own planId (or featureId if set)
 * Featureless plan → its planId
 */
export async function resolveWorkContext(
    db: any,
    target: { planId?: string; planFile?: string }
): Promise<WorkContextResolution | null> {
    if (!target || (!target.planId && !target.planFile)) {
        return null;
    }
    let record: any = null;
    if (db) {
        try {
            if (target.planId && typeof db.getPlanByPlanId === 'function') {
                record = await db.getPlanByPlanId(target.planId);
            }
            if (!record && target.planFile && typeof db.getPlanByPlanFile === 'function') {
                const wsId = (typeof db.getWorkspaceId === 'function' ? await db.getWorkspaceId() : '')
                    || (typeof db.getDominantWorkspaceId === 'function' ? await db.getDominantWorkspaceId() : '') || '';
                record = await db.getPlanByPlanFile(target.planFile, wsId);
            }
        } catch {
            record = null;
        }
    }

    if (!record || !record.planId) {
        if (target.planId) {
            return {
                planId: target.planId,
                featureId: null,
                workContextKey: target.planId,
            };
        }
        return null;
    }

    const planId = record.planId;
    const featureId = (typeof record.featureId === 'string' && record.featureId.trim()) ? record.featureId.trim() : null;
    return {
        planId,
        featureId,
        workContextKey: featureId || planId,
    };
}

/**
 * Resolve the registered SPAWNED TEAM that includes the specified terminal name
 * (either as head or roster member).
 *
 * Membership is decided by `isSpawnedTeamGroup` — the single seam every
 * "is this a real team?" branch has to use. `terminals.groups` also holds
 * hand-saved terminal SELECTIONS, which carry neither `teamKind` nor a `team_`
 * id. Matching those would make an ordinary saved pane grouping behave like an
 * atomic team: one dispatch to any seat in it would `/clear` every other
 * terminal in the selection, each with a full readiness wait. Do not relax this
 * to a bare `teamGroup` test.
 */
export async function resolveTeamGroupForTerminal(
    db: any,
    terminalName: string,
    settings?: TerminalGroupsSettingsAccessor
): Promise<ResolvedTeamGroup | null> {
    if (!terminalName) return null;
    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db && typeof db.getConfigJson === 'function') {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db && typeof db.getConfigJson === 'function') {
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

    const rosterOf = (g: any): string[] => {
        const roster: any[] = Array.isArray(g?.order) && g.order.length
            ? g.order
            : (Array.isArray(g?.members) ? g.members : []);
        return roster.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
    };

    const teams = groups.filter(isSpawnedTeamGroup);

    // Preferred: the team this terminal HEADS. `head` is the declared field
    // (teamHeadName); the id form is the same derivation wireSpawnedTeam uses and
    // covers legacy rows written before `head` was stamped.
    const headId = 'team_' + encodeURIComponent(terminalName).replace(/[^a-zA-Z0-9_]/g, '_');
    const headGroup = teams.find(g => g && (teamHeadName(g) === terminalName || g.id === headId));
    if (headGroup) {
        const roster = rosterOf(headGroup);
        if (roster.length) {
            return {
                id: headGroup.id,
                name: headGroup.name || headGroup.id,
                head: headGroup.head || terminalName,
                roster,
                group: headGroup
            };
        }
    }

    // Otherwise: first team containing terminalName
    for (const g of teams) {
        if (!g) continue;
        const roster = rosterOf(g);
        if (roster.includes(terminalName)) {
            return {
                id: g.id,
                name: g.name || g.id,
                head: g.head,
                roster,
                group: g
            };
        }
    }

    return null;
}

// ── Roster barrier target-set computation ──────────────────────────────

/**
 * Input to {@link computeRosterClearTargets}. All fields are host-supplied:
 * the helper is pure and does not read the fleet, the clock, or config.
 *
 * - `roster` — the resolved team roster (from {@link resolveTeamGroupForTerminal}).
 * - `liveActive` — names of terminals whose pty exists (`status === 'active'`).
 * - `destination` — the terminal the prompt is going to. Always excluded: its
 *   clear belongs to the delivery path, which is the one place a clear is
 *   followed by a write with no gap.
 * - `origin` — the terminal that *requested* the send (the caller), or
 *   `undefined`/`''` when the dispatch is operator-driven (a board drag).
 *   When present and on the roster, the origin is excluded: a lead that
 *   dispatches to its own coder must not be cleared by its own dispatch.
 *   An origin that names a terminal NOT on the roster is a no-op exclusion
 *   (never widen the roster from caller-supplied data).
 * - `busySet` — names of seats that are mid-turn (`now - lastDataAt <
 *   livenessWindowMs`, or `lastDataAt === 0` for no heartbeat data). Built
 *   host-side from each root's own `lastDataAt` source so the helper stays
 *   pure. A seat with `lastDataAt === 0` is deferred — "no evidence" is not
 *   "at rest", matching the sweep's own `lastDataAt > 0` guard.
 */
export interface RosterClearTargetInput {
    roster: string[];
    liveActive: Set<string>;
    destination: string;
    origin?: string;
    busySet: Set<string>;
}

/**
 * Result of {@link computeRosterClearTargets}.
 *
 * - `toClear` — names to clear immediately (at rest, not the destination,
 *   not the origin).
 * - `deferred` — names to defer (mid-turn). A deferred seat is NOT skipped
 *   permanently: the same-feature branch intercept clears it before its
 *   next prompt delivery.
 */
export interface RosterClearTargetResult {
    toClear: string[];
    deferred: string[];
}

/**
 * Compute the roster barrier's target set: which active siblings to clear
 * immediately and which to defer because they are mid-turn.
 *
 * Pure and host-agnostic — both composition roots (extension host
 * `TaskViewerProvider.ts` and standalone `bootstrap.ts`) call this so the
 * two hosts produce byte-identical target sets for identical inputs.
 *
 * Exclusion rules (applied in order):
 *  1. Not in `liveActive` → skip (pty does not exist).
 *  2. Is the `destination` → skip (delivery path owns its clear).
 *  3. Is the `origin` (when present and on the roster) → skip (the caller
 *     must not be cleared by its own dispatch).
 *  4. In `busySet` → defer (mid-turn; cleared later via the same-feature
 *     branch intercept).
 *  5. Otherwise → clear immediately.
 *
 * Security: `origin` is caller-supplied and used only to REMOVE a name from
 * the target set, never to add one or widen scope. `resolveTeamGroupForTerminal`
 * stays the sole roster source.
 */
export function computeRosterClearTargets(input: RosterClearTargetInput): RosterClearTargetResult {
    const { roster, liveActive, destination, origin, busySet } = input;
    const toClear: string[] = [];
    const deferred: string[] = [];
    const originName = (typeof origin === 'string' && origin.trim()) ? origin.trim() : '';

    for (const name of roster) {
        if (!liveActive.has(name)) continue;
        if (name === destination) continue;
        if (originName && name === originName) continue;
        if (busySet.has(name)) {
            deferred.push(name);
        } else {
            toClear.push(name);
        }
    }

    return { toClear, deferred };
}

/**
 * Drop a terminal from every team's deferred-clear set.
 *
 * The deferred set is keyed by team id and holds TERMINAL NAMES, so it needs the
 * same lifecycle maintenance the sibling per-terminal maps already get on close
 * and clear. Without it: a closed seat's name lingers forever (and a later seat
 * that reuses the name inherits a phantom clear), and a seat the operator
 * cleared by hand still gets a redundant `/clear` on its next same-feature
 * prompt.
 *
 * Pure — takes the map, mutates it, reads nothing else. Both composition roots
 * call it so the two hosts keep byte-identical deferred state.
 */
export function dropDeferredClear(deferredByTeam: Map<string, Set<string>>, terminalName: string): void {
    if (!deferredByTeam || !terminalName) return;
    for (const [teamId, names] of deferredByTeam.entries()) {
        if (names.delete(terminalName) && names.size === 0) {
            deferredByTeam.delete(teamId);
        }
    }
}

/**
 * Re-key a terminal in every team's deferred-clear set after a rename.
 *
 * This is the case that silently defeats the feature rather than merely wasting
 * a clear: `ptyFleetService.rename()` mutates `friendlyName` in place, so a
 * deferred seat that is renamed is looked up under its NEW name by the
 * same-feature intercept and never matches — the seat carries the previous
 * run's context into the next one, which is exactly the invariant the deferral
 * exists to hold. Same class as the seat-block cache's documented rename bug.
 */
export function renameDeferredClear(deferredByTeam: Map<string, Set<string>>, oldName: string, newName: string): void {
    if (!deferredByTeam || !oldName || !newName || oldName === newName) return;
    for (const names of deferredByTeam.values()) {
        if (names.delete(oldName)) {
            names.add(newName);
        }
    }
}
