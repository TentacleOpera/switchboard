import type { ModelCallRequest, ModelCallResult } from '../judgement/modelClient';
import { computeMapFingerprint } from '../../services/kanbanOrdering';

/**
 * The Navigator capability (plan: the-navigator-groups-ready-plans-into-missions,
 * subtask 2 — "The Navigator Proposes a Mission's Cards").
 *
 * Starting a mission is a conversation, not a board-reading exercise. The
 * operator states a subject and a goal; this module assembles the eligible
 * cards mechanically, asks the Navigator's own model slot for a proposal, and
 * — once the operator approves it — creates the mission through the board's
 * EXISTING mission verbs.
 *
 * Three fences this module holds, each of which is a bug in the codebase it
 * replaces if broken:
 *
 *  - **A mission, not a feature.** The only board writes here are
 *    `POST /kanban/mission/create` and `POST /kanban/mission/member/add`
 *    (→ `claimIntoMission`). Grouping the same plans into a *feature* would
 *    create something the mission panel cannot see, and the panel would go on
 *    saying "No mission set up" while the operator looked at what the Navigator
 *    had just built. The capability is given the mission verbs and nothing else.
 *  - **Never trust a model-returned id.** Every id the model names is validated
 *    against the candidate set THIS module assembled. An id outside it is an
 *    invalid reply — the whole pass reports that rather than proposing a card
 *    the board never offered.
 *  - **No plan is written.** No plan file is created, renamed, retitled or
 *    touched. The Navigator may name a mission and write the mission's own
 *    goal; that is all.
 *
 * The module makes no board call and no model call of its own: every read and
 * write arrives through `NavigatorPorts`, so the capability is drivable from a
 * test with no board and no model, and the composition root keeps ownership of
 * which store answers.
 */

/** At most ten cards in a proposal. A cap, not a target — enforced here, never asked for in a prompt. */
export const NAVIGATOR_PROPOSAL_CAP = 10;

/** A cold-board pass returns at most three groupings: a number a person will actually read. */
export const NAVIGATOR_COLD_BOARD_CAP = 3;

/**
 * How much of one plan's body travels to the model. The body is evidence for
 * SUBJECT MATCHING, not a document to reason over, and an unbounded excerpt per
 * card is how the sweep this plan retired made every pass maximally expensive.
 */
export const NAVIGATOR_BODY_EXCERPT_CHARS = 4000;

/** One board row, as the board read returns it. Both spellings are accepted. */
export interface NavigatorPlanRow {
    planId?: string;
    id?: string;
    topic?: string;
    project?: string;
    kanbanColumn?: string;
    kanban_column?: string;
    isFeature?: number | boolean;
    featureId?: string;
    feature_id?: string;
    ownerSeat?: string;
    ownerSince?: string | null;
    owner_since?: string | null;
    completedAt?: string | null;
    completed_at?: string | null;
    planFile?: string;
    body?: string;
}

/** A card that survived the mechanical filter — the set model ids are validated against. */
export interface CandidateCard {
    planId: string;
    topic: string;
    project: string;
    kanbanColumn: string;
    /** The plan's own text, excerpted. `''` when the pass asked for summaries only. */
    body: string;
}

/** The Navigator's own model slot, tagged with the pointer that answered. */
export interface NavigatorModelSlot {
    providerId: string;
    endpoint: string;
    model: string;
    apiKey: string | null;
    /** `row:navigator` | `unset` | `row-missing` — never collapsed into one value. */
    source: string;
}

/** One per-id claim outcome, exactly as `claimIntoMission` returned it. */
export interface MissionClaim {
    planId: string;
    claimed: boolean;
    /** Set when the card was held by another mission and the claim transferred it. */
    transferredFrom?: string;
    reason?: string;
}

export interface ProvenanceEntry {
    modelId: string;
    subject: string;
    missionId: string;
    outcome: string;
    approvedCount: number;
    claims: MissionClaim[];
}

export interface RecordResult {
    written: boolean;
    reason?: string;
}

export interface NavigatorPorts {
    /** One read of every plan row on the board. */
    listPlans(): Promise<NavigatorPlanRow[]>;
    /** `isMissionMember` — a query, not a judgement. */
    isMissionMember(planId: string): Promise<boolean>;
    /** The plan's own text, for the surviving set only. */
    readPlanBody(row: NavigatorPlanRow): Promise<string>;
    /** The Navigator's model slot, from its OWN pointer. */
    navigatorModel(): Promise<NavigatorModelSlot | { error: string }>;
    /** The one model call seam. */
    callModel(req: ModelCallRequest): Promise<ModelCallResult>;
    /** `POST /kanban/mission/create`. Never called with `team` or `maxExtraWorktrees`. */
    createMission(input: { name: string; goal: string; type: 'mission' }): Promise<{ missionId: string } | { error: string }>;
    /** `POST /kanban/mission/member/add` → `claimIntoMission`. */
    claimIntoMission(input: { missionId: string; planId: string; kind: 'plan' }): Promise<MissionClaim>;
    /** The controller report append. Optional: a host that wired no report store says so. */
    recordProvenance?(entry: ProvenanceEntry): Promise<RecordResult>;
    /** Total budget for connect + response, in ms. */
    deadlineMs?: number;
    maxTokens?: number;
}

/**
 * The validated proposal — the shape is EXACTLY these five fields, and none of
 * them can carry plan body text. A model that wants to draft has nowhere to put
 * it: the fence the Goal draws ("it does not write a plan, edit one, or invent
 * work") made structural rather than asked for.
 */
export interface Proposal {
    missionName: string;
    goal: string;
    planIds: string[];
    rationale: string;
    /** `null` when nothing was dropped; otherwise which ids and how many. */
    truncated: { dropped: number; ids: string[] } | null;
}

export type ProposeOutcome =
    | { kind: 'proposal'; subject: string; modelId: string; proposal: Proposal; candidates: CandidateCard[] }
    | { kind: 'cold-board'; modelId: string; groupings: Proposal[]; truncated: { dropped: number; ids: string[] } | null; candidates: CandidateCard[] }
    | { kind: 'no-candidates'; subject: string }
    | { kind: 'invalid-reply'; subject: string; modelId: string; reason: string }
    | { kind: 'unconfigured'; subject: string; reason: string }
    | { kind: 'error'; subject: string; reason: string };

export type ApplyOutcome =
    | { kind: 'applied'; missionId: string; approvedCount: number; claims: MissionClaim[]; recorded: RecordResult }
    | { kind: 'partial'; missionId: string; approvedCount: number; claims: MissionClaim[]; recorded: RecordResult }
    | { kind: 'created-empty'; missionId: string; approvedCount: number; claims: MissionClaim[]; recorded: RecordResult }
    | { kind: 'error'; reason: string; missionId: string | null; claims: MissionClaim[]; recorded: RecordResult };

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_TOKENS = 2048;

function str(v: unknown): string {
    return v === undefined || v === null ? '' : String(v).trim();
}

/**
 * The mechanical eligibility filter, and nothing else.
 *
 * Every clause is a query, not a judgement: a card already in a mission
 * (`isMissionMember`), a card inside a feature, a card being worked on
 * (`owner_since` with no `completed_at`) and a feature row are all OUT. The
 * model is never asked to decide eligibility — handed that job it invents
 * reasons, and an ineligible card in a proposal is a card the operator approves
 * and does not get.
 */
export async function collectCandidates(
    ports: NavigatorPorts,
    opts?: { bodies?: boolean },
): Promise<CandidateCard[]> {
    const withBodies = opts?.bodies !== false;
    const rows = (await ports.listPlans()) || [];
    const out: CandidateCard[] = [];
    for (const row of rows) {
        if (!row) { continue; }
        const planId = str(row.planId) || str(row.id);
        if (!planId) { continue; }
        if (row.isFeature === 1 || row.isFeature === true) { continue; }
        if (str(row.featureId) || str(row.feature_id)) { continue; }
        const ownerSince = row.ownerSince ?? row.owner_since ?? null;
        const completedAt = row.completedAt ?? row.completed_at ?? null;
        if (str(ownerSince) && !str(completedAt)) { continue; }
        if (await ports.isMissionMember(planId)) { continue; }
        let body = '';
        if (withBodies) {
            const raw = typeof row.body === 'string' ? row.body : await ports.readPlanBody(row);
            body = String(raw || '').slice(0, NAVIGATOR_BODY_EXCERPT_CHARS);
        }
        out.push({
            planId,
            topic: str(row.topic) || planId,
            project: str(row.project),
            kanbanColumn: str(row.kanbanColumn) || str(row.kanban_column),
            body,
        });
    }
    return out;
}

function candidatePayload(candidates: CandidateCard[], includeBodies: boolean): unknown[] {
    return candidates.map(c => ({
        planId: c.planId,
        topic: c.topic,
        project: c.project,
        column: c.kanbanColumn,
        ...(includeBodies && c.body ? { body: c.body } : {}),
    }));
}

/** Lenient JSON extraction: a fenced or chatty reply is parsed, not rejected on punctuation. */
function parseJsonReply(content: string): any | null {
    const text = String(content || '')
        .replace(/^```[a-zA-Z]*\s*/, '')
        .replace(/```\s*$/, '')
        .trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) { return null; }
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function idList(v: unknown): string[] {
    if (!Array.isArray(v)) { return []; }
    return v.map(x => str(x)).filter(Boolean);
}

/**
 * Validate one grouping's ids against the candidate set. Returns the offending
 * ids when any is outside it — the whole reply is then an INVALID REPLY, not a
 * proposal with the bad ids quietly filtered out. A model that named a card the
 * board never offered has shown it is not reading the list it was given, and
 * the next thing it names is not trustworthy either.
 */
function foreignIds(ids: string[], allowed: Set<string>): string[] {
    const seen = new Set<string>();
    const bad: string[] = [];
    for (const id of ids) {
        if (allowed.has(id) || seen.has(id)) { continue; }
        seen.add(id);
        bad.push(id);
    }
    return bad;
}

function dedupe(ids: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (!id || seen.has(id)) { continue; }
        seen.add(id);
        out.push(id);
    }
    return out;
}

const PROPOSE_SYSTEM = [
    'You organize work on a board of coding agents. You are given a SUBJECT the',
    'operator wants to start a mission on, that mission\'s GOAL, and a list of',
    'ELIGIBLE CARDS other agents wrote. Choose up to 10 cards that belong together',
    'under that subject and share its priority — a card that shares the subject but',
    'sits in BACKLOG is not the same proposal as one that is ready.',
    'You SELECT among existing cards. You do not write, edit or retitle a plan, and',
    'you do not invent work that is not in the list.',
    'Reply with ONE JSON object and nothing else:',
    '{"missionName":"...","goal":"...","planIds":["..."],"rationale":"..."}',
    '- missionName: a short name for the mission.',
    '- goal: one sentence — the mission\'s own goal, not a plan.',
    '- planIds: the ids you selected, most important first, at most 10.',
    '- rationale: one line saying why these cards belong together.',
    'Use ONLY planId values from the list. An id that is not in the list is an error.',
].join('\n');

const COLD_BOARD_SYSTEM = [
    'You organize work on a board of coding agents. The operator has not named a',
    'subject. Look at the ELIGIBLE CARDS and return the groupings most worth',
    'starting as missions — AT MOST THREE. Three is a number a person will read;',
    'an uncapped list is not a proposal.',
    'You SELECT among existing cards. You do not write, edit or retitle a plan, and',
    'you do not invent work that is not in the list.',
    'Reply with ONE JSON object and nothing else:',
    '{"groupings":[{"missionName":"...","goal":"...","planIds":["..."],"rationale":"..."}]}',
    'Use ONLY planId values from the list. An id that is not in the list is an error.',
].join('\n');

/**
 * One model call, against a slot already resolved. The slot is passed IN rather
 * than resolved here: two reads of the pointer in one pass could name a model in
 * the report that is not the one that was called, which is exactly the
 * "which store answered?" failure the tagged reader exists to prevent.
 */
async function askNavigator(
    ports: NavigatorPorts,
    slot: NavigatorModelSlot,
    system: string,
    user: unknown,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
    const res = await ports.callModel({
        endpoint: slot.endpoint,
        model: slot.model,
        apiKey: slot.apiKey ?? null,
        system,
        user: JSON.stringify(user),
        deadlineMs: ports.deadlineMs ?? DEFAULT_DEADLINE_MS,
        maxTokens: ports.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
    if (!res.ok) {
        return { ok: false, reason: res.error || `the Navigator's endpoint returned ${res.status}` };
    }
    if (!String(res.content || '').trim()) {
        return { ok: false, reason: `the Navigator returned nothing (finish: ${res.doneReason || 'unknown'})` };
    }
    return { ok: true, content: res.content };
}

/** `providerId` (model) — the tag every report entry carries, so "which model proposed this" is answerable. */
function modelIdOf(slot: { providerId: string; model: string }): string {
    return slot.model ? `${slot.providerId} (${slot.model})` : slot.providerId;
}

/**
 * Ask the Navigator for a mission's cards, given a subject and a goal.
 *
 * The four outcomes that are not a proposal stay four DISTINCT kinds, because
 * "no eligible cards", "the model's reply was invalid", "the pass failed" and
 * "no Navigator is configured" are four different things an operator does four
 * different things about — and rendering any two of them as the same string is
 * the failure this plan names.
 */
export async function proposeMission(
    args: { subject: string; goal?: string },
    ports: NavigatorPorts,
): Promise<ProposeOutcome> {
    const subject = str(args.subject);
    const slot = await ports.navigatorModel();
    if ('error' in slot) { return { kind: 'unconfigured', subject, reason: slot.error }; }
    if (!slot.endpoint) {
        return { kind: 'unconfigured', subject, reason: `no Navigator model is configured (source: ${slot.source || 'unset'})` };
    }
    const modelId = modelIdOf(slot);

    const candidates = await collectCandidates(ports, { bodies: true });
    if (candidates.length === 0) { return { kind: 'no-candidates', subject }; }
    const allowed = new Set(candidates.map(c => c.planId));

    const asked = await askNavigator(ports, slot, PROPOSE_SYSTEM, {
        subject,
        goal: str(args.goal),
        eligibleCards: candidatePayload(candidates, true),
    });
    if (!asked.ok) { return { kind: 'error', subject, reason: asked.reason }; }

    const reply = parseJsonReply(asked.content);
    if (!reply || typeof reply !== 'object') {
        return { kind: 'invalid-reply', subject, modelId, reason: 'the reply was not a JSON object' };
    }
    const named = dedupe(idList(reply.planIds));
    const foreign = foreignIds(idList(reply.planIds), allowed);
    if (foreign.length > 0) {
        return {
            kind: 'invalid-reply', subject, modelId,
            reason: `the reply named ${foreign.length} card(s) that are not in the eligible set: ${foreign.join(', ')}`,
        };
    }
    if (named.length === 0) {
        return { kind: 'invalid-reply', subject, modelId, reason: 'the reply named no cards' };
    }

    const kept = named.slice(0, NAVIGATOR_PROPOSAL_CAP);
    const droppedIds = named.slice(NAVIGATOR_PROPOSAL_CAP);
    return {
        kind: 'proposal',
        subject,
        modelId,
        candidates,
        proposal: {
            missionName: str(reply.missionName),
            goal: str(reply.goal) || str(args.goal),
            planIds: kept,
            rationale: str(reply.rationale),
            truncated: droppedIds.length ? { dropped: droppedIds.length, ids: droppedIds } : null,
        },
    };
}

/**
 * The secondary path: the operator gave no subject and asked what is worth
 * doing. Capped at three groupings, and the payload carries NO plan bodies —
 * this is the pass that reads the whole board, and shipping every plan's text
 * to a metered third party because the operator asked an open question is the
 * cost this plan exists to avoid.
 */
export async function proposeColdBoard(ports: NavigatorPorts): Promise<ProposeOutcome> {
    const subject = '';
    const slot = await ports.navigatorModel();
    if ('error' in slot) { return { kind: 'unconfigured', subject, reason: slot.error }; }
    if (!slot.endpoint) {
        return { kind: 'unconfigured', subject, reason: `no Navigator model is configured (source: ${slot.source || 'unset'})` };
    }
    const modelId = modelIdOf(slot);

    const candidates = await collectCandidates(ports, { bodies: false });
    if (candidates.length === 0) { return { kind: 'no-candidates', subject }; }
    const allowed = new Set(candidates.map(c => c.planId));

    const asked = await askNavigator(ports, slot, COLD_BOARD_SYSTEM, { eligibleCards: candidatePayload(candidates, false) });
    if (!asked.ok) { return { kind: 'error', subject, reason: asked.reason }; }

    const reply = parseJsonReply(asked.content);
    const rawGroupings = reply && Array.isArray(reply.groupings) ? reply.groupings : null;
    if (!rawGroupings || rawGroupings.length === 0) {
        return { kind: 'invalid-reply', subject, modelId, reason: 'the reply carried no groupings' };
    }
    const groupings: Proposal[] = [];
    for (const g of rawGroupings) {
        const ids = idList(g && g.planIds);
        const foreign = foreignIds(ids, allowed);
        if (foreign.length > 0) {
            return {
                kind: 'invalid-reply', subject, modelId,
                reason: `a grouping named ${foreign.length} card(s) that are not in the eligible set: ${foreign.join(', ')}`,
            };
        }
        const named = dedupe(ids);
        if (named.length === 0) { continue; }
        groupings.push({
            missionName: str(g.missionName),
            goal: str(g.goal),
            planIds: named.slice(0, NAVIGATOR_PROPOSAL_CAP),
            rationale: str(g.rationale),
            truncated: null,
        });
    }
    if (groupings.length === 0) {
        return { kind: 'invalid-reply', subject, modelId, reason: 'no grouping named a card' };
    }
    const kept = groupings.slice(0, NAVIGATOR_COLD_BOARD_CAP);
    const dropped = groupings.slice(NAVIGATOR_COLD_BOARD_CAP);
    return {
        kind: 'cold-board',
        modelId,
        candidates,
        groupings: kept,
        truncated: dropped.length ? { dropped: dropped.length, ids: dropped.map(g => g.missionName || '(unnamed)') } : null,
    };
}

/**
 * Apply an approved proposal.
 *
 * `POST /kanban/mission/create` first, then one `POST /kanban/mission/member/add`
 * per approved id. `team` and `maxExtraWorktrees` are deliberately NOT sent:
 * they belong to the parameters subtask, and a value written here would be
 * indistinguishable from an operator's choice.
 *
 * The apply step re-checks NOTHING itself. `claimIntoMission` is the arbiter of
 * a card another mission or a seat took between propose and apply, and its
 * result is authoritative — reported per id, never silently dropped. A mission
 * holding four of the ten cards the operator approved is worse than no mission,
 * because it looks complete, so a partial result is its own kind and says which
 * ids did not land.
 */
export async function applyProposal(
    args: { missionName: string; goal: string; planIds: string[]; subject?: string; modelId?: string },
    ports: NavigatorPorts,
): Promise<ApplyOutcome> {
    const planIds = dedupe((args.planIds || []).map(str));
    if (planIds.length === 0) {
        return { kind: 'error', reason: 'no cards were approved', missionId: null, claims: [], recorded: { written: false, reason: 'nothing was applied' } };
    }
    const created = await ports.createMission({
        name: str(args.missionName),
        goal: str(args.goal),
        type: 'mission',
    });
    if ('error' in created) {
        return { kind: 'error', reason: created.error, missionId: null, claims: [], recorded: { written: false, reason: 'the mission was not created' } };
    }
    const missionId = created.missionId;

    const claims: MissionClaim[] = [];
    for (const planId of planIds) {
        try {
            const claim = await ports.claimIntoMission({ missionId, planId, kind: 'plan' });
            claims.push({ planId, claimed: !!claim.claimed, ...(claim.transferredFrom ? { transferredFrom: claim.transferredFrom } : {}), ...(claim.reason ? { reason: claim.reason } : {}) });
        } catch (err) {
            claims.push({ planId, claimed: false, reason: err instanceof Error ? err.message : String(err) });
        }
    }
    const claimedCount = claims.filter(c => c.claimed).length;
    const kind: ApplyOutcome['kind'] = claimedCount === planIds.length ? 'applied'
        : (claimedCount === 0 ? 'created-empty' : 'partial');

    let recorded: RecordResult = { written: false, reason: 'this host wired no controller report store' };
    if (ports.recordProvenance) {
        try {
            recorded = await ports.recordProvenance({
                modelId: str(args.modelId),
                subject: str(args.subject),
                missionId,
                outcome: kind,
                approvedCount: planIds.length,
                claims,
            });
        } catch (err) {
            recorded = { written: false, reason: err instanceof Error ? err.message : String(err) };
        }
    }

    return { kind, missionId, approvedCount: planIds.length, claims, recorded };
}

// ═══════════════════════════════════════════════════════════════════════════
//  The parameters pass
//  (plan: the-navigator-orders-missions-into-a-schedule, subtask 3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a mission's parameter provenance is recorded, so "who chose this team"
 * and "why is this subtask third" are answerable after the fact.
 *
 * The mission row has no column for a setter, and the plan deliberately leaves
 * the home of the ordered list open ("See the open question on where the ordered
 * list lives"). The order itself is NOT stored a second time — the dependency
 * edges are the order, and a topological sort reproduces it. What is stored here
 * is the PROVENANCE only: the model, the time, and each parameter's setter, so a
 * mission the Navigator ordered is distinguishable from one in insertion order
 * and from one whose plans stated no constraint at all. It is board state (the
 * `config` table of the board's own database), not a new mission store.
 */
export const MISSION_PARAMETERS_CONFIG_KEY = 'switchboard.missions.parameters';

/** A mission row, as the board read returns it. */
export interface MissionRow {
    id: string;
    name: string;
    goal: string;
    team: string;
    maxExtraWorktrees: number;
    runState: 'not-started' | 'in-flight' | 'completed';
    /** The stored pause. A paused mission is resumed by the operator, not started here. */
    paused: boolean;
    /** Plan members. */
    plans: string[];
    /** Feature members — contained by the mission but not reorderable here. */
    features: string[];
}

/** A live team that an automated dispatch can actually reach. */
export interface LiveTeam {
    id: string;
    label: string;
    head: string;
    headRole: string;
    /** `readTeamAutomatedDispatch(def).value` — `pool` | `head-only-when-sole` | `never`. */
    policy: string;
    /** Who decided the policy: `config` | `default` | `unknown`. Never collapsed. */
    policySource: string;
}

/** A live team that cannot take the dispatch, with the reason the seam gave. */
export interface UnavailableTeam {
    id: string;
    label: string;
    head: string;
    /** VERBATIM from `resolveAutomatedDispatchExclusions`' reason map. */
    reason: string;
    /** `readTeamAutomatedDispatch(def).value`, when the seam could read it. */
    policy?: string;
    /** Who decided the policy: `config` | `default` | `unknown`. Never collapsed. */
    policySource?: string;
}

export interface ParameterRecord {
    at: string;
    modelId: string;
    /** The order the Navigator recorded — the edges are the order; this is the readback. */
    order: string[];
    setters: { order: 'navigator' | 'operator'; team: ParameterSetter; worktree: ParameterSetter };
    /** The value the NAVIGATOR last wrote for `missions.team`. */
    team: string;
    /** The value the NAVIGATOR last wrote for `missions.max_extra_worktrees`. */
    maxExtraWorktrees: number;
    finding: 'ordering-constraints-recorded' | 'no-hard-ordering-constraints';
    teamReason: string;
    worktreeReason: string;
}

/**
 * Who set a parameter. `operator` wins and is never overwritten; `unassigned`
 * means nothing was assigned and the reason says why; `default` means the column
 * default was kept because the Navigator did not judge.
 */
export type ParameterSetter = 'navigator' | 'operator' | 'unassigned' | 'default';

export interface ParameterProvenance {
    missionId: string;
    modelId: string;
    at: string;
    order: string[];
    edges: Array<{ planId: string; dependsOn: string[]; ok: boolean; error?: string }>;
    team: string;
    teamSource: ParameterSetter;
    teamReason: string;
    maxExtraWorktrees: number;
    worktreeSource: ParameterSetter;
    worktreeReason: string;
    finding: string;
    skippedHeld: string[];
    unavailableTeams: UnavailableTeam[];
}

/**
 * The ports the parameters pass needs, over and above the proposal's.
 *
 * `readAvailableTeams` is the seam the plan calls `readAvailableTeams()`: the
 * composition root runs the teamWiring reads (`readTeamAutomatedDispatch`,
 * `resolveAutomatedDispatchExclusions`) and hands the result over, so the reason
 * string the operator sees is the seam's own, verbatim, and the capability
 * continues to make no board call of its own.
 */
export interface NavigatorParameterPorts extends NavigatorPorts {
    readMission(missionId: string): Promise<MissionRow | null>;
    /** Every live team, split into those a dispatch can reach and those it cannot. */
    readAvailableTeams(): Promise<{ available: LiveTeam[]; unavailable: UnavailableTeam[] }>;
    /** `POST /kanban/dependencies` — a set-write per plan id, with the map fingerprint. */
    writeDependencies(input: { planId: string; dependsOn: string[]; mapFingerprint: string }): Promise<{ ok: boolean; error?: string; cycle?: string[] }>;
    /** `POST /kanban/mission/update`, field-scoped: an omitted field is left alone. */
    updateMission(input: { missionId: string; team?: string; maxExtraWorktrees?: number }): Promise<{ ok: boolean; error?: string }>;
    readParameterRecord(missionId: string): Promise<ParameterRecord | null>;
    writeParameterRecord(missionId: string, record: ParameterRecord): Promise<RecordResult>;
    recordParameterProvenance(entry: ParameterProvenance): Promise<RecordResult>;
    /** Injectable clock; defaults to the real one. */
    now?(): string;
}

export type ParameterOutcome =
    | {
        /** `partial` when an edge write or the mission update failed — never presented as arranged. */
        kind: 'applied' | 'partial';
        missionId: string;
        modelId: string;
        at: string;
        order: string[];
        edges: Array<{ planId: string; dependsOn: string[]; ok: boolean; error?: string }>;
        finding: 'ordering-constraints-recorded' | 'no-hard-ordering-constraints';
        team: string;
        teamSource: ParameterSetter;
        teamReason: string;
        maxExtraWorktrees: number;
        worktreeSource: ParameterSetter;
        worktreeReason: string;
        /** Members a seat took between the read and the write — never reordered. */
        skippedHeld: string[];
        unavailableTeams: UnavailableTeam[];
        /** Set when the mission row itself could not be updated. */
        updateError: string;
        recorded: RecordResult;
    }
    | { kind: 'not-found'; missionId: string }
    | { kind: 'refused-in-flight'; missionId: string; reason: string }
    | { kind: 'no-members'; missionId: string; featureMembers: string[] }
    | { kind: 'all-members-held'; missionId: string; heldIds: string[] }
    | { kind: 'cycle'; missionId: string; cycle: string[] }
    | { kind: 'invalid-reply'; missionId: string; modelId: string; reason: string }
    | { kind: 'unconfigured'; missionId: string; reason: string }
    | { kind: 'error'; missionId: string; reason: string };

function isHeld(row: NavigatorPlanRow | undefined): boolean {
    if (!row) { return false; }
    const ownerSince = row.ownerSince ?? row.owner_since ?? null;
    const completedAt = row.completedAt ?? row.completed_at ?? null;
    return !!str(ownerSince) && !str(completedAt);
}

/**
 * Kahn's algorithm with the model's declared order as the TIE-BREAK, so the sort
 * is stable and the declared order is only ever a tie-break — never a second
 * stored sequence. Returns `null` on a cycle.
 */
function topologicalOrder(members: string[], edges: Map<string, string[]>, tieBreak: string[]): string[] | null {
    const rank = new Map(tieBreak.map((id, i) => [id, i]));
    const inDegree = new Map<string, number>(members.map(id => [id, 0]));
    const dependents = new Map<string, string[]>();
    for (const id of members) {
        for (const dep of (edges.get(id) || [])) {
            if (!inDegree.has(dep)) { continue; }
            inDegree.set(id, (inDegree.get(id) || 0) + 1);
            const list = dependents.get(dep) || [];
            list.push(id);
            dependents.set(dep, list);
        }
    }
    const ready = members.filter(id => (inDegree.get(id) || 0) === 0);
    const out: string[] = [];
    while (ready.length) {
        ready.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
        const id = ready.shift() as string;
        out.push(id);
        for (const next of (dependents.get(id) || [])) {
            const left = (inDegree.get(next) || 0) - 1;
            inDegree.set(next, left);
            if (left === 0) { ready.push(next); }
        }
    }
    return out.length === members.length ? out : null;
}

/** The cycle that makes the edge set unwritable, as a path — for the report. */
function findCycle(members: string[], edges: Map<string, string[]>): string[] {
    const state = new Map<string, 0 | 1 | 2>();
    const path: string[] = [];
    const visit = (id: string): string[] | null => {
        const st = state.get(id) || 0;
        if (st === 1) { return [...path.slice(path.indexOf(id)), id]; }
        if (st === 2) { return null; }
        state.set(id, 1);
        path.push(id);
        for (const dep of (edges.get(id) || [])) {
            const found = visit(dep);
            if (found) { return found; }
        }
        path.pop();
        state.set(id, 2);
        return null;
    };
    for (const id of members) {
        const found = visit(id);
        if (found) { return found; }
    }
    return [];
}

/**
 * The fingerprint the dependency write carries, computed by the SAME function the
 * analysis pass uses (`computeMapFingerprint`) with the member set standing in
 * for the file set — one fingerprint shape, so "the persisted map is stale" is
 * one comparison rather than two that can disagree.
 */
function memberFingerprint(planId: string, memberSet: string[]): string {
    return computeMapFingerprint([{ planId, fileSet: [...memberSet].sort() }]);
}

/**
 * Which of `team` / `max_extra_worktrees` this pass may write.
 *
 * "The operator's value wins and is never silently overwritten" needs a way to
 * tell an operator's value from the Navigator's own earlier one, and the mission
 * row records neither. The rule is mechanical: this pass may write a field when
 * it is still at its column default, or when it still holds exactly the value
 * THIS pass last wrote (from the parameter record). A value that matches neither
 * was set by someone else, so it is reported as the operator's and left alone.
 */
function decideField(
    current: string | number,
    lastWritten: string | number | undefined,
    defaultValue: string | number,
    proposed: string | number,
    whenSkipped: string,
): { write: boolean; value: string | number; setter: ParameterSetter; reason: string } {
    if (current !== defaultValue && (lastWritten === undefined || current !== lastWritten)) {
        return { write: false, value: current, setter: 'operator', reason: whenSkipped };
    }
    return { write: true, value: proposed, setter: 'navigator', reason: '' };
}

const PARAMETERS_SYSTEM = [
    'You arrange the cards of ONE mission that already exists on a board of coding',
    'agents. You are given the mission, its member cards with their text, and the',
    'teams that are LIVE right now. Decide four things:',
    '1. order — every member planId, first to last.',
    '2. dependencies — the ordering constraints the cards\' OWN TEXT states.',
    '3. team — which live team takes the mission.',
    '4. worktrees — whether the members need an extra isolated worktree each.',
    'Reply with ONE JSON object and nothing else:',
    '{"order":["..."],"dependencies":[{"planId":"...","dependsOn":["..."]}],',
    ' "team":"<team id from the live list, or null>",',
    ' "worktrees":{"extra":0,"reason":"..."}}',
    'Rules you must not break:',
    '- Use ONLY planId values from the member list, and list EVERY member in order.',
    '- `dependsOn` must be a constraint the cards\' text actually states. An invented',
    '  dependency is obeyed by the queue and holds a card out of every dispatch until',
    '  its predecessor completes, so state none rather than guess. A member with no',
    '  constraint gets an empty `dependsOn` array.',
    '- `order` must agree with `dependencies`.',
    '- `team` must be an id from the live team list, or null if none fits.',
    '- `worktrees.extra` is 0 or 1. Use 0 unless the members will genuinely edit the',
    '  same files at the same time; 0 is the safe answer.',
    '- You arrange cards that already exist. You do not write, edit or retitle a plan.',
].join('\n');

/**
 * Fill in one mission's parameters: order (as dependency edges), team, and the
 * worktree decision.
 *
 * Three fences, each a bug if broken:
 *  - **This pass never stages a card.** The one method that writes queue order
 *    also moves every card to STAGING, which is starting the mission — so it
 *    belongs to the start subtask and is deliberately not named here. Recording
 *    an order and applying it are two different authorities, and this pass holds
 *    only the first.
 *  - **A cycle writes NOTHING.** Not the edges, and not the team or worktree
 *    either: a partially applied parameter set is a mission that looks arranged
 *    and is not.
 *  - **An invented dependency is worse than none.** The queue obeys these edges
 *    immediately, boardwide, so the pass writes only what the reply stated and
 *    reports "no hard ordering constraints" as a positive finding when it stated
 *    none.
 */
export async function proposeParameters(
    args: { missionId: string },
    ports: NavigatorParameterPorts,
): Promise<ParameterOutcome> {
    const missionId = str(args.missionId);
    if (!missionId) { return { kind: 'not-found', missionId }; }

    const slot = await ports.navigatorModel();
    if ('error' in slot) { return { kind: 'unconfigured', missionId, reason: slot.error }; }
    if (!slot.endpoint) {
        return { kind: 'unconfigured', missionId, reason: `no Navigator model is configured (source: ${slot.source || 'unset'})` };
    }
    const modelId = modelIdOf(slot);

    const mission = await ports.readMission(missionId);
    if (!mission) { return { kind: 'not-found', missionId }; }
    if (mission.runState === 'in-flight') {
        return { kind: 'refused-in-flight', missionId, reason: 'the mission is in flight — its order and team are settled' };
    }

    const board = (await ports.listPlans()) || [];
    const byId = new Map<string, NavigatorPlanRow>();
    for (const r of board) { const id = str(r.planId) || str(r.id); if (id) { byId.set(id, r); } }

    const memberIds = (mission.plans || []).map(str).filter(Boolean);
    const featureMembers = (mission.features || []).map(str).filter(Boolean);
    if (memberIds.length === 0) { return { kind: 'no-members', missionId, featureMembers }; }

    const heldIds = memberIds.filter(id => isHeld(byId.get(id)));
    const reorderable = memberIds.filter(id => heldIds.indexOf(id) < 0);
    if (reorderable.length === 0) { return { kind: 'all-members-held', missionId, heldIds }; }

    const teams = await ports.readAvailableTeams();

    const memberPayload: unknown[] = [];
    for (const id of reorderable) {
        const row = byId.get(id) || { planId: id };
        const body = await ports.readPlanBody(row);
        memberPayload.push({
            planId: id,
            topic: str(row.topic) || id,
            column: str(row.kanbanColumn) || str(row.kanban_column),
            body: String(body || '').slice(0, NAVIGATOR_BODY_EXCERPT_CHARS),
        });
    }

    const asked = await askNavigator(ports, slot, PARAMETERS_SYSTEM, {
        mission: { name: mission.name, goal: mission.goal },
        members: memberPayload,
        liveTeams: teams.available.map(t => ({ id: t.id, label: t.label, headRole: t.headRole })),
    });
    if (!asked.ok) { return { kind: 'error', missionId, reason: asked.reason }; }

    const reply = parseJsonReply(asked.content);
    if (!reply || typeof reply !== 'object') {
        return { kind: 'invalid-reply', missionId, modelId, reason: 'the reply was not a JSON object' };
    }

    const memberSet = new Set(reorderable);
    // `dependencies` must be PRESENT. A reply that simply omits it would
    // otherwise be recorded as "the plans state no ordering constraint" — a
    // claim the model never made, and the fallback rule applied to the one
    // finding this pass publishes. An empty ARRAY is that claim; a missing key
    // is a malformed reply.
    if (!Array.isArray(reply.dependencies)) {
        return { kind: 'invalid-reply', missionId, modelId, reason: 'the reply carried no dependencies array (an empty array is how "no constraints" is stated)' };
    }
    const rawDeps: any[] = reply.dependencies;
    const namedIds = [
        ...idList(reply.order),
        ...rawDeps.map(d => str(d && d.planId)),
        ...rawDeps.flatMap(d => idList(d && d.dependsOn)),
    ].filter(Boolean);
    const foreign = namedIds.filter(id => !memberSet.has(id));
    if (foreign.length > 0) {
        return {
            kind: 'invalid-reply', missionId, modelId,
            reason: `the reply named ${foreign.length} card(s) that are not members of this mission: ${Array.from(new Set(foreign)).join(', ')}`,
        };
    }

    const order = dedupe(idList(reply.order));
    if (order.length !== reorderable.length) {
        return {
            kind: 'invalid-reply', missionId, modelId,
            reason: `order must list every one of the ${reorderable.length} member(s) exactly once (got ${order.length})`,
        };
    }

    const edges = new Map<string, string[]>();
    for (const id of reorderable) { edges.set(id, []); }
    for (const d of rawDeps) {
        const planId = str(d && d.planId);
        if (!planId) { continue; }
        edges.set(planId, dedupe(idList(d && d.dependsOn)).filter(x => x !== planId && memberSet.has(x)));
    }

    const sorted = topologicalOrder(reorderable, edges, order);
    if (sorted === null) {
        return { kind: 'cycle', missionId, cycle: findCycle(reorderable, edges) };
    }
    if (sorted.join('\u0000') !== order.join('\u0000')) {
        return {
            kind: 'invalid-reply', missionId, modelId,
            reason: `the declared order (${order.join(' -> ')}) contradicts the declared dependencies (a sort over them gives ${sorted.join(' -> ')})`,
        };
    }

    const availableIds = new Set(teams.available.map(t => t.id));
    const requestedTeam = reply.team === null || reply.team === undefined ? '' : str(reply.team);
    let proposedTeam = '';
    let proposedTeamReason = '';
    if (requestedTeam && availableIds.has(requestedTeam)) {
        proposedTeam = requestedTeam;
    } else if (requestedTeam) {
        // Named a team that is not reachable. The exclusion reason travels
        // VERBATIM; a name that is not a team at all says that instead.
        const unavailable = teams.unavailable.find(t => t.id === requestedTeam);
        proposedTeamReason = unavailable
            ? unavailable.reason
            : `the Navigator named team '${requestedTeam}', which is not a live team on this board`;
    } else {
        proposedTeamReason = teams.available.length === 0
            ? 'no team is running — no live team can take an automated dispatch'
            : 'the Navigator did not name a team';
    }

    const worktreeReply = reply.worktrees && typeof reply.worktrees === 'object' ? reply.worktrees : null;
    const rawExtra = worktreeReply ? Number(worktreeReply.extra) : 0;
    if (!Number.isInteger(rawExtra) || rawExtra < 0 || rawExtra > 1) {
        return {
            kind: 'invalid-reply', missionId, modelId,
            reason: `worktrees.extra must be 0 or 1 for a mission (got ${JSON.stringify(worktreeReply ? worktreeReply.extra : null)})`,
        };
    }
    const proposedWorktrees = rawExtra;
    const worktreeReason = worktreeReply ? str(worktreeReply.reason) : '';

    // ── Write. Ownership and membership are RE-READ here, not trusted from the
    //    set the model was shown: a seat can take a card between the two. ──
    const boardNow = (await ports.listPlans()) || [];
    const byIdNow = new Map<string, NavigatorPlanRow>();
    for (const r of boardNow) { const id = str(r.planId) || str(r.id); if (id) { byIdNow.set(id, r); } }
    const heldNow = new Set(reorderable.filter(id => isHeld(byIdNow.get(id))));
    const toWrite = reorderable.filter(id => !heldNow.has(id));
    const skippedHeld = Array.from(new Set([...heldIds, ...Array.from(heldNow)]));

    const writtenEdges: Array<{ planId: string; dependsOn: string[]; ok: boolean; error?: string }> = [];
    for (const id of toWrite) {
        const dependsOn = (edges.get(id) || []).filter(d => d !== id);
        const res = await ports.writeDependencies({
            planId: id,
            dependsOn,
            // The fingerprint is the mission's MEMBER set, not just the members
            // this pass mapped: a later pass recomputes it from the membership it
            // sees, and a member joining or leaving must make the map stale.
            mapFingerprint: memberFingerprint(id, memberIds),
        });
        writtenEdges.push({ planId: id, dependsOn, ok: !!res.ok, ...(res.error ? { error: res.error } : {}) });
    }

    const record = await ports.readParameterRecord(missionId);
    const teamDecision = decideField(
        mission.team, record ? record.team : undefined, '', proposedTeam,
        'left as the operator set it',
    );
    const worktreeDecision = decideField(
        mission.maxExtraWorktrees, record ? record.maxExtraWorktrees : undefined, 0, proposedWorktrees,
        'left as the operator set it',
    );

    const update: { missionId: string; team?: string; maxExtraWorktrees?: number } = { missionId };
    // Only a field whose decided value DIFFERS is sent. Rewriting a field with
    // the value it already holds would bump `missions.updated_at`, and
    // `updated_at` is what the panel's "moved Nm ago" and the mission watch read
    // as movement — a pass that decided nothing new must not look like one that
    // moved the mission.
    if (teamDecision.write && String(teamDecision.value) !== mission.team) { update.team = String(teamDecision.value); }
    if (worktreeDecision.write && Number(worktreeDecision.value) !== mission.maxExtraWorktrees) {
        update.maxExtraWorktrees = Number(worktreeDecision.value);
    }
    let updateError = '';
    if (update.team !== undefined || update.maxExtraWorktrees !== undefined) {
        const res = await ports.updateMission(update);
        if (!res.ok) { updateError = res.error || 'the board refused the mission update'; }
    }

    const finding: 'ordering-constraints-recorded' | 'no-hard-ordering-constraints' =
        writtenEdges.some(e => e.dependsOn.length > 0) ? 'ordering-constraints-recorded' : 'no-hard-ordering-constraints';
    const at = ports.now ? ports.now() : new Date().toISOString();

    const teamValue = String(teamDecision.value);
    const teamSource: ParameterSetter = !teamDecision.write ? 'operator' : (teamValue ? 'navigator' : 'unassigned');
    const worktreeSource: ParameterSetter = !worktreeDecision.write ? 'operator' : (worktreeReply ? 'navigator' : 'default');
    const teamReason = teamDecision.write ? proposedTeamReason : teamDecision.reason;
    const worktreeReasonFinal = worktreeDecision.write ? worktreeReason : worktreeDecision.reason;

    const parameterRecord: ParameterRecord = {
        at,
        modelId,
        order: order.filter(id => !heldNow.has(id)),
        setters: { order: 'navigator', team: teamSource, worktree: worktreeSource },
        team: teamDecision.write ? teamValue : (record ? record.team : ''),
        maxExtraWorktrees: worktreeDecision.write ? Number(worktreeDecision.value) : (record ? record.maxExtraWorktrees : mission.maxExtraWorktrees),
        finding,
        teamReason,
        worktreeReason: worktreeReasonFinal,
    };
    let recorded: RecordResult = { written: false, reason: 'this host wired no parameter record store' };
    try {
        recorded = await ports.writeParameterRecord(missionId, parameterRecord);
    } catch (err) {
        recorded = { written: false, reason: err instanceof Error ? err.message : String(err) };
    }
    let reported: RecordResult = { written: false, reason: 'this host wired no controller report store' };
    try {
        reported = await ports.recordParameterProvenance({
            missionId, modelId, at, order: parameterRecord.order, edges: writtenEdges,
            team: teamValue, teamSource, teamReason,
            maxExtraWorktrees: Number(worktreeDecision.value), worktreeSource, worktreeReason: worktreeReasonFinal,
            finding, skippedHeld, unavailableTeams: teams.unavailable,
        });
    } catch (err) {
        reported = { written: false, reason: err instanceof Error ? err.message : String(err) };
    }

    // A pass where an edge write or the mission update failed has NOT arranged
    // the mission, and saying "applied" would present a half-arranged mission as
    // whole — the same failure the proposal subtask reports as `partial`.
    const partial = updateError !== '' || writtenEdges.some(e => !e.ok);
    return {
        kind: partial ? 'partial' : 'applied',
        missionId,
        modelId,
        at,
        order: parameterRecord.order,
        edges: writtenEdges,
        finding,
        team: teamValue,
        teamSource,
        teamReason,
        maxExtraWorktrees: Number(worktreeDecision.value),
        worktreeSource,
        worktreeReason: worktreeReasonFinal,
        skippedHeld,
        unavailableTeams: teams.unavailable,
        updateError,
        recorded: reported,
    };
}

/** One string per state, so a refusal never reads like a quiet success. */
export function parameterOutcomeMessage(outcome: ParameterOutcome): string {
    switch (outcome.kind) {
        case 'applied':
        case 'partial': {
            const bits: string[] = [];
            bits.push(outcome.finding === 'ordering-constraints-recorded'
                ? `Order recorded over ${outcome.order.length} card(s) as dependency edges.`
                : 'No hard ordering constraints — zero edges written, and that is the finding, not a missing pass.');
            if (outcome.team) {
                bits.push(`Team: ${outcome.team}.`);
            } else {
                bits.push(`No team assigned — ${outcome.teamReason}.`);
            }
            bits.push(`Worktrees: ${outcome.maxExtraWorktrees === 0 ? 'none (the fail-safe default)' : outcome.maxExtraWorktrees + ' extra'}${outcome.worktreeReason ? ` — ${outcome.worktreeReason}` : ''}.`);
            if (outcome.teamSource === 'operator' || outcome.worktreeSource === 'operator') {
                bits.push('A hand-set value was left alone.');
            }
            if (outcome.skippedHeld.length) {
                bits.push(`${outcome.skippedHeld.length} held card(s) excluded from reordering.`);
            }
            const failed = outcome.edges.filter(e => !e.ok);
            if (failed.length) {
                bits.push(`${failed.length} edge write(s) FAILED: ${failed.map(e => `${e.planId} (${e.error || 'refused'})`).join(', ')}`);
            }
            if (outcome.updateError) {
                bits.push(`The mission update FAILED: ${outcome.updateError}`);
            }
            if (outcome.kind === 'partial') {
                bits.push('The mission is only PARTLY arranged.');
            }
            if (!outcome.recorded.written) {
                bits.push(`Provenance not recorded: ${outcome.recorded.reason || 'unknown reason'}`);
            }
            return bits.join(' ');
        }
        case 'not-found':
            return `No mission '${outcome.missionId}' on this board.`;
        case 'refused-in-flight':
            return `Refused: ${outcome.reason}. Nothing was written.`;
        case 'no-members':
            return outcome.featureMembers.length
                ? `The mission holds ${outcome.featureMembers.length} feature(s) and no loose plans, so there is nothing to order.`
                : 'The mission has no members, so there is nothing to order.';
        case 'all-members-held':
            return `Every member is being worked on (${outcome.heldIds.join(', ')}) — their order and team are settled, and nothing was written.`;
        case 'cycle':
            return `Dependency cycle refused: ${outcome.cycle.length ? outcome.cycle.join(' -> ') : 'a cycle among the members'}. Nothing was written — not the edges, not the team, not the worktree.`;
        case 'invalid-reply':
            return `The Navigator's reply was invalid and nothing was written: ${outcome.reason}`;
        case 'unconfigured':
            return `The Navigator could not be asked: ${outcome.reason}`;
        case 'error':
            return `The parameters pass failed: ${outcome.reason}`;
    }
}

/** The three (plus one) states, as the ONE string each surface renders. */
export function navigatorOutcomeMessage(outcome: ProposeOutcome): string {
    switch (outcome.kind) {
        case 'proposal':
            return outcome.proposal.truncated
                ? `Proposed ${outcome.proposal.planIds.length} card(s); ${outcome.proposal.truncated.dropped} more were dropped — a proposal is capped at ${NAVIGATOR_PROPOSAL_CAP}.`
                : `Proposed ${outcome.proposal.planIds.length} card(s).`;
        case 'cold-board':
            return outcome.truncated
                ? `Proposed ${outcome.groupings.length} grouping(s); ${outcome.truncated.dropped} more were dropped — a cold-board pass is capped at ${NAVIGATOR_COLD_BOARD_CAP}.`
                : `Proposed ${outcome.groupings.length} grouping(s).`;
        case 'no-candidates':
            return 'No eligible cards for that subject.';
        case 'invalid-reply':
            return `The Navigator's reply was invalid and was not proposed: ${outcome.reason}`;
        case 'unconfigured':
            return `The Navigator could not be asked: ${outcome.reason}`;
        case 'error':
            return `The proposal pass failed: ${outcome.reason}`;
    }
}

export function applyOutcomeMessage(outcome: ApplyOutcome): string {
    const refused = outcome.claims.filter(c => !c.claimed);
    switch (outcome.kind) {
        case 'applied':
            return `Mission ${outcome.missionId} created with ${outcome.approvedCount} card(s).`;
        case 'partial':
            return `Mission ${outcome.missionId} was created with ${outcome.approvedCount - refused.length} of ${outcome.approvedCount} card(s). These did not land: ${refused.map(c => `${c.planId} (${c.reason || 'refused'})`).join(', ')}`;
        case 'created-empty':
            return `Mission ${outcome.missionId} was created but no card could be claimed: ${refused.map(c => `${c.planId} (${c.reason || 'refused'})`).join(', ')}. It is empty — delete it if you did not want it.`;
        case 'error':
            return `The mission could not be created: ${outcome.reason}`;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  The start pass
//  (plan: the-navigator-starts-the-mission-it-set-up, subtask 4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How the staging order was arrived at. Three states, because they are three
 * different facts and the plan forbids two of them rendering alike:
 *
 *  - `dependency-order` — `plan_dependencies` edges covered the member set and a
 *    topological sort produced the order. This is the only case where the order
 *    is anything but the mission's own insertion order.
 *  - `no-dependencies-stated` — no edges, but the parameters pass ran and
 *    recorded `no-hard-ordering-constraints`. The cards genuinely have no
 *    ordering constraints between them, so board order is correct.
 *  - `no-dependency-order-recorded` — no edges and no parameter record: the
 *    parameters pass never ordered this mission. Staging proceeds in board order
 *    and that is a STATED FINDING, because with no edges the queue pops members
 *    in board order — the round-wasting failure the parameters subtask exists to
 *    prevent. It is stated, not silently taken.
 */
export type StartOrderSource = 'dependency-order' | 'no-dependencies-stated' | 'no-dependency-order-recorded';

export interface StartProvenance {
    missionId: string;
    modelId: string;
    authorSource: string;
    at: string;
    approvedBy: 'operator';
    team: string;
    teamPolicy: string;
    teamPolicySource: string;
    orderSource: StartOrderSource;
    finding: string | null;
    stagedIds: string[];
    skippedHeld: string[];
    skippedCompleted: string[];
    dispatchedCard: string | null;
    dispatchOutcome: string;
    dispatchError: string | null;
    readyWritten: boolean;
}

/**
 * The ports the start pass needs, over and above the parameters pass's.
 *
 * `stageMembers` is the board's own staging write — the one that assigns
 * `plans.column_order` above the workspace-wide STAGING maximum and moves the
 * cards there — reached as a port rather than through a new HTTP route, because
 * staging is what the webview's drag-into-STAGING already does in-process and
 * the plan names the method, not a route, for it. The method's name is
 * deliberately not written here: it is the one call this module must never make
 * by accident, and the parameters pass's own contract pins its absence.
 */
export interface NavigatorStartPorts extends NavigatorParameterPorts {
    /** `GET /kanban/dependencies` over the member set, as a planId → predecessors map. */
    readDependencies(planIds: string[]): Promise<Record<string, string[]>>;
    /** The board's staging write: column_order above the global STAGING maximum, then STAGING. */
    stageMembers(input: { missionId: string; orderedPlanIds: string[] }): Promise<{ ok: boolean; error?: string }>;
    /** `POST /kanban/mission/update` with `ready` — the approval record. */
    markReady(missionId: string): Promise<{ ok: boolean; error?: string }>;
    /** `POST /kanban/dispatch` for one card. */
    dispatchCard(input: { planId: string; seat?: string }): Promise<{ status: number; payload: any }>;
    /** The controller report append for a start. */
    recordStartProvenance(entry: StartProvenance): Promise<RecordResult>;
}

export type StartOutcome =
    | {
        /** `partial-start` when a write failed after staging began — never presented as a clean start. */
        kind: 'started' | 'partial-start';
        missionId: string;
        modelId: string;
        authorSource: string;
        at: string;
        team: string;
        teamPolicy: string;
        teamPolicySource: string;
        order: string[];
        orderSource: StartOrderSource;
        /** Non-null when the order was board order for want of recorded edges. */
        finding: string | null;
        stagedIds: string[];
        skippedHeld: string[];
        skippedCompleted: string[];
        dispatchedCard: string | null;
        dispatchOutcome: 'delivered' | 'already-in-flight' | 'failed' | 'not-attempted';
        dispatchError: string | null;
        readyWritten: boolean;
        readyError: string | null;
        /** Cards the board actually holds in STAGING when a write failed. */
        actuallyStaged: string[];
        recorded: RecordResult;
    }
    | { kind: 'not-found'; missionId: string }
    | { kind: 'already-started'; missionId: string; runState: string; reason: string }
    | { kind: 'paused'; missionId: string; reason: string }
    | { kind: 'no-members'; missionId: string; reason: string }
    | { kind: 'no-team'; missionId: string; reason: string }
    | { kind: 'team-unavailable'; missionId: string; team: string; reason: string }
    | { kind: 'cycle'; missionId: string; cycle: string[]; reason: string }
    | { kind: 'nothing-to-start'; missionId: string; heldIds: string[]; completedIds: string[]; reason: string }
    | { kind: 'error'; missionId: string; reason: string };

/**
 * Start the mission the operator just approved.
 *
 * In order: check everything, then write in a fixed order, then stop.
 *
 * Three fences:
 *  - **Every check precedes every write.** Staging has no inverse, so a start
 *    that stages and then fails has left a mission the queue will run anyway.
 *    A refusal is therefore TOTAL: no staging, no `ready`, no dispatch.
 *  - **The staging order is the topological sort of the recorded edges.** With
 *    no edges the queue pops members in board order, so that case is stated as a
 *    finding rather than taken silently.
 *  - **One card, then stop.** The Navigator dispatches the first member and
 *    hands the rest to the board's own automated dispatch. It does not feed the
 *    queue — that is the cross-mission authority this pass deliberately lacks.
 */
export async function startMission(
    args: { missionId: string },
    ports: NavigatorStartPorts,
): Promise<StartOutcome> {
    const missionId = str(args.missionId);
    if (!missionId) { return { kind: 'not-found', missionId }; }

    // The Navigator is the AUTHOR OF RECORD, not the decider — the operator's
    // approval is. No model call is made, and an unset slot is tagged rather
    // than silently blank: a dispatch nobody can account for is the thing that
    // makes automation frightening.
    const slot = await ports.navigatorModel();
    const modelId = 'error' in slot ? '' : modelIdOf(slot);
    const authorSource = 'error' in slot ? `navigator-slot-unreadable: ${slot.error}`
        : (slot.endpoint ? `navigator-slot: ${slot.source}` : `navigator-slot-unset: ${slot.source}`);

    const mission = await ports.readMission(missionId);
    if (!mission) { return { kind: 'not-found', missionId }; }
    if (mission.runState !== 'not-started') {
        return { kind: 'already-started', missionId, runState: mission.runState, reason: `this mission is ${mission.runState} — a mission is started once` };
    }
    if (mission.paused) {
        return { kind: 'paused', missionId, reason: 'this mission is paused — it is resumed by the operator, which is a different gesture' };
    }

    const memberIds = (mission.plans || []).map(str).filter(Boolean);
    if (memberIds.length === 0) {
        return { kind: 'no-members', missionId, reason: mission.features.length ? 'this mission holds features and no loose plans, so there is nothing to stage' : 'this mission has no members' };
    }

    // ── The team, re-checked against the LIVE fleet rather than trusted from
    //    the row: policy can change between the parameters pass and the start. ──
    const teamId = str(mission.team);
    if (!teamId) {
        return { kind: 'no-team', missionId, reason: 'no team is assigned to this mission — a mission that cannot be carried is not started' };
    }
    const teams = await ports.readAvailableTeams();
    const reachable = teams.available.find(t => t.id === teamId);
    let teamHead = '';
    let teamPolicy = '';
    let teamPolicySource = '';
    if (reachable) {
        if (reachable.policy === 'never') {
            return { kind: 'team-unavailable', missionId, team: teamId, reason: `team '${reachable.label}' will not carry this mission — automatedDispatch=never (source: ${reachable.policySource})` };
        }
        teamHead = reachable.head;
        teamPolicy = reachable.policy;
        teamPolicySource = reachable.policySource;
    } else {
        const blocked = teams.unavailable.find(t => t.id === teamId);
        return {
            kind: 'team-unavailable', missionId, team: teamId,
            reason: blocked
                ? `team '${blocked.label}' will not carry this mission — ${blocked.reason}${blocked.policy ? ` (policy: ${blocked.policy}, source: ${blocked.policySource || 'unknown'})` : ''}`
                : `team '${teamId}' is not live on this board — seat it before starting the mission`,
        };
    }

    // ── The order: the topological sort of the recorded edges, or a stated
    //    finding when there are none to sort. ──
    const depsByPlan = await ports.readDependencies(memberIds);
    const memberSet = new Set(memberIds);
    const edgeMap = new Map<string, string[]>();
    let edgeCount = 0;
    for (const id of memberIds) {
        const deps = (depsByPlan[id] || []).map(str).filter(d => d && d !== id && memberSet.has(d));
        edgeMap.set(id, deps);
        edgeCount += deps.length;
    }
    const record = await ports.readParameterRecord(missionId);
    let order: string[];
    let orderSource: StartOrderSource;
    let finding: string | null = null;
    if (edgeCount > 0) {
        const sorted = topologicalOrder(memberIds, edgeMap, memberIds);
        if (sorted === null) {
            return { kind: 'cycle', missionId, cycle: findCycle(memberIds, edgeMap), reason: 'the recorded dependency edges contain a cycle — nothing can be staged in order' };
        }
        order = sorted;
        orderSource = 'dependency-order';
    } else {
        order = [...memberIds];
        if (record && record.finding === 'no-hard-ordering-constraints') {
            orderSource = 'no-dependencies-stated';
        } else {
            orderSource = 'no-dependency-order-recorded';
            finding = 'no dependency order was recorded for this mission — it will be staged in board order';
        }
    }

    // ── Held and completed members are excluded from the staging list and NAMED,
    //    never silently dropped and never a reason to refuse the whole start. ──
    const board = (await ports.listPlans()) || [];
    const byId = new Map<string, NavigatorPlanRow>();
    for (const r of board) { const id = str(r.planId) || str(r.id); if (id) { byId.set(id, r); } }
    const skippedCompleted = order.filter(id => !!str((byId.get(id) || {}).completedAt ?? (byId.get(id) || {}).completed_at));
    const skippedHeld = order.filter(id => !skippedCompleted.includes(id) && isHeld(byId.get(id)));
    const stagedOrder = order.filter(id => !skippedHeld.includes(id) && !skippedCompleted.includes(id));
    if (stagedOrder.length === 0) {
        return {
            kind: 'nothing-to-start', missionId, heldIds: skippedHeld, completedIds: skippedCompleted,
            reason: skippedCompleted.length === memberIds.length
                ? 'every member has already completed — there is nothing left to start'
                : 'every remaining member is already being worked on — there is nothing left to stage',
        };
    }

    const at = ports.now ? ports.now() : new Date().toISOString();
    const base = {
        missionId, modelId, authorSource, at, team: teamId, teamPolicy, teamPolicySource,
        order, orderSource, finding, stagedIds: stagedOrder, skippedHeld, skippedCompleted,
    };

    const finish = async (
        kind: 'started' | 'partial-start',
        rest: {
            dispatchedCard: string | null;
            dispatchOutcome: 'delivered' | 'already-in-flight' | 'failed' | 'not-attempted';
            dispatchError: string | null;
            readyWritten: boolean;
            readyError: string | null;
            actuallyStaged: string[];
        },
    ): Promise<StartOutcome> => {
        let recorded: RecordResult = { written: false, reason: 'this host wired no controller report store' };
        try {
            recorded = await ports.recordStartProvenance({
                missionId, modelId, authorSource, at, approvedBy: 'operator',
                team: teamId, teamPolicy, teamPolicySource, orderSource, finding,
                stagedIds: stagedOrder, skippedHeld, skippedCompleted,
                dispatchedCard: rest.dispatchedCard, dispatchOutcome: rest.dispatchOutcome,
                dispatchError: rest.dispatchError, readyWritten: rest.readyWritten,
            });
        } catch (err) {
            recorded = { written: false, reason: err instanceof Error ? err.message : String(err) };
        }
        return { kind, ...base, ...rest, recorded } as StartOutcome;
    };

    // ── The race: a seat can take a member, or the mission can begin, between
    //    the checks above and the staging write. Re-read immediately before it. ──
    const missionNow = await ports.readMission(missionId);
    if (!missionNow || missionNow.runState !== 'not-started') {
        return {
            kind: 'already-started', missionId,
            runState: missionNow ? missionNow.runState : 'gone',
            reason: 'the mission began between the check and the staging write — nothing was staged',
        };
    }

    // 1. STAGE. Everything above is a check; this is the first write.
    const staged = await ports.stageMembers({ missionId, orderedPlanIds: stagedOrder });
    if (!staged.ok) {
        // Staging is not transactional, so a failure may have moved SOME cards.
        // Report exactly which ones are in STAGING, because the queue will act
        // on them regardless.
        const after = (await ports.listPlans()) || [];
        const actuallyStaged = stagedOrder.filter(id => {
            const r = after.find(x => (str(x.planId) || str(x.id)) === id);
            return !!r && str(r.kanbanColumn) === 'STAGING';
        });
        return finish('partial-start', {
            dispatchedCard: null, dispatchOutcome: 'not-attempted',
            dispatchError: staged.error || 'the board refused the staging write',
            readyWritten: false, readyError: null, actuallyStaged,
        });
    }

    // 2. MARK READY — the approval, recorded through the existing route.
    const ready = await ports.markReady(missionId);
    if (!ready.ok) {
        return finish('partial-start', {
            dispatchedCard: null, dispatchOutcome: 'not-attempted',
            dispatchError: null, readyWritten: false,
            readyError: ready.error || 'the board refused the mission update',
            actuallyStaged: stagedOrder,
        });
    }

    // 3. DISPATCH THE HEAD — one card, then stop.
    const head = stagedOrder[0];
    let dispatchedCard: string | null = null;
    let dispatchOutcome: 'delivered' | 'already-in-flight' | 'failed' | 'not-attempted' = 'not-attempted';
    let dispatchError: string | null = null;
    try {
        const res = await ports.dispatchCard({ planId: head, ...(teamHead ? { seat: teamHead } : {}) });
        const payload = res?.payload || {};
        const errText = str(payload.error);
        // The queue may have popped the head between staging and this call. That
        // is benign — the mission started, which is the thing being asserted —
        // so a "already owned / already in flight" refusal is SUCCESS, not an
        // error to report.
        if (payload.success !== false && res.status < 400) {
            dispatchedCard = head;
            dispatchOutcome = 'delivered';
        } else if (res.status === 409 || /already|in flight|owned/i.test(errText)) {
            dispatchedCard = head;
            dispatchOutcome = 'already-in-flight';
        } else {
            dispatchError = errText || `the dispatch answered ${res.status}`;
            dispatchOutcome = 'failed';
        }
    } catch (err) {
        dispatchError = err instanceof Error ? err.message : String(err);
        dispatchOutcome = 'failed';
    }

    const kind: 'started' | 'partial-start' = dispatchOutcome === 'failed' ? 'partial-start' : 'started';
    return finish(kind, {
        dispatchedCard, dispatchOutcome, dispatchError,
        readyWritten: true, readyError: null, actuallyStaged: stagedOrder,
    });
}

/** One string per state, so a refusal names its own reason and never reads generic. */
export function startOutcomeMessage(outcome: StartOutcome): string {
    switch (outcome.kind) {
        case 'started':
        case 'partial-start': {
            const bits: string[] = [];
            bits.push(`${outcome.stagedIds.length} card(s) staged in ${outcome.orderSource === 'dependency-order' ? 'dependency order' : 'board order'}.`);
            if (outcome.finding) { bits.push(`STATED FINDING: ${outcome.finding}.`); }
            if (outcome.skippedHeld.length) { bits.push(`${outcome.skippedHeld.length} card(s) already being worked on, left alone.`); }
            if (outcome.skippedCompleted.length) { bits.push(`${outcome.skippedCompleted.length} card(s) already complete, left alone.`); }
            if (outcome.dispatchedCard) {
                bits.push(outcome.dispatchOutcome === 'already-in-flight'
                    ? `Card ${outcome.dispatchedCard} was already picked up by the queue — the mission is running.`
                    : `Dispatched ${outcome.dispatchedCard} to ${outcome.team} (automatedDispatch=${outcome.teamPolicy}, source: ${outcome.teamPolicySource}).`);
            } else {
                bits.push(`No card was dispatched${outcome.dispatchError ? `: ${outcome.dispatchError}` : ''}.`);
            }
            bits.push(outcome.readyWritten ? 'The mission is marked ready.' : `The mission is NOT marked ready: ${outcome.readyError || 'the update failed'}.`);
            bits.push('The rest of the mission is carried by automated dispatch — the Navigator does nothing further.');
            if (outcome.kind === 'partial-start') {
                bits.push(`PARTIAL START — the board holds these in STAGING: ${outcome.actuallyStaged.join(', ')}.`);
            }
            if (!outcome.recorded.written) { bits.push(`Provenance not recorded: ${outcome.recorded.reason || 'unknown reason'}`); }
            return bits.join(' ');
        }
        case 'not-found':
            return `No mission '${outcome.missionId}' on this board.`;
        case 'already-started':
            return `Refused: ${outcome.reason}. Nothing was written.`;
        case 'paused':
            return `Refused: ${outcome.reason}. Nothing was written.`;
        case 'no-members':
            return `Refused: ${outcome.reason}. Nothing was written.`;
        case 'no-team':
            return `Refused: ${outcome.reason}. Nothing was written.`;
        case 'team-unavailable':
            return `Refused: ${outcome.reason}. Nothing was staged, nothing marked ready, nothing dispatched.`;
        case 'cycle':
            return `Refused: ${outcome.reason}${outcome.cycle.length ? ` (${outcome.cycle.join(' -> ')})` : ''}. Nothing was written.`;
        case 'nothing-to-start':
            return `Refused: ${outcome.reason}. Nothing was written.`;
        case 'error':
            return `The start failed: ${outcome.reason}. Nothing was written.`;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  The outside-prerequisite pass
//  (plan: a-prerequisite-outside-the-feature-is-the-navigators-problem)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What became of ONE prerequisite a feature's prose named outside itself.
 *
 * Five states, kept distinct because they are five different situations for the
 * operator and the plan forbids any two rendering alike:
 *
 *  - `complete` — the card exists and has asserted completion. No edge is
 *    needed (there is nothing to gate) and nothing is dispatched. The authoring
 *    breach is recorded anyway.
 *  - `exists-unfinished` — the card exists and is unfinished. The edge is
 *    written AND the card is dispatched. The edge is the durable record; the
 *    dispatch is the intervention, and it is the half that works for a lead
 *    driving by hand — such a lead never pops, so it never reads an edge.
 *  - `absent` — no card on the board matches the reference exactly. A feature
 *    depends on work nobody has written.
 *  - `unresolved` — the reference matched more than one card, or matched one
 *    card that the prose attributes to no single subtask. Reported, never
 *    guessed: an approximate match writes an edge onto the wrong card and holds
 *    real work out of every pop.
 *  - `cycle` — the edge would close a loop through a card outside the feature.
 *    Refused; nothing is written.
 */
export type OutsidePrerequisiteKind = 'complete' | 'exists-unfinished' | 'absent' | 'unresolved' | 'cycle';

/** One prerequisite reference, and everything that happened to it. */
export interface PrerequisiteResolution {
    /** The reference exactly as the prose wrote it. */
    named: string;
    /** The subtask the prose attributes it to; `''` when the prose names none. */
    dependentId: string;
    dependentTitle: string;
    /** The matched card; `''` for `absent` and `unresolved`. */
    prerequisiteId: string;
    prerequisiteTitle: string;
    prerequisiteColumn: string;
    outcome: OutsidePrerequisiteKind;
    reason: string;
    /** The ids an exact match returned, when it returned more than one. */
    candidates: string[];
    edgeWritten: boolean;
    edgeError: string;
    dispatched: boolean;
    dispatchOutcome: 'delivered' | 'already-in-flight' | 'failed' | 'not-attempted';
    dispatchError: string;
}

/**
 * One report entry. ONE per outside prerequisite found, so "how many authoring
 * breaches were recorded" is a count of entries and not a count inside an
 * aggregate — a breach absorbed into a summary line is a breach nobody sees.
 * A feature with no outside prerequisite produces exactly one entry, tagged
 * `none-found`, so an empty report is a CLAIM with a source rather than a
 * silence that reads the same as a pass that never ran.
 */
export interface PrerequisiteProvenance {
    featureId: string;
    featureTitle: string;
    at: string;
    modelId: string;
    authorSource: string;
    named: string;
    dependentId: string;
    dependentTitle: string;
    prerequisiteId: string;
    prerequisiteTitle: string;
    prerequisiteColumn: string;
    outcome: OutsidePrerequisiteKind | 'none-found';
    reason: string;
    candidates: string[];
    edgeWritten: boolean;
    edgeError: string;
    dispatched: boolean;
    dispatchOutcome: string;
    dispatchError: string;
    /** The feature named a prerequisite outside itself — true for every found reference. */
    authoringBreach: boolean;
}

export type OutsidePrerequisiteOutcome =
    | {
        /** `partial` when an edge write or a dispatch failed — never presented as resolved. */
        kind: 'resolved' | 'partial' | 'none-found';
        featureId: string;
        featureTitle: string;
        at: string;
        modelId: string;
        authorSource: string;
        resolutions: PrerequisiteResolution[];
        recorded: RecordResult[];
    }
    | { kind: 'not-found'; featureId: string }
    | { kind: 'error'; featureId: string; reason: string };

/**
 * The ports the outside-prerequisite pass needs.
 *
 * `listPlans` is the match universe — the same `GET /kanban/plans` read every
 * other Navigator pass makes, so "which board did the match look at" has one
 * answer. `readSubtasks` is `GET /kanban/plans?featureId=` (unfiltered by the
 * dormant window), because the set a prerequisite must be OUTSIDE of cannot be
 * a windowed view of it.
 */
export interface NavigatorPrerequisitePorts {
    listPlans(): Promise<NavigatorPlanRow[]>;
    navigatorModel(): Promise<NavigatorModelSlot | { error: string }>;
    readFeature(featureId: string): Promise<NavigatorPlanRow | null>;
    readSubtasks(featureId: string): Promise<NavigatorPlanRow[]>;
    readPlanBody(row: NavigatorPlanRow): Promise<string>;
    /** `GET /kanban/dependencies` over a set of ids, as a planId → predecessors map. */
    readDependencies(planIds: string[]): Promise<Record<string, string[]>>;
    /** `POST /kanban/dependencies` — a SET-write per plan id, with the map fingerprint. */
    writeDependencies(input: { planId: string; dependsOn: string[]; mapFingerprint: string }): Promise<{ ok: boolean; error?: string; cycle?: string[] }>;
    /** `POST /kanban/dispatch` for one card, with no seat pinned — the board routes it. */
    dispatchCard(input: { planId: string }): Promise<{ status: number; payload: any }>;
    recordPrerequisiteProvenance(entry: PrerequisiteProvenance): Promise<RecordResult>;
    now?(): string;
}

/** The section of a feature file this pass reads. The prose is an INPUT, never the store. */
const DEPENDENCIES_HEADING = /^##\s+Dependencies\b/i;
const NEXT_SECTION_HEADING = /^##\s+\S/;

function baseName(p: string): string {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * The comparison key for a name. Case, punctuation, spacing and a trailing
 * `.md` are formatting, not identity: `the-board-restarts-only-when-it-stops-
 * answering`, its title and its filename are ONE name. Nothing else is folded —
 * a near-miss title normalises to a different key and does NOT match, which is
 * the whole point of matching exactly rather than approximately.
 */
function normalizeName(s: string): string {
    return String(s || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/\.md$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** The `## Dependencies` / `## Dependencies & sequencing` section, verbatim, headings excluded. */
function dependenciesSection(body: string): string {
    const lines = String(body || '').split(/\r?\n/);
    const out: string[] = [];
    let inside = false;
    for (const line of lines) {
        if (DEPENDENCIES_HEADING.test(line.trim())) { inside = true; continue; }
        if (!inside) { continue; }
        if (NEXT_SECTION_HEADING.test(line.trim())) { break; }
        out.push(line);
    }
    return out.join('\n');
}

/**
 * The section as STATEMENTS — a bullet, a numbered item or a table row each
 * stands alone; a paragraph block is one statement. Attribution is per
 * statement, because "the subtask named beside this prerequisite" is a fact
 * about one sentence, not about the whole section.
 */
function sectionStatements(section: string): string[] {
    const statements: string[] = [];
    let current: string[] = [];
    let inItem = false;
    const flush = () => { if (current.length) { statements.push(current.join(' ').trim()); } current = []; inItem = false; };
    for (const raw of String(section || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) { flush(); continue; }
        if (/^#{1,6}\s/.test(line)) { flush(); continue; }
        const isItem = line.startsWith('|') || /^([-*+]|\d+[.)])\s/.test(line);
        if (isItem && inItem) { flush(); }
        current.push(line);
        inItem = inItem || isItem;
    }
    flush();
    return statements.filter(Boolean);
}

function codeSpans(text: string): string[] {
    const out: string[] = [];
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { out.push(m[1]); }
    return out;
}

/** The ids an exact name match returned, in board order. */
function matchCardsByName(index: Map<string, NavigatorPlanRow[]>, named: string): NavigatorPlanRow[] {
    const key = normalizeName(named);
    return key ? (index.get(key) || []) : [];
}

function isPlanLikeRef(named: string, index: Map<string, NavigatorPlanRow[]>): boolean {
    if (/\.md$/i.test(String(named || '').trim())) { return true; }
    const key = normalizeName(named);
    return !!key && index.has(key);
}

/**
 * Walk the live edges from `prerequisiteId` and report whether the proposed
 * `dependentId -> prerequisiteId` edge would close a loop through the UNION of
 * the feature's edges and the new one — not the new edge in isolation, because
 * a loop closed through a card the parameters pass never examined is still a
 * loop, and it makes every card in it permanently undispatchable.
 *
 * The cycle detector is `findCycle`, the same function the parameters pass
 * sorts against — one implementation, not two that can disagree.
 */
async function unionCycle(
    proposed: { planId: string; dependsOn: string[] },
    seedIds: string[],
    readDeps: (planIds: string[]) => Promise<Record<string, string[]>>,
): Promise<string[]> {
    const edges = new Map<string, string[]>();
    const nodes = new Set<string>(seedIds.map(str).filter(Boolean));
    nodes.add(proposed.planId);
    let frontier = Array.from(nodes);
    while (frontier.length) {
        const read = await readDeps(frontier);
        const next: string[] = [];
        for (const id of frontier) {
            const list = dedupe(((read || {})[id] || []).map(str).filter(Boolean));
            edges.set(id, list);
            for (const dep of list) {
                if (nodes.has(dep)) { continue; }
                nodes.add(dep);
                next.push(dep);
            }
        }
        frontier = next;
    }
    edges.set(proposed.planId, dedupe([...(edges.get(proposed.planId) || []), ...proposed.dependsOn]));
    return findCycle(Array.from(nodes), edges);
}

/**
 * Resolve the prerequisites a feature's prose names OUTSIDE its own subtask set.
 *
 * The queue's gate (`isDependencyReady`) gates the queue POP, and a lead driving
 * a feature by hand never pops — so an edge alone would sit in
 * `plan_dependencies` unread by the very caller that was blocked. The
 * intervention is therefore the DISPATCH: a board action that needs no
 * cooperation from the lead, no prompt into it, and works whether the lead pops,
 * polls, or is not a pty seat at all. The edge is written as well, as the durable
 * record and the gate for queue-driven callers, and neither half substitutes for
 * the other.
 *
 * Fences, each a bug if broken:
 *  - **Nothing is sent to the lead.** Not a question, not a notice. The lead
 *    discovers the prerequisite moving because it is moving.
 *  - **A match is exact or it is reported.** A title that resolves to two cards,
 *    or to a card the prose attributes to no single subtask, is `unresolved` and
 *    writes nothing. An approximate match holds unrelated work out of every pop.
 *  - **The prose is read, never authored.** No plan file is written, renamed or
 *    retitled by this pass.
 *  - **The breach is recorded even when resolved.** A feature carrying an
 *    outside prerequisite was mis-authored, and a silent fix means the pattern
 *    recurs.
 */
export async function resolveOutsidePrerequisites(
    args: { featureId: string },
    ports: NavigatorPrerequisitePorts,
): Promise<OutsidePrerequisiteOutcome> {
    const featureId = str(args.featureId);
    if (!featureId) { return { kind: 'not-found', featureId }; }

    // The Navigator is the AUTHOR OF RECORD. No model call is made — recognition
    // is mechanical — and an unset slot is tagged rather than silently blank.
    const slot = await ports.navigatorModel();
    const modelId = 'error' in slot ? '' : modelIdOf(slot);
    const authorSource = 'error' in slot ? `navigator-slot-unreadable: ${slot.error}`
        : (slot.endpoint ? `navigator-slot: ${slot.source}` : `navigator-slot-unset: ${slot.source}`);

    let feature: NavigatorPlanRow | null;
    let subtasks: NavigatorPlanRow[];
    let board: NavigatorPlanRow[];
    let featureBody: string;
    try {
        feature = await ports.readFeature(featureId);
        if (!feature) { return { kind: 'not-found', featureId }; }
        subtasks = (await ports.readSubtasks(featureId)) || [];
        board = (await ports.listPlans()) || [];
        featureBody = await ports.readPlanBody(feature);
    } catch (err) {
        // A board read that failed is NOT a feature with no prerequisites. The
        // two must never render the same string.
        return { kind: 'error', featureId, reason: `the board could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }

    const featureTitle = str(feature.topic) || featureId;
    const subtaskIds = new Set<string>();
    const subtaskTitles: Array<{ norm: string; row: NavigatorPlanRow; id: string; title: string }> = [];
    for (const s of subtasks) {
        const id = str(s.planId) || str(s.id);
        if (!id) { continue; }
        subtaskIds.add(id);
        const title = str(s.topic) || id;
        subtaskTitles.push({ norm: normalizeName(title), row: s, id, title });
    }

    // The match universe: every card that is NOT this feature and NOT one of its
    // own subtasks. A card inside the feature is internal sequencing, not an
    // outside prerequisite.
    const index = new Map<string, NavigatorPlanRow[]>();
    const addKey = (key: string, row: NavigatorPlanRow, id: string) => {
        if (!key) { return; }
        const list = index.get(key) || [];
        if (!list.some(r => (str(r.planId) || str(r.id)) === id)) { list.push(row); }
        index.set(key, list);
    };
    for (const row of board) {
        if (!row) { continue; }
        const id = str(row.planId) || str(row.id);
        if (!id || id === featureId || subtaskIds.has(id)) { continue; }
        if (str(row.featureId) === featureId || str(row.feature_id) === featureId) { continue; }
        addKey(normalizeName(baseName(str(row.planFile))), row, id);
        addKey(normalizeName(str(row.topic)), row, id);
    }
    const featureKeys = new Set([normalizeName(baseName(str(feature.planFile))), normalizeName(featureTitle)].filter(Boolean));

    const section = dependenciesSection(featureBody);
    const seen = new Set<string>();
    const pending: Array<{ named: string; dependent: { id: string; title: string } | null }> = [];
    for (const statement of sectionStatements(section)) {
        const statementNorm = normalizeName(statement);
        const named = subtaskTitles.filter(t => t.norm && statementNorm.includes(t.norm));
        const dependent = named.length === 1 ? { id: named[0].id, title: named[0].title } : null;
        for (const ref of codeSpans(statement)) {
            const trimmed = String(ref || '').trim();
            if (!trimmed) { continue; }
            const key = normalizeName(trimmed);
            if (!key || featureKeys.has(key)) { continue; }
            if (!isPlanLikeRef(trimmed, index)) { continue; }
            const dedupeKey = `${dependent ? dependent.id : ''}\u0000${key}`;
            if (seen.has(dedupeKey)) { continue; }
            seen.add(dedupeKey);
            pending.push({ named: trimmed, dependent });
        }
    }

    const at = ports.now ? ports.now() : new Date().toISOString();
    const base = { featureId, featureTitle, at, modelId, authorSource };
    const record = async (entry: PrerequisiteProvenance): Promise<RecordResult> => {
        try {
            return await ports.recordPrerequisiteProvenance(entry);
        } catch (err) {
            return { written: false, reason: err instanceof Error ? err.message : String(err) };
        }
    };

    if (pending.length === 0) {
        // An empty list is a CLAIM, and it needs a source: this entry is what
        // makes "none found" distinguishable from "the pass never ran".
        const entry: PrerequisiteProvenance = {
            ...base, named: '', dependentId: '', dependentTitle: '', prerequisiteId: '',
            prerequisiteTitle: '', prerequisiteColumn: '', outcome: 'none-found',
            reason: 'the feature\'s Dependencies & sequencing section names no prerequisite outside its own subtask set',
            candidates: [], edgeWritten: false, edgeError: '', dispatched: false,
            dispatchOutcome: 'not-attempted', dispatchError: '', authoringBreach: false,
        };
        return { kind: 'none-found', ...base, resolutions: [], recorded: [await record(entry)] };
    }

    // The union the cycle check runs over: the feature's own subtasks, plus every
    // card a reference resolved to, plus the dependents.
    const seedIds = new Set<string>(subtaskIds);
    for (const p of pending) { if (p.dependent) { seedIds.add(p.dependent.id); } }

    const resolutions: PrerequisiteResolution[] = [];
    const recorded: RecordResult[] = [];
    // `partial` unless EVERY prerequisite reached a terminal, actionable outcome.
    // An `absent` or `unresolved` reference is a finding rather than a failure,
    // but it is still work this pass did not do, and presenting that as
    // `resolved` is the same quiet-wrong-answer the outcome states exist to
    // prevent.
    let allResolved = true;

    for (const p of pending) {
        const matches = matchCardsByName(index, p.named);
        const resolution: PrerequisiteResolution = {
            named: p.named,
            dependentId: p.dependent ? p.dependent.id : '',
            dependentTitle: p.dependent ? p.dependent.title : '',
            prerequisiteId: '', prerequisiteTitle: '', prerequisiteColumn: '',
            outcome: 'unresolved', reason: '', candidates: [],
            edgeWritten: false, edgeError: '', dispatched: false,
            dispatchOutcome: 'not-attempted', dispatchError: '',
        };

        if (matches.length === 0) {
            resolution.outcome = 'absent';
            resolution.reason = `no card on the board is named '${p.named}' — a feature depends on work nobody has written`;
        } else if (matches.length > 1) {
            resolution.outcome = 'unresolved';
            resolution.candidates = matches.map(r => str(r.planId) || str(r.id));
            resolution.reason = `'${p.named}' matches ${matches.length} cards (${resolution.candidates.join(', ')}) — an approximate match would write an edge onto the wrong one, so nothing was written`;
        } else if (!p.dependent) {
            resolution.outcome = 'unresolved';
            resolution.candidates = [str(matches[0].planId) || str(matches[0].id)];
            resolution.reason = `'${p.named}' resolves to one card, but the prose names no single subtask that depends on it — nothing was written`;
        } else {
            const card = matches[0];
            const prerequisiteId = str(card.planId) || str(card.id);
            resolution.prerequisiteId = prerequisiteId;
            resolution.prerequisiteTitle = str(card.topic) || prerequisiteId;
            resolution.prerequisiteColumn = str(card.kanbanColumn) || str(card.kanban_column);
            seedIds.add(prerequisiteId);

            const completedAt = card.completedAt ?? card.completed_at ?? null;
            if (str(completedAt)) {
                resolution.outcome = 'complete';
                resolution.reason = `'${resolution.prerequisiteTitle}' has asserted completion — there is nothing to gate`;
            } else {
                resolution.outcome = 'exists-unfinished';
                const cycle = await unionCycle(
                    { planId: p.dependent.id, dependsOn: [prerequisiteId] },
                    Array.from(seedIds),
                    ports.readDependencies,
                );
                if (cycle.length > 0) {
                    resolution.outcome = 'cycle';
                    resolution.reason = `the edge would close a cycle across the union (${cycle.join(' -> ')}) — nothing was written`;
                } else {
                    // SET-write, so the existing edges are carried through rather
                    // than dropped: this pass adds one prerequisite, it does not
                    // replace what the plans already state.
                    const existing = await ports.readDependencies([p.dependent.id]);
                    const merged = dedupe([
                        ...((existing || {})[p.dependent.id] || []).map(str).filter(d => d && d !== p.dependent!.id),
                        prerequisiteId,
                    ]);
                    const written = await ports.writeDependencies({
                        planId: p.dependent.id,
                        dependsOn: merged,
                        mapFingerprint: memberFingerprint(p.dependent.id, Array.from(subtaskIds)),
                    });
                    resolution.edgeWritten = !!written.ok;
                    if (!written.ok) {
                        resolution.edgeError = written.error || 'the board refused the dependency write';
                    }
                    // The dispatch is the intervention and does not depend on the
                    // edge landing: the record and the act are separate halves.
                    try {
                        const res = await ports.dispatchCard({ planId: prerequisiteId });
                        const payload = res?.payload || {};
                        const errText = str(payload.error);
                        if (payload.success !== false && res.status < 400) {
                            resolution.dispatched = true;
                            resolution.dispatchOutcome = 'delivered';
                        } else if (res.status === 409 || /already|in flight|owned/i.test(errText)) {
                            resolution.dispatched = true;
                            resolution.dispatchOutcome = 'already-in-flight';
                        } else {
                            resolution.dispatchError = errText || `the dispatch answered ${res.status}`;
                            resolution.dispatchOutcome = 'failed';
                        }
                    } catch (err) {
                        resolution.dispatchError = err instanceof Error ? err.message : String(err);
                        resolution.dispatchOutcome = 'failed';
                    }
                }
            }
        }

        // "Fully resolved" is a positive claim: the card was already complete, or
        // the edge landed AND the prerequisite was actually put in flight. Every
        // other state is work this pass did not finish.
        const done = resolution.outcome === 'complete'
            || (resolution.outcome === 'exists-unfinished' && resolution.edgeWritten && resolution.dispatchOutcome !== 'failed');
        if (!done) { allResolved = false; }

        resolutions.push(resolution);
        recorded.push(await record({
            ...base,
            named: resolution.named,
            dependentId: resolution.dependentId,
            dependentTitle: resolution.dependentTitle,
            prerequisiteId: resolution.prerequisiteId,
            prerequisiteTitle: resolution.prerequisiteTitle,
            prerequisiteColumn: resolution.prerequisiteColumn,
            outcome: resolution.outcome,
            reason: resolution.reason,
            candidates: resolution.candidates,
            edgeWritten: resolution.edgeWritten,
            edgeError: resolution.edgeError,
            dispatched: resolution.dispatched,
            dispatchOutcome: resolution.dispatchOutcome,
            dispatchError: resolution.dispatchError,
            // A feature carrying an outside prerequisite was mis-authored, and
            // every resolution records that — including one already complete.
            authoringBreach: true,
        }));
    }

    return { kind: allResolved ? 'resolved' : 'partial', ...base, resolutions, recorded };
}

/** One string per state, so an unresolved prerequisite never reads like a resolution. */
export function outsidePrerequisiteMessage(outcome: OutsidePrerequisiteOutcome): string {
    switch (outcome.kind) {
        case 'resolved':
        case 'partial': {
            const bits: string[] = [];
            bits.push(`${outcome.resolutions.length} prerequisite(s) named outside '${outcome.featureTitle}'.`);
            for (const r of outcome.resolutions) {
                const who = r.dependentTitle ? `for '${r.dependentTitle}'` : 'for no named subtask';
                switch (r.outcome) {
                    case 'complete':
                        bits.push(`'${r.named}' ${who}: already complete — no edge, nothing dispatched.`);
                        break;
                    case 'exists-unfinished':
                        bits.push(`'${r.named}' ${who}: ${r.edgeWritten ? 'edge written' : `edge NOT written (${r.edgeError})`}, ${r.dispatched ? `dispatched (${r.dispatchOutcome})` : `not dispatched${r.dispatchError ? ` (${r.dispatchError})` : ''}`}.`);
                        break;
                    case 'absent':
                        bits.push(`'${r.named}' ${who}: ABSENT — no card on the board is named that.`);
                        break;
                    case 'unresolved':
                        bits.push(`'${r.named}' ${who}: UNRESOLVED — ${r.reason}`);
                        break;
                    case 'cycle':
                        bits.push(`'${r.named}' ${who}: CYCLE refused — ${r.reason}`);
                        break;
                }
            }
            // Every one of them is a breach, resolved or not — a silent fix means
            // the authoring rule is never enforced and the pattern recurs.
            bits.push(`All ${outcome.resolutions.length} recorded as authoring breaches.`);
            if (outcome.kind === 'partial') { bits.push('At least one prerequisite was only PARTLY resolved.'); }
            const unwritten = outcome.recorded.filter(r => !r.written).length;
            if (unwritten) { bits.push(`${unwritten} report entry(ies) were not written.`); }
            return bits.join(' ');
        }
        case 'none-found':
            return `No prerequisite outside '${outcome.featureTitle}' is named in its Dependencies & sequencing section.`;
        case 'not-found':
            return `No feature '${outcome.featureId}' on this board.`;
        case 'error':
            return `The outside-prerequisite pass failed: ${outcome.reason}`;
    }
}

