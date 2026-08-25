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
