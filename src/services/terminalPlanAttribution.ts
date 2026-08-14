import { matchWorktreePath } from './worktreeResolver';
import type { LiveDispatchAttributionRow, WorktreeRow } from './KanbanDatabase';

export interface TerminalPlanAttribution {
    planId: string;
    planTitle: string;
}

interface TerminalLike {
    friendlyName?: string;
    worktreePath?: string;
    status?: string;
}

/**
 * THE shared terminal->plan matcher for the fleet-list enrichment. Two tiers,
 * in strict order — deliberately NOT three:
 *
 *   1. name  — row.dispatchedTerminal === terminal.friendlyName
 *   2. path  — matchWorktreePath(worktrees, row) === terminal.worktreePath, and
 *              ONLY for rows whose dispatchedTerminal is empty (extension-host
 *              dispatch does not record a terminal name). A row that names its
 *              terminal is already resolvable by name; letting it also match by
 *              path would paint terminal A's plan onto terminal B sharing that
 *              worktree.
 *
 * There is deliberately NO role-only tier. A header rendered for the whole run
 * must not guess — three coders in three checkouts would wear two wrong titles
 * for the entire session. No title beats a wrong title.
 *
 * The path tier requires the path to be unambiguous on BOTH sides: exactly one
 * candidate row resolved to it AND exactly one active, not-already-name-matched
 * seat at it. matchWorktreePath resolves on worktrees.feature_id then
 * worktrees.project, so a shared feature path is the common case and any
 * tie-break would paint a wrong title on a real pane. Ambiguity yields nothing.
 *
 * `rows` MUST be ordered dispatched_at DESC: the name tier takes the first row
 * per name, so ordering is what makes a re-dispatch win over a stale row.
 */
export function attributePlansToTerminals(
    rows: LiveDispatchAttributionRow[],
    worktrees: WorktreeRow[],
    terminals: TerminalLike[]
): Map<string, TerminalPlanAttribution> {
    const result = new Map<string, TerminalPlanAttribution>();
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(terminals)) return result;

    const live = terminals.filter(t => t && t.friendlyName && (!t.status || t.status === 'active'));
    if (live.length === 0) return result;

    // A title is only a title after trimming. getLiveDispatchAttribution already
    // trims, but this module is the contract both hosts share and a whitespace-only
    // topic (malformed import) must read as NO attribution, not as a blank strip.
    const titleOf = (row: LiveDispatchAttributionRow): string => (row.topic || '').trim();

    // Tier 1 — name. First row per name wins (rows are dispatched_at DESC).
    const byName = new Map<string, LiveDispatchAttributionRow>();
    for (const row of rows) {
        if (!row || !titleOf(row) || !row.dispatchedTerminal) continue;
        if (!byName.has(row.dispatchedTerminal)) byName.set(row.dispatchedTerminal, row);
    }
    const unnamed: TerminalLike[] = [];
    for (const t of live) {
        const name = t.friendlyName as string;
        const named = byName.get(name);
        if (named) { result.set(name, { planId: named.planId, planTitle: titleOf(named) }); }
        else { unnamed.push(t); }
    }

    // Tier 2 — worktree path, unambiguous on both sides only.
    const wts = Array.isArray(worktrees) ? worktrees : [];
    const rowsByPath = new Map<string, LiveDispatchAttributionRow[]>();
    for (const row of rows) {
        if (!row || !titleOf(row) || row.dispatchedTerminal) continue;
        const resolvedPath = matchWorktreePath(wts, {
            featureId: row.featureId,
            project: row.project,
            planId: row.planId,
        });
        if (!resolvedPath) continue;
        const list = rowsByPath.get(resolvedPath);
        if (list) { list.push(row); } else { rowsByPath.set(resolvedPath, [row]); }
    }
    if (rowsByPath.size === 0) return result;

    const seatsByPath = new Map<string, string[]>();
    for (const t of unnamed) {
        const resolvedPath = t.worktreePath || '';
        if (!resolvedPath) continue;
        const list = seatsByPath.get(resolvedPath);
        if (list) { list.push(t.friendlyName as string); } else { seatsByPath.set(resolvedPath, [t.friendlyName as string]); }
    }
    for (const [resolvedPath, candidates] of rowsByPath) {
        const seats = seatsByPath.get(resolvedPath);
        if (!seats || seats.length !== 1 || candidates.length !== 1) continue;
        result.set(seats[0], { planId: candidates[0].planId, planTitle: titleOf(candidates[0]) });
    }
    return result;
}
