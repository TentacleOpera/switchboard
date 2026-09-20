/**
 * The mission stage: which pipeline stage a mission works at, and whether a card
 * may be released into it. ONE ranking, shared by every surface that needs it.
 *
 * The plan's rule (`mission-08-one-mission-per-stage-and-no-card-skips-a-column`):
 * a mission releases a card only when the card sits in the stage IMMEDIATELY
 * BEFORE the mission's own. A review mission may not pull a card out of CREATED —
 * that jumps planning and coding at once. Such a member is HELD, not delivered,
 * and the reason is reported rather than the member being silently skipped.
 *
 * The ranking is `DEFAULT_KANBAN_COLUMNS`' own `order`, and the lane is its own
 * `kind: 'coded'`. A second, hand-kept list is the exact defect
 * `_PIPELINE_POSITION`'s comment records (it once ranked RESEARCHER before PLAN
 * REVIEWED and TICKET UPDATER after COMPLETED, with a backward move read as
 * forward — "which dispatches"). This module exists so the pop, the mission card
 * and Mission 06's release column cannot rank the pipeline differently.
 *
 * Pure: no db, no config, no host. Everything here derives from the column table.
 */
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

/**
 * Column aliases that are NOT peer columns and therefore carry no `order` of
 * their own: BACKLOG is a display mode of CREATED, and CODED is the legacy alias
 * of LEAD CODED. Same aliasing `_PIPELINE_POSITION` has always applied.
 */
function normalizeMissionColumn(column: unknown): string {
    const id = String(column ?? '').trim().toUpperCase();
    if (id === 'BACKLOG') { return 'CREATED'; }
    if (id === 'CODED') { return 'LEAD CODED'; }
    return id;
}

/** The pipeline rank per column id, derived from the column table's `order`. */
export const PIPELINE_POSITION: Record<string, number> = (() => {
    const positions: Record<string, number> = {};
    for (const col of DEFAULT_KANBAN_COLUMNS) { positions[col.id] = col.order; }
    positions['BACKLOG'] = positions['CREATED'] ?? 0;
    positions['CODED'] = positions['LEAD CODED'] ?? 0;
    return positions;
})();

/**
 * The coded lane. LEAD / CODER / INTERN CODED are parallel SEATS of one stage,
 * not three stages: a mission whose team works the coded lane is at the coding
 * stage whichever coded column a member sits in, which is why "two coding
 * missions on one card" cannot arise under the one-mission rule — there is one
 * stage and one mission for it.
 *
 * Derived from the column table's `kind`, never a hand-kept id list.
 */
export function isParallelCodedLane(column: unknown): boolean {
    const id = normalizeMissionColumn(column);
    return DEFAULT_KANBAN_COLUMNS.some(col => col.id === id && col.kind === 'coded');
}

/** One stage of the pipeline, with the coded lane collapsed into a single entry. */
export interface PipelineStage {
    /** Stable identity: the column id, or `'CODED'` for the collapsed lane. */
    key: string;
    /** The column the stage is named after — the lane's lowest-ranked column. */
    column: string;
    /** The lane's lowest rank, so stages order exactly as the columns do. */
    rank: number;
    label: string;
}

const CODED_LANE_KEY = 'CODED';

/** Every stage, ordered by rank, with the coded lane collapsed to one entry. */
export const PIPELINE_STAGES: PipelineStage[] = (() => {
    const stages: PipelineStage[] = [];
    const seen = new Set<string>();
    for (const col of [...DEFAULT_KANBAN_COLUMNS].sort((a, b) => a.order - b.order)) {
        const key = col.kind === 'coded' ? CODED_LANE_KEY : col.id;
        if (seen.has(key)) { continue; }
        seen.add(key);
        stages.push({
            key,
            column: col.kind === 'coded' ? 'CODER CODED' : col.id,
            rank: col.order,
            label: col.kind === 'coded' ? `${col.label} (coded lane)` : col.label,
        });
    }
    return stages;
})();

/** The stage a column belongs to, or null when the column has no pipeline rank. */
export function resolveStageForColumn(column: unknown): PipelineStage | null {
    const id = normalizeMissionColumn(column);
    if (!id) { return null; }
    if (isParallelCodedLane(id)) {
        return PIPELINE_STAGES.find(s => s.key === CODED_LANE_KEY) || null;
    }
    return PIPELINE_STAGES.find(s => s.key === id) || null;
}

/** Normalised comparison key for a role: `ticket_updater` and `Ticket Updater` agree. */
function roleKey(role: unknown): string {
    return String(role ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The stage a team HEAD ROLE works at — the column the role owns, per the column
 * table's own `role` field. This is the step that turns a mission's team into a
 * stage; nothing else may answer it.
 *
 * The returned stage keeps the ROLE's own column (`LEAD CODED` for a lead,
 * `CODER CODED` for a coder) while its `key` is the collapsed lane, so a caller
 * that needs a dispatch TARGET gets the column the team actually works in.
 */
export function resolveStageForHeadRole(headRole: unknown): PipelineStage | null {
    const wanted = roleKey(headRole);
    if (!wanted) { return null; }
    const column = DEFAULT_KANBAN_COLUMNS.find(col => roleKey(col.role) === wanted);
    if (!column) { return null; }
    const stage = resolveStageForColumn(column.id);
    if (!stage) { return null; }
    return { ...stage, column: column.id, label: column.label };
}

/** The stage immediately before `stage`, or null when `stage` is the first. */
export function stageBefore(stage: PipelineStage | null): PipelineStage | null {
    if (!stage) { return null; }
    const idx = PIPELINE_STAGES.findIndex(s => s.key === stage.key);
    return idx > 0 ? PIPELINE_STAGES[idx - 1] : null;
}

/** Where a mission works, or why that could not be derived. */
export interface MissionStageResolution {
    stage: PipelineStage | null;
    /** The stage the mission releases FROM — the one immediately before its own. */
    releaseFrom: PipelineStage | null;
    /** Named when `stage` is null, so the caller refuses loudly instead of delivering everything. */
    reason?: string;
}

/** Resolve a mission's stage from the team it is bound to (`missions.team` = a definition id). */
export async function resolveMissionStageFromTeam(
    teamId: unknown,
    headRoleOfTeam: (teamId: string) => Promise<string | null | undefined> | string | null | undefined
): Promise<MissionStageResolution> {
    const id = String(teamId ?? '').trim();
    if (!id) {
        return { stage: null, releaseFrom: null, reason: 'the mission carries no team, so the stage it works at cannot be derived' };
    }
    const headRole = await headRoleOfTeam(id);
    if (!headRole) {
        return { stage: null, releaseFrom: null, reason: `team '${id}' could not be resolved to a head role` };
    }
    const stage = resolveStageForHeadRole(headRole);
    if (!stage) {
        return { stage: null, releaseFrom: null, reason: `head role '${headRole}' (team '${id}') works at no pipeline column` };
    }
    return { stage, releaseFrom: stageBefore(stage) };
}

/**
 * What the gate says about one member's card.
 *
 *  - `releasable` — the mission may dispatch it now.
 *  - `held`       — it would have to SKIP a stage to reach the mission. Not
 *                   delivered, and not an empty mission: the card says why.
 *  - `delivered`  — it already sits at the mission's own stage or past it. The
 *                   work has left this mission's hands; re-releasing it would
 *                   redo it. This is NOT a hold, and must never render as one.
 */
export type ReleaseVerdict = 'releasable' | 'held' | 'delivered';

/**
 * MAY THIS MISSION RELEASE THIS CARD? The no-stage-skipping gate.
 *
 * Releasable in exactly two cases:
 *  - the card is UNDELIVERED (STAGING, the mission's own queue), which is the
 *    normal case — a member is claimed into STAGING and released from there;
 *  - the card sits in the stage immediately before the mission's stage, which is
 *    what a re-release looks like (a review mission releasing a coded card).
 *
 * A card EARLIER than that would skip a stage, and is HELD with a reason naming
 * both its column and the column the mission releases from — because "held" and
 * "delivered" must not render the same, and neither may render as an empty
 * mission.
 *
 * A column with no pipeline rank is HELD, never delivered: the failure mode of a
 * gate is refusal, and delivering a card whose position could not be read is the
 * fail-open this gate exists to prevent.
 */
export function releaseVerdict(
    stage: PipelineStage,
    cardColumn: unknown
): { verdict: ReleaseVerdict; reason: string } {
    const column = normalizeMissionColumn(cardColumn);
    if (!column) {
        return { verdict: 'held', reason: 'the card carries no column, so its stage cannot be read' };
    }
    if (column === 'STAGING') {
        return { verdict: 'releasable', reason: `undelivered — a mission member in STAGING is released from its own queue` };
    }
    const cardStage = resolveStageForColumn(column);
    if (!cardStage) {
        return { verdict: 'held', reason: `'${column}' has no pipeline position — held rather than delivered unchecked` };
    }
    const releaseFrom = stageBefore(stage);
    if (cardStage.key === stage.key || cardStage.rank > stage.rank) {
        return {
            verdict: 'delivered',
            reason: `already at or past the mission's own stage ('${column}' vs '${stage.column}') — delivered, not released again`,
        };
    }
    if (!releaseFrom) {
        return { verdict: 'held', reason: `the mission works at '${stage.column}', the first stage — nothing precedes it` };
    }
    if (cardStage.key === releaseFrom.key) {
        return { verdict: 'releasable', reason: `sits at '${column}', the stage before '${stage.column}'` };
    }
    return {
        verdict: 'held',
        reason: `sits at '${column}', before '${stage.column}'; this mission releases from '${releaseFrom.column}'`,
    };
}

/** The minimal card view the held-member enumeration reads. */
export interface MemberCardView {
    column?: string;
    completedAt?: string | null;
}

/**
 * WHICH MEMBERS THE GATE HOLDS, with the reason for each — the ONE enumeration.
 *
 * Two surfaces need this answer: the pop (which must not dispatch a held member)
 * and the board payload (whose mission card renders the reason). Two
 * implementations of "which members are held, and why" is the same drift the
 * feature forbids for the stage ranking, so both call this.
 *
 * A COMPLETE member is never held — it is done, and the mission's derived
 * `runState` already accounts for it. A member whose card is missing from the
 * board IS held (that is a data gap the operator can act on, not a silence). With
 * no stage to gate on, every non-complete member is held, which is the refusal an
 * unplaceable mission owes.
 */
export function heldMembers(
    stage: PipelineStage | null,
    memberIds: Iterable<string>,
    cardOf: (memberId: string) => MemberCardView | undefined,
    stageReason?: string
): Array<{ planId: string; column: string; reason: string }> {
    const held: Array<{ planId: string; column: string; reason: string }> = [];
    for (const rawId of memberIds) {
        const planId = String(rawId);
        const card = cardOf(planId);
        if (card && card.completedAt) { continue; }
        if (!card) {
            held.push({ planId, column: '', reason: 'no card on the board for this member — nothing can be released' });
            continue;
        }
        const column = String(card.column || '');
        if (!stage) {
            held.push({
                planId, column,
                reason: `the mission's stage could not be derived (${stageReason || 'unknown reason'}) — held rather than delivered unchecked`,
            });
            continue;
        }
        const verdict = releaseVerdict(stage, column);
        if (verdict.verdict === 'held') { held.push({ planId, column, reason: verdict.reason }); }
    }
    return held;
}
