import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase } from './KanbanDatabase';
import { bootstrapTeamReportsDirectory } from './ScheduledJobsService';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';

/**
 * Board-side store for the Agent-panel controller
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports).
 *
 * The controller is a CLIENT — a separate process, possibly on another
 * machine's lifetime — so the state that must outlive it lives here, in the
 * board's own `config` table:
 *
 *   - `controller.lease` — the single-writer claim. Two `switchboard
 *     controller` processes started by accident must not double-remediate the
 *     same stuck seat. The lease is the concurrency contract; the controller
 *     renews it on every wake and the board refuses a second claimant.
 *   - `controller.state` — the controller's own durable state (escalation
 *     rungs, quota stand-downs, restart history). A controller that restarts
 *     must not lose it, and a second controller must not disagree about it.
 *
 * The report is a Markdown file appended per wake under the board's own
 * `.switchboard/teams/<teamId>/reports/`, NOT the controller's disk: a report
 * on the controller's filesystem is unreadable from the operator's phone,
 * which defeats the point.
 *
 * Every read here is a read of *identity/configuration*, so it follows the
 * fallback rule in CLAUDE.md: an absent value, an unreadable store and a
 * corrupt value are three DIFFERENT answers, never collapsed into one.
 */

export const CONTROLLER_LEASE_KEY = 'controller.lease';
export const CONTROLLER_STATE_KEY = 'controller.state';
/** Tier order/metadata, supervisor seat and the global ceiling — CONFIG. */
export const CONTROLLER_JUDGEMENT_KEY = 'controller.judgement';
/** Quota stand-downs — STATE that must survive a board restart (change 9). */
export const CONTROLLER_QUOTA_KEY = 'controller.quota';
/** Open supervisor escalations and per-rule spurious counts — STATE. */
export const CONTROLLER_ESCALATIONS_KEY = 'controller.escalations';
export const CONTROLLER_REPORT_FILENAME = 'controller-report.md';
/**
 * The controller's own CONFIG the panel owns: the wake interval the operator
 * edits on the phone (plan: the-agent-panel-becomes-a-standing-controller,
 * change 11). The interval is a process-level CLI flag, so a change takes effect
 * on the next arm — the panel says so rather than implying a live edit.
 */
export const CONTROLLER_CONFIG_KEY = 'controller.config';
/** The panel's record of the controller process it armed (pid + invocation). */
export const CONTROLLER_ARMED_KEY = 'controller.armed';
/** Matrix override the controller loads at the top of every wake. */
export const CONTROLLER_MATRIX_RELATIVE_PATH = path.join('.switchboard', 'controller', 'matrix.json');

export interface ControllerReportView {
    /** `configured` (file present) | `absent` (never written) | `unreadable`. */
    source: string;
    content: string | null;
    path: string | null;
    updatedAt: number | null;
    reason?: string;
}

export interface ControllerConfigView {
    value: { intervalMinutes: number | null };
    source: string;
    reason?: string;
}

export interface ControllerMatrixView {
    /** `configured` | `absent` (shipped default) | `corrupt`. */
    kind: string;
    rows: any[] | null;
    path: string;
    reason?: string;
}

export interface ControllerArmedView {
    /** `configured` (a controller was armed from this board) | `absent`. */
    source: string;
    pid: number | null;
    command: string | null;
    startedAt: number | null;
    reason?: string;
}

/**
 * A report grows without bound if it is append-only, and the panel eventually
 * renders a multi-megabyte file on a phone. At the ceiling the current file is
 * ROTATED (renamed aside, never unlinked) and a fresh one started.
 */
export const CONTROLLER_REPORT_MAX_BYTES = 1_000_000;

export interface ControllerLeaseRecord {
    holder: string;
    claimedAt: number;
    renewedAt: number;
    expiresAt: number;
    ttlMs: number;
}

export interface ControllerLeaseView {
    /** `null` when no controller has ever claimed the board. */
    holder: string | null;
    claimedAt: number | null;
    renewedAt: number | null;
    expiresAt: number | null;
    ttlMs: number | null;
    /** Holder set, but its TTL has elapsed — the controller's machine slept or died. */
    stale: boolean;
    /**
     * `false` when the lease row exists but could not be read/parsed. A corrupt
     * lease is NOT an unclaimed board — treating it as unclaimed is exactly the
     * quiet-wrong-answer the fallback rule forbids.
     */
    available: boolean;
    /** `config:controller.lease` | `unclaimed` | `unreadable` */
    source: string;
    reason?: string;
}

export interface ControllerClaimResult {
    granted: boolean;
    lease: ControllerLeaseView;
    reason?: string;
}

export interface ControllerStateView {
    /** The stored state, or `null` when nothing has been written. */
    state: unknown;
    /** `config:controller.state` | `unclaimed` | `unreadable` */
    source: string;
    holder: string | null;
    updatedAt: number | null;
    reason?: string;
}

export interface ControllerReportRequest {
    from: string;
    kind: string;
    body: string;
    teamId?: string;
}

export interface ControllerReportResult {
    success: boolean;
    path?: string;
    rotatedTo?: string;
    error?: string;
}

const LEASE_SOURCE = 'config:controller.lease';
const STATE_SOURCE = 'config:controller.state';

/**
 * Resolve a writable `KanbanDatabase` for a workspace root. Injectable so the
 * store can be exercised without a real board.
 */
export type ControllerDbResolver = (workspaceRoot: string) => KanbanDatabase;

export class ControllerBoardStore {
    private readonly _resolveDb: ControllerDbResolver;

    constructor(resolveDb: ControllerDbResolver = (root) => KanbanDatabase.forWorkspace(root)) {
        this._resolveDb = resolveDb;
    }

    private async _db(workspaceRoot: string): Promise<KanbanDatabase | null> {
        try {
            const db = this._resolveDb(workspaceRoot);
            if (!(await db.ensureReady())) { return null; }
            return db;
        } catch {
            return null;
        }
    }

    private _unreadable(reason: string): ControllerLeaseView {
        return {
            holder: null, claimedAt: null, renewedAt: null, expiresAt: null, ttlMs: null,
            stale: false, available: false, source: 'unreadable', reason,
        };
    }

    public async readLease(workspaceRoot: string, now: number = Date.now()): Promise<ControllerLeaseView> {
        const db = await this._db(workspaceRoot);
        if (!db) { return this._unreadable('kanban database unavailable'); }
        let raw: string | null;
        try {
            raw = await db.getConfig(CONTROLLER_LEASE_KEY);
        } catch (e) {
            return this._unreadable(`lease read failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (raw === null || raw === '') {
            return {
                holder: null, claimedAt: null, renewedAt: null, expiresAt: null, ttlMs: null,
                stale: false, available: true, source: 'unclaimed',
            };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return this._unreadable(`lease row is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
        const rec = (parsed && typeof parsed === 'object') ? parsed as Partial<ControllerLeaseRecord> : null;
        if (!rec || typeof rec.holder !== 'string' || rec.holder.length === 0 || typeof rec.expiresAt !== 'number') {
            return this._unreadable('lease row is missing holder/expiresAt');
        }
        return {
            holder: rec.holder,
            claimedAt: typeof rec.claimedAt === 'number' ? rec.claimedAt : null,
            renewedAt: typeof rec.renewedAt === 'number' ? rec.renewedAt : null,
            expiresAt: rec.expiresAt,
            ttlMs: typeof rec.ttlMs === 'number' ? rec.ttlMs : null,
            stale: rec.expiresAt <= now,
            available: true,
            source: LEASE_SOURCE,
        };
    }

    /**
     * Claim or renew. A board with no lease, an expired lease, or a lease held
     * by THIS controller is granted. A live lease held by another is refused —
     * the refusal carries the holder and expiry so the second controller can
     * say who owns the board and until when.
     */
    public async claimLease(workspaceRoot: string, controllerId: string, ttlMs: number, now: number = Date.now()): Promise<ControllerClaimResult> {
        if (!controllerId) {
            return { granted: false, lease: this._unreadable('controllerId is required'), reason: 'controllerId is required' };
        }
        const current = await this.readLease(workspaceRoot, now);
        if (!current.available) {
            return { granted: false, lease: current, reason: current.reason || 'lease store unreadable' };
        }
        if (current.holder && current.holder !== controllerId && !current.stale) {
            return {
                granted: false,
                lease: current,
                reason: `board is held by '${current.holder}' until ${new Date(current.expiresAt!).toISOString()}`,
            };
        }
        const db = await this._db(workspaceRoot);
        if (!db) {
            return { granted: false, lease: this._unreadable('kanban database unavailable'), reason: 'kanban database unavailable' };
        }
        const prior = current.holder === controllerId ? current : null;
        const record: ControllerLeaseRecord = {
            holder: controllerId,
            claimedAt: prior?.claimedAt ?? now,
            renewedAt: now,
            expiresAt: now + ttlMs,
            ttlMs,
        };
        try {
            const ok = await db.setConfig(CONTROLLER_LEASE_KEY, JSON.stringify(record));
            if (!ok) {
                return { granted: false, lease: this._unreadable('lease write failed'), reason: 'lease write failed' };
            }
        } catch (e) {
            const reason = `lease write failed: ${e instanceof Error ? e.message : String(e)}`;
            return { granted: false, lease: this._unreadable(reason), reason };
        }
        return {
            granted: true,
            lease: {
                holder: record.holder, claimedAt: record.claimedAt, renewedAt: record.renewedAt,
                expiresAt: record.expiresAt, ttlMs: record.ttlMs, stale: false,
                available: true, source: LEASE_SOURCE,
            },
        };
    }

    /** Release only if this controller is the holder. Idempotent. */
    public async releaseLease(workspaceRoot: string, controllerId: string, now: number = Date.now()): Promise<{ released: boolean; reason?: string }> {
        const current = await this.readLease(workspaceRoot, now);
        if (!current.available) { return { released: false, reason: current.reason || 'lease store unreadable' }; }
        if (!current.holder) { return { released: true, reason: 'no lease held' }; }
        if (current.holder !== controllerId) {
            return { released: false, reason: `lease is held by '${current.holder}'` };
        }
        const db = await this._db(workspaceRoot);
        if (!db) { return { released: false, reason: 'kanban database unavailable' }; }
        try {
            await db.deleteConfig(CONTROLLER_LEASE_KEY);
            return { released: true };
        } catch (e) {
            return { released: false, reason: `release failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    public async readState(workspaceRoot: string): Promise<ControllerStateView> {
        const db = await this._db(workspaceRoot);
        if (!db) {
            return { state: null, source: 'unreadable', holder: null, updatedAt: null, reason: 'kanban database unavailable' };
        }
        let raw: string | null;
        try {
            raw = await db.getConfig(CONTROLLER_STATE_KEY);
        } catch (e) {
            return { state: null, source: 'unreadable', holder: null, updatedAt: null, reason: `state read failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (raw === null || raw === '') {
            return { state: null, source: 'unclaimed', holder: null, updatedAt: null };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return { state: null, source: 'unreadable', holder: null, updatedAt: null, reason: `state row is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
        }
        const env = (parsed && typeof parsed === 'object') ? parsed as { holder?: unknown; updatedAt?: unknown; state?: unknown } : null;
        if (!env || typeof env.holder !== 'string') {
            return { state: null, source: 'unreadable', holder: null, updatedAt: null, reason: 'state row is missing holder' };
        }
        return {
            state: env.state ?? null,
            source: STATE_SOURCE,
            holder: env.holder,
            updatedAt: typeof env.updatedAt === 'number' ? env.updatedAt : null,
        };
    }

    /**
     * Write controller state. Only the CURRENT lease holder may write — a
     * controller that lost the lease must not clobber the live one's rungs.
     */
    public async writeState(workspaceRoot: string, controllerId: string, state: unknown, now: number = Date.now()): Promise<{ success: boolean; reason?: string }> {
        return this._writeHolderGated(workspaceRoot, controllerId, CONTROLLER_STATE_KEY, state, now);
    }

    /** Raw judgement CONFIG: tier order/metadata, supervisor seat, ceiling. */
    public async readJudgementConfig(workspaceRoot: string): Promise<{ value: any; source: string; reason?: string }> {
        return this._readJson(workspaceRoot, CONTROLLER_JUDGEMENT_KEY, 'unclaimed');
    }

    public async writeJudgementConfig(workspaceRoot: string, value: unknown): Promise<{ success: boolean; reason?: string }> {
        // Config is writable by any authenticated client (the panel edits it),
        // so it is NOT lease-gated — the lease gates controller STATE, not the
        // operator's rules.
        //
        // MEMBERSHIP is validated at save (plan: the-agent-panel-becomes-a-
        // standing-controller, change 11): a tier naming a provider that has no
        // `agentControlProviders` row is REFUSED with a reason here, not dropped
        // silently at 3am when the controller tries to resolve it.
        const cfg = (value && typeof value === 'object') ? value as { tiers?: unknown; supervisorSeat?: unknown; globalCeilingPerDay?: unknown } : {};
        const list = Array.isArray(cfg.tiers) ? cfg.tiers : [];
        if (list.length) {
            let rows: Record<string, unknown>;
            try {
                rows = (await GlobalIntegrationConfigService.getAgentConfig<Record<string, unknown>>('agentControlProviders')) || {};
            } catch (e) {
                return { success: false, reason: `agentControlProviders unreadable: ${e instanceof Error ? e.message : String(e)}` };
            }
            for (let i = 0; i < list.length; i++) {
                const t = (list[i] && typeof list[i] === 'object') ? list[i] as { providerId?: unknown } : {};
                const providerId = String(t.providerId || '').trim();
                if (!providerId) { return { success: false, reason: `tier ${i} has no providerId` }; }
                if (!Object.prototype.hasOwnProperty.call(rows, providerId)) {
                    return { success: false, reason: `tier '${providerId}' names no configured provider — there is no '${providerId}' row in agentControlProviders` };
                }
            }
        }
        return this._writeJson(workspaceRoot, CONTROLLER_JUDGEMENT_KEY, value);
    }

    public async readQuota(workspaceRoot: string): Promise<{ value: any; source: string; holder?: string | null; reason?: string }> {
        return this._readHolderGated(workspaceRoot, CONTROLLER_QUOTA_KEY);
    }

    public async writeQuota(workspaceRoot: string, controllerId: string, value: unknown, now: number = Date.now()): Promise<{ success: boolean; reason?: string }> {
        return this._writeHolderGated(workspaceRoot, controllerId, CONTROLLER_QUOTA_KEY, value, now);
    }

    public async readEscalations(workspaceRoot: string): Promise<{ value: any; source: string; holder?: string | null; reason?: string }> {
        return this._readHolderGated(workspaceRoot, CONTROLLER_ESCALATIONS_KEY);
    }

    /**
     * Open one supervisor escalation. The escalation table is BOARD-owned: the
     * controller opens and prunes entries through these ops rather than writing
     * the whole table back, which would clobber a verdict the supervisor posted
     * between the controller's read and its write.
     *
     * One open escalation per subject is the primary cost bound, so a second
     * open for a subject that already has one is REFUSED.
     */
    public async openEscalation(workspaceRoot: string, controllerId: string, record: any, now: number = Date.now()): Promise<{ success: boolean; reason?: string }> {
        const gate = await this._holderCheck(workspaceRoot, controllerId, now);
        if (!gate.ok) { return { success: false, reason: gate.reason }; }
        const db = gate.db!;
        const state = await this._readEscalationTable(db);
        if ('error' in state) { return { success: false, reason: state.error }; }
        const table = state.value;
        const subjectKey = String(record?.subjectKey || '');
        if (!subjectKey) { return { success: false, reason: 'escalation record has no subjectKey' }; }
        if (table.open[subjectKey] && table.open[subjectKey].status === 'open') {
            return { success: false, reason: `an escalation is already open for '${subjectKey}'` };
        }
        table.open[subjectKey] = record;
        try {
            const ok = await db.setConfig(CONTROLLER_ESCALATIONS_KEY, JSON.stringify(table));
            return ok ? { success: true } : { success: false, reason: 'escalations write failed' };
        } catch (e) {
            return { success: false, reason: `escalations write failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    /** Close escalations past their TTL as `timedout` so a late post cannot reopen them. */
    public async pruneEscalations(workspaceRoot: string, controllerId: string, ttlMs: number, now: number = Date.now()): Promise<{ success: boolean; pruned?: string[]; reason?: string }> {
        const gate = await this._holderCheck(workspaceRoot, controllerId, now);
        if (!gate.ok) { return { success: false, reason: gate.reason }; }
        const db = gate.db!;
        const state = await this._readEscalationTable(db);
        if ('error' in state) { return { success: false, reason: state.error }; }
        const table = state.value;
        const pruned: string[] = [];
        for (const key of Object.keys(table.open)) {
            const esc = table.open[key];
            if (!esc || esc.status !== 'open') { continue; }
            if (now - Number(esc.openedAt || 0) <= ttlMs) { continue; }
            esc.status = 'timedout';
            table.answered[esc.escalationId] = esc;
            delete table.open[key];
            pruned.push(esc.escalationId);
        }
        if (pruned.length === 0) { return { success: true, pruned: [] }; }
        try {
            const ok = await db.setConfig(CONTROLLER_ESCALATIONS_KEY, JSON.stringify(table));
            return ok ? { success: true, pruned } : { success: false, reason: 'escalations write failed' };
        } catch (e) {
            return { success: false, reason: `escalations write failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    private async _holderCheck(workspaceRoot: string, controllerId: string, now: number): Promise<{ ok: boolean; reason?: string; db?: KanbanDatabase }> {
        const lease = await this.readLease(workspaceRoot, now);
        if (!lease.available) { return { ok: false, reason: lease.reason || 'lease store unreadable' }; }
        if (lease.holder !== controllerId) { return { ok: false, reason: lease.holder ? `lease is held by '${lease.holder}'` : 'no lease held' }; }
        const db = await this._db(workspaceRoot);
        if (!db) { return { ok: false, reason: 'kanban database unavailable' }; }
        return { ok: true, db };
    }

    private async _readEscalationTable(db: KanbanDatabase): Promise<{ value: any } | { error: string }> {
        let raw: string | null;
        try {
            raw = await db.getConfig(CONTROLLER_ESCALATIONS_KEY);
        } catch (e) {
            return { error: `escalations read failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (raw === null || raw === '') { return { value: { open: {}, answered: {}, spuriousByRule: {} } }; }
        const parsed = safeParse(raw);
        if (parsed === null) { return { error: 'escalations row is corrupt' }; }
        return {
            value: {
                open: (parsed.open && typeof parsed.open === 'object') ? parsed.open : {},
                answered: (parsed.answered && typeof parsed.answered === 'object') ? parsed.answered : {},
                spuriousByRule: (parsed.spuriousByRule && typeof parsed.spuriousByRule === 'object') ? parsed.spuriousByRule : {},
            },
        };
    }

    /**
     * Apply a supervisor's structured post to the open-escalation table. The
     * supervisor is NOT the lease holder, so this write is not lease-gated: the
     * seat that was asked is the authority on its own answer.
     *
     * A post for an escalation that is no longer open is REFUSED (a late answer
     * must not reopen a closed escalation, or the "one open escalation per
     * subject" bound leaks), and a malformed post is reported, never dropped.
     */
    public async applySupervisorPost(workspaceRoot: string, post: { escalationId: string; verdict: string; reason: string; actions?: string[] }, now: number = Date.now()): Promise<{ success: boolean; reason?: string; applied?: boolean }> {
        const db = await this._db(workspaceRoot);
        if (!db) { return { success: false, reason: 'kanban database unavailable' }; }
        const read = await this._readEscalationTable(db);
        if ('error' in read) { return { success: false, reason: read.error }; }
        const state = read.value;
        const open = state.open;
        let target: any = null;
        let targetKey: string | null = null;
        for (const key of Object.keys(open)) {
            if (open[key]?.escalationId === post.escalationId) { target = open[key]; targetKey = key; break; }
        }
        if (!target || targetKey === null) {
            return { success: false, reason: `no open escalation with id '${post.escalationId}'`, applied: false };
        }
        if (target.status !== 'open') {
            return { success: false, reason: `escalation '${post.escalationId}' is already ${target.status}`, applied: false };
        }
        target.status = post.verdict === 'spurious' ? 'spurious' : (post.verdict === 'needs-human' ? 'needs-human' : 'answered');
        target.verdict = post.verdict;
        target.reason = post.reason;
        if (post.actions) { target.actions = post.actions; }
        target.answeredAt = now;
        if (post.verdict === 'spurious' && typeof target.ruleId === 'string' && target.ruleId) {
            state.spuriousByRule[target.ruleId] = (Number(state.spuriousByRule[target.ruleId]) || 0) + 1;
        }
        delete open[targetKey];
        state.answered[post.escalationId] = target;
        try {
            const ok = await db.setConfig(CONTROLLER_ESCALATIONS_KEY, JSON.stringify(state));
            return ok ? { success: true, applied: true } : { success: false, reason: 'escalations write failed' };
        } catch (e) {
            return { success: false, reason: `escalations write failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    private async _readJson(workspaceRoot: string, key: string, absentSource: string): Promise<{ value: any; source: string; reason?: string }> {
        const db = await this._db(workspaceRoot);
        if (!db) { return { value: null, source: 'unreadable', reason: 'kanban database unavailable' }; }
        let raw: string | null;
        try {
            raw = await db.getConfig(key);
        } catch (e) {
            return { value: null, source: 'unreadable', reason: `read failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (raw === null || raw === '') { return { value: null, source: absentSource }; }
        const parsed = safeParse(raw);
        if (parsed === null) { return { value: null, source: 'unreadable', reason: `${key} is not valid JSON` }; }
        return { value: parsed, source: `config:${key}` };
    }

    private async _readHolderGated(workspaceRoot: string, key: string): Promise<{ value: any; source: string; holder?: string | null; reason?: string }> {
        const db = await this._db(workspaceRoot);
        if (!db) { return { value: null, source: 'unreadable', reason: 'kanban database unavailable' }; }
        let raw: string | null;
        try {
            raw = await db.getConfig(key);
        } catch (e) {
            return { value: null, source: 'unreadable', reason: `read failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (raw === null || raw === '') { return { value: null, source: 'unclaimed' }; }
        const parsed = safeParse(raw);
        if (parsed === null) { return { value: null, source: 'unreadable', reason: `${key} is not valid JSON` }; }
        const env = (parsed && typeof parsed === 'object') ? parsed as { holder?: unknown; updatedAt?: unknown; state?: unknown } : null;
        if (!env || typeof env.holder !== 'string') {
            return { value: null, source: 'unreadable', holder: null, reason: `${key} row is missing holder` };
        }
        return { value: env.state ?? null, source: `config:${key}`, holder: env.holder };
    }

    private async _writeJson(workspaceRoot: string, key: string, value: unknown): Promise<{ success: boolean; reason?: string }> {
        const db = await this._db(workspaceRoot);
        if (!db) { return { success: false, reason: 'kanban database unavailable' }; }
        try {
            const ok = await db.setConfig(key, JSON.stringify(value));
            return ok ? { success: true } : { success: false, reason: `${key} write failed` };
        } catch (e) {
            return { success: false, reason: `${key} write failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    private async _writeHolderGated(workspaceRoot: string, controllerId: string, key: string, value: unknown, now: number): Promise<{ success: boolean; reason?: string }> {
        const lease = await this.readLease(workspaceRoot, now);
        if (!lease.available) { return { success: false, reason: lease.reason || 'lease store unreadable' }; }
        if (lease.holder !== controllerId) {
            return { success: false, reason: lease.holder ? `lease is held by '${lease.holder}'` : 'no lease held' };
        }
        const db = await this._db(workspaceRoot);
        if (!db) { return { success: false, reason: 'kanban database unavailable' }; }
        try {
            const ok = await db.setConfig(key, JSON.stringify({ holder: controllerId, updatedAt: now, state: value }));
            return ok ? { success: true } : { success: false, reason: `${key} write failed` };
        } catch (e) {
            return { success: false, reason: `${key} write failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    /**
     * Append one wake's Markdown entry to the controller's report file on the
     * board. Rotates the file aside (never unlinks) when it reaches the size
     * ceiling.
     */
    public async appendReport(workspaceRoot: string, req: ControllerReportRequest): Promise<ControllerReportResult> {
        const teamId = req.teamId && req.teamId.trim() ? req.teamId.trim() : 'controller';
        let reportsDir: string | null;
        try {
            reportsDir = await bootstrapTeamReportsDirectory(workspaceRoot, teamId);
        } catch (e) {
            return { success: false, error: `reports directory bootstrap failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (!reportsDir) {
            return { success: false, error: `.switchboard directory does not exist under ${workspaceRoot}` };
        }
        const filePath = path.join(reportsDir, CONTROLLER_REPORT_FILENAME);
        let rotatedTo: string | undefined;
        try {
            if (fs.existsSync(filePath)) {
                const stat = await fs.promises.stat(filePath);
                if (stat.size >= CONTROLLER_REPORT_MAX_BYTES) {
                    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
                    rotatedTo = path.join(reportsDir, `controller-report.${stamp}.md`);
                    await fs.promises.rename(filePath, rotatedTo);
                }
            }
            const entry = `\n---\n\n## Wake ${new Date().toISOString()} — ${req.from}\n\n_kind: ${req.kind}_\n\n${req.body}\n`;
            await fs.promises.appendFile(filePath, entry, 'utf8');
            return { success: true, path: filePath, ...(rotatedTo ? { rotatedTo } : {}) };
        } catch (e) {
            return { success: false, error: `report append failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    /**
     * Read the controller's Markdown report back for the panel. The report is
     * the ONE artifact the operator reads on a phone, and it lives on the board
     * — a report on the controller's disk is unreadable from there. An absent
     * file is `absent` (never written), distinct from `unreadable`.
     */
    public async readReport(workspaceRoot: string, teamId: string = 'controller'): Promise<ControllerReportView> {
        const tid = teamId && teamId.trim() ? teamId.trim() : 'controller';
        const filePath = path.join(workspaceRoot, '.switchboard', 'teams', tid, 'reports', CONTROLLER_REPORT_FILENAME);
        try {
            const stat = await fs.promises.stat(filePath);
            const content = await fs.promises.readFile(filePath, 'utf8');
            return { source: 'configured', content, path: filePath, updatedAt: stat.mtimeMs };
        } catch (e: any) {
            if (e && e.code === 'ENOENT') {
                return { source: 'absent', content: null, path: filePath, updatedAt: null };
            }
            return { source: 'unreadable', content: null, path: filePath, updatedAt: null, reason: e instanceof Error ? e.message : String(e) };
        }
    }

    /** The panel-owned controller config (wake interval). Absent ≠ corrupt. */
    public async readConfig(workspaceRoot: string): Promise<ControllerConfigView> {
        const read = await this._readJson(workspaceRoot, CONTROLLER_CONFIG_KEY, 'absent');
        if (read.source === 'unreadable') {
            return { value: { intervalMinutes: null }, source: 'corrupt', reason: read.reason };
        }
        if (read.source === 'absent' || read.value === null) {
            return { value: { intervalMinutes: null }, source: 'absent' };
        }
        const interval = read.value && typeof read.value.intervalMinutes === 'number' && read.value.intervalMinutes > 0
            ? read.value.intervalMinutes : null;
        return { value: { intervalMinutes: interval }, source: read.source };
    }

    public async writeConfig(workspaceRoot: string, value: { intervalMinutes?: unknown }): Promise<{ success: boolean; reason?: string }> {
        const interval = Number(value?.intervalMinutes);
        if (value?.intervalMinutes !== null && value?.intervalMinutes !== undefined && (!Number.isFinite(interval) || interval <= 0)) {
            return { success: false, reason: `intervalMinutes must be a positive number (got '${String(value?.intervalMinutes)}')` };
        }
        const next = { intervalMinutes: (value?.intervalMinutes === null || value?.intervalMinutes === undefined) ? null : interval };
        return this._writeJson(workspaceRoot, CONTROLLER_CONFIG_KEY, next);
    }

    /**
     * The matrix override the controller loads each wake. The controller reads
     * `.switchboard/controller/matrix.json`; the panel writes the same file so
     * an edit on a phone reaches the controller on its next wake with no file
     * editing. A present-but-invalid override is `corrupt` and REFUSED at save
     * — never written and then silently discarded by the controller.
     */
    public async readMatrix(workspaceRoot: string): Promise<ControllerMatrixView> {
        const filePath = path.join(workspaceRoot, CONTROLLER_MATRIX_RELATIVE_PATH);
        let raw: string;
        try {
            raw = await fs.promises.readFile(filePath, 'utf8');
        } catch (e: any) {
            if (e && e.code === 'ENOENT') { return { kind: 'absent', rows: null, path: filePath }; }
            return { kind: 'corrupt', rows: null, path: filePath, reason: e instanceof Error ? e.message : String(e) };
        }
        const parsed = safeParse(raw);
        const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows) ? parsed.rows : null);
        if (!rows) { return { kind: 'corrupt', rows: null, path: filePath, reason: 'matrix override is not an array of rows or { rows: [...] }' }; }
        return { kind: 'configured', rows, path: filePath };
    }

    public async writeMatrix(workspaceRoot: string, rows: unknown): Promise<{ success: boolean; reason?: string }> {
        const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' && Array.isArray((rows as any).rows) ? (rows as any).rows : null);
        if (!list) { return { success: false, reason: 'matrix must be an array of rows or { rows: [...] }' }; }
        const invalid = validateMatrixRows(list);
        if (invalid) { return { success: false, reason: invalid }; }
        const filePath = path.join(workspaceRoot, CONTROLLER_MATRIX_RELATIVE_PATH);
        try {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.writeFile(filePath, JSON.stringify({ rows: list }, null, 2), 'utf8');
            return { success: true };
        } catch (e) {
            return { success: false, reason: `matrix write failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    /** The controller process this board armed, if any. */
    public async readArmed(workspaceRoot: string): Promise<ControllerArmedView> {
        const read = await this._readJson(workspaceRoot, CONTROLLER_ARMED_KEY, 'absent');
        if (read.source === 'unreadable') { return { source: 'unreadable', pid: null, command: null, startedAt: null, reason: read.reason }; }
        if (read.source === 'absent' || read.value === null) { return { source: 'absent', pid: null, command: null, startedAt: null }; }
        return {
            source: read.source,
            pid: typeof read.value.pid === 'number' ? read.value.pid : null,
            command: typeof read.value.command === 'string' ? read.value.command : null,
            startedAt: typeof read.value.startedAt === 'number' ? read.value.startedAt : null,
        };
    }

    public async writeArmed(workspaceRoot: string, record: { pid: number; command: string; startedAt: number }): Promise<{ success: boolean; reason?: string }> {
        return this._writeJson(workspaceRoot, CONTROLLER_ARMED_KEY, record);
    }

    public async clearArmed(workspaceRoot: string): Promise<{ success: boolean; reason?: string }> {
        const db = await this._db(workspaceRoot);
        if (!db) { return { success: false, reason: 'kanban database unavailable' }; }
        try {
            await db.deleteConfig(CONTROLLER_ARMED_KEY);
            return { success: true };
        } catch (e) {
            return { success: false, reason: `armed clear failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }
}

/** Structural validation for a matrix override, mirroring the controller's own
 *  loader. Returns a reason string when invalid, null when valid. */
function validateMatrixRows(rows: any[]): string | null {
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || typeof row !== 'object') { return `matrix row ${i} is not an object`; }
        for (const key of ['id', 'order', 'cause', 'judge', 'condition', 'remediation', 'requires']) {
            if (row[key] === undefined) { return `matrix row ${i} is missing '${key}'`; }
        }
        if (row.judge !== 'mechanical' && row.judge !== 'model') { return `matrix row '${row.id}' has an unknown judge '${row.judge}'`; }
        if (!row.condition || typeof row.condition.kind !== 'string') { return `matrix row '${row.id}' has no condition.kind`; }
        if (!KNOWN_CONDITION_KINDS.includes(String(row.condition.kind))) {
            return `matrix row '${row.id}' has an unknown condition.kind '${String(row.condition.kind)}' — the controller's evaluator has no arm for it, so the row would never fire`;
        }
        if (!Array.isArray(row.requires)) { return `matrix row '${row.id}' has a non-array 'requires'`; }
        // MEMBERSHIP, not just shape (plan: the-agent-panel-becomes-a-standing-
        // controller, change 11). An unknown remediation falls through the
        // controller's apply switch and is silently ignored at wake time — the
        // exact 3am behaviour this clause forbids — so it is REFUSED here with a
        // reason. `requires` is checked the same way: an unknown capability
        // would make the row's precondition unsatisfiable without saying so.
        if (!KNOWN_REMEDIATIONS.includes(String(row.remediation))) {
            return `matrix row '${row.id}' names an unknown remediation verb '${String(row.remediation)}'`;
        }
        for (const cap of row.requires) {
            if (!KNOWN_CAPABILITIES.includes(String(cap))) {
                return `matrix row '${row.id}' requires an unknown capability '${String(cap)}'`;
            }
        }
    }
    return null;
}

/**
 * The closed sets a matrix override is checked against, mirrored from
 * `src/standalone/controller/matrix.ts` (the controller's own loader remains
 * the authority; this mirror is what lets the BOARD refuse an edit at save
 * time instead of writing a row the controller will silently drop).
 */
const KNOWN_REMEDIATIONS = [
    'mark-complete', 'nudge', 'relay-answer', 'clear-respawn', 'reroute',
    'stand-down', 'supervisor', 'escalate-human', 'restart-board', 'record-unknown',
];
const KNOWN_CAPABILITIES = ['mechanical', 'model', 'supervisor', 'two-providers'];
/**
 * The condition kinds the controller's evaluator has an arm for. A row naming
 * anything else matches no arm, returns no diagnosis and is silently inert —
 * the 3am failure this validation exists to refuse. Mirrored from
 * `MATRIX_CONDITION_KINDS` in `src/standalone/controller/matrix.ts`; the
 * controller's own loader validates the same set and remains the authority.
 */
const KNOWN_CONDITION_KINDS = ['completed-unasserted', 'quiet-clean-tail', 'owner-seat-dead', 'judgement'];

/** Parse JSON, returning `null` for a corrupt value (never throwing). */
function safeParse(raw: string): any | null {
    try { return JSON.parse(raw); } catch { return null; }
}

