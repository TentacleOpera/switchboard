import type { ModelCallRequest, ModelCallResult } from '../judgement/modelClient';

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
