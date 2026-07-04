import * as path from 'path';
import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import type { RemoteProvider } from './remote/RemoteProvider';
import type { RemoteProviderKind } from './RemoteControlService';
import { ArchiveManager } from './ArchiveManager';

/**
 * Auto-Archive Rule (epic 7 — Auto-Archive & Production Hardening).
 *
 * After a configurable dwell in a **designated** column (default = the stage
 * immediately before Completed), a plan auto-moves to Completed and archives
 * locally. Because Switchboard is the source of truth and push mirrors state
 * outward, Linear/Notion follow via the provider's `archiveCard` capability.
 *
 * The trigger column is **designated, not hardcoded** — the board's late
 * pipeline can branch and grow (e.g. a PRD-tester stage inserted before
 * Completed), so the user picks the sweep column from a setup-tab dropdown.
 *
 * No backfill: manual bulk-archive buttons already exist in both Switchboard
 * and Linear for the existing backlog. This rule only automates the *move
 * itself* so plans stop stalling in the late column.
 */

export interface AutoArchiveConfig {
    /** Master toggle. Default off on upgrade (auto-completing plans is a behavior change). */
    enabled: boolean;
    /** The column id to sweep (e.g. 'CODE REVIEWED'). Plans here past the threshold are archived. */
    triggerColumn: string;
    /** Dwell threshold in hours. Default ~2h. */
    thresholdHours: number;
}

export const DEFAULT_AUTO_ARCHIVE_CONFIG: AutoArchiveConfig = {
    enabled: false,
    triggerColumn: '',
    thresholdHours: 2,
};

const AUTO_ARCHIVE_CONFIG_KEY = 'kanban.autoArchive';
/** Sweep cadence — every 5 minutes. The dwell threshold is in hours, so a
 *  5-minute sweep granularity is well within tolerance. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface AutoArchiveDeps {
    getDb: () => KanbanDatabase | null;
    getWorkspaceRoot: () => string;
    /** Build the provider for the active backend (or null if unconfigured). */
    getProvider: (kind: RemoteProviderKind) => RemoteProvider | null;
    /** Get the active remote provider kind (from RemoteConfig). */
    getActiveProviderKind: () => Promise<RemoteProviderKind | null>;
    /** Resolve the column id that sits immediately before COMPLETED (default trigger). */
    getDefaultTriggerColumn: () => Promise<string>;
    /** Record an outbound push outcome for the Remote tab health UI (epic 7). */
    recordPushResult?: (ok: boolean, error?: string) => void;
    log?: (msg: string) => void;
}

export class AutoArchiveService {
    private _deps: AutoArchiveDeps;
    private _timer?: NodeJS.Timeout;
    private _sweeping = false;

    constructor(deps: AutoArchiveDeps) {
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || ((m) => console.log(m)))(`[AutoArchive] ${msg}`);
    }

    // ── Config (DB config table) ────────────────────────────────────

    public async getConfig(): Promise<AutoArchiveConfig> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return { ...DEFAULT_AUTO_ARCHIVE_CONFIG }; }
        const raw = await db.getConfig(AUTO_ARCHIVE_CONFIG_KEY);
        if (!raw) {
            // First access: default the trigger column to whatever sits before Completed.
            const defaultCol = await this._deps.getDefaultTriggerColumn();
            return { ...DEFAULT_AUTO_ARCHIVE_CONFIG, triggerColumn: defaultCol };
        }
        try {
            const parsed = JSON.parse(raw);
            return {
                enabled: parsed.enabled === true,
                triggerColumn: String(parsed.triggerColumn || ''),
                thresholdHours: this._clampThreshold(parsed.thresholdHours),
            };
        } catch {
            return { ...DEFAULT_AUTO_ARCHIVE_CONFIG };
        }
    }

    public async setConfig(config: AutoArchiveConfig): Promise<AutoArchiveConfig> {
        const db = this._deps.getDb();
        const normalized: AutoArchiveConfig = {
            enabled: config.enabled === true,
            triggerColumn: String(config.triggerColumn || '').trim(),
            thresholdHours: this._clampThreshold(config.thresholdHours),
        };
        if (!db || !(await db.ensureReady())) { return normalized; }
        await db.setConfig(AUTO_ARCHIVE_CONFIG_KEY, JSON.stringify(normalized));
        // Restart the timer if currently running to pick up new cadence/column.
        if (this._timer) {
            this._stopTimer();
            if (normalized.enabled) { this._startTimer(); }
        }
        return normalized;
    }

    private _clampThreshold(value: unknown): number {
        const n = Number(value);
        if (!isFinite(n) || n <= 0) { return DEFAULT_AUTO_ARCHIVE_CONFIG.thresholdHours; }
        return Math.min(720, Math.max(0.25, n)); // 15 min – 30 days
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    /** Start the periodic sweep. No-op if config is disabled. */
    public async start(): Promise<void> {
        const config = await this.getConfig();
        if (!config.enabled) {
            this._log('Auto-archive is off — not starting.');
            return;
        }
        this._startTimer();
        this._log(`Started (trigger column=${config.triggerColumn}, threshold=${config.thresholdHours}h).`);
    }

    public stop(): void {
        this._stopTimer();
    }

    public dispose(): void {
        this._stopTimer();
    }

    private _startTimer(): void {
        this._stopTimer();
        this._timer = setInterval(() => { void this._sweep(); }, SWEEP_INTERVAL_MS);
    }

    private _stopTimer(): void {
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
    }

    // ── Sweep ───────────────────────────────────────────────────────

    /**
     * One sweep cycle: find plans in the trigger column past the dwell
     * threshold and move them to Completed + archive locally + push archive
     * to the active remote provider. Safe to call manually or on the timer.
     */
    public async sweep(): Promise<{ archived: number; errors: string[] }> {
        return this._sweep();
    }

    /** Persisted per-plan column-dwell map: planId → { column, since (epoch ms) }. */
    private async _getDwellMap(): Promise<Record<string, { column: string; since: number }>> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return {}; }
        return db.getConfigJson<Record<string, { column: string; since: number }>>('autoArchive.columnDwell', {});
    }

    private async _setDwellMap(map: Record<string, { column: string; since: number }>): Promise<void> {
        const db = this._deps.getDb();
        if (!db || !(await db.ensureReady())) { return; }
        await db.setConfigJson('autoArchive.columnDwell', map);
    }

    private async _sweep(): Promise<{ archived: number; errors: string[] }> {
        if (this._sweeping) { return { archived: 0, errors: [] }; }
        this._sweeping = true;
        const errors: string[] = [];
        let archived = 0;
        try {
            const db = this._deps.getDb();
            if (!db || !(await db.ensureReady())) { return { archived: 0, errors }; }

            const config = await this.getConfig();
            if (!config.enabled || !config.triggerColumn) {
                return { archived: 0, errors };
            }

            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            if (!workspaceId) { return { archived: 0, errors }; }

            const now = Date.now();

            // Maintain a persisted "time in current column" map (planId → {column, since}).
            // Dwell is measured from when a plan ENTERED its current column — NOT from
            // plan.updatedAt, which bumps on any edit/comment and would let a busy plan
            // dodge auto-archiving forever. We observe every plan each sweep and reset the
            // timestamp only when a plan's column actually changes; entries for deleted
            // plans are pruned. (First sight of a plan stamps `now`, so a plan already
            // resident gets one conservative threshold delay — never a premature archive.)
            const dwellMap = await this._getDwellMap();
            const allPlans = await db.getAllPlans(workspaceId);
            const liveIds = new Set<string>();
            let dwellChanged = false;
            for (const p of allPlans) {
                liveIds.add(p.planId);
                const prev = dwellMap[p.planId];
                if (!prev || prev.column !== p.kanbanColumn) {
                    dwellMap[p.planId] = { column: p.kanbanColumn, since: now };
                    dwellChanged = true;
                }
            }
            for (const id of Object.keys(dwellMap)) {
                if (!liveIds.has(id)) { delete dwellMap[id]; dwellChanged = true; }
            }
            if (dwellChanged) { await this._setDwellMap(dwellMap); }

            const plans = await db.getPlansByColumn(workspaceId, config.triggerColumn);
            if (plans.length === 0) { return { archived: 0, errors }; }

            const thresholdMs = config.thresholdHours * 60 * 60 * 1000;
            const workspaceRoot = this._deps.getWorkspaceRoot();

            // Resolve the active remote provider for archive push (may be null).
            const providerKind = await this._deps.getActiveProviderKind();
            const provider = providerKind ? this._deps.getProvider(providerKind) : null;
            const archiveCapability = provider?.capabilities.archive === true;

            const archiveMgr = new ArchiveManager(workspaceRoot);

            for (const plan of plans) {
                // Dwell from column-entry time; fall back to updatedAt if the plan was
                // somehow never observed entering (belt-and-suspenders).
                const enteredAt = dwellMap[plan.planId]?.since ?? new Date(plan.updatedAt).getTime();
                if (isNaN(enteredAt)) { continue; }
                if ((now - enteredAt) < thresholdMs) { continue; }

                // 1. Move to Completed + mark status in the kanban DB.
                const moved = await db.archivePlan(plan.planFile, workspaceId, 'archived');
                if (!moved) {
                    errors.push(`Failed to mark ${plan.planFile} as completed in the kanban DB.`);
                    continue;
                }

                // 2. Archive to DuckDB (best-effort — archive may be unconfigured).
                if (archiveMgr.isConfigured) {
                    try {
                        const cliOk = await archiveMgr.checkDuckDbCli();
                        if (cliOk.installed) {
                            await archiveMgr.archivePlan(this._toArchiveRecord(plan));
                        }
                    } catch (e) {
                        // DuckDB archive is best-effort; the kanban DB move above is the
                        // source-of-truth transition. Log but don't fail the sweep.
                        this._log(`DuckDB archive skipped for ${plan.planFile}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }

                // 3. Push archive to the remote provider (Linear/Notion follow).
                if (archiveCapability && provider) {
                    const remoteId = this._remoteIdOf(providerKind!, plan);
                    if (remoteId) {
                        try {
                            const result = await provider.archiveCard(remoteId);
                            if (!result.ok && !result.skipped) {
                                errors.push(`Remote archive failed for ${plan.planFile}: ${result.error || 'unknown'}`);
                                this._deps.recordPushResult?.(false, result.error);
                            } else {
                                this._deps.recordPushResult?.(true);
                            }
                        } catch (e) {
                            errors.push(`Remote archive threw for ${plan.planFile}: ${e instanceof Error ? e.message : String(e)}`);
                            this._deps.recordPushResult?.(false, e instanceof Error ? e.message : String(e));
                        }
                    }
                }

                archived++;
                this._log(`Auto-archived ${plan.topic || plan.planFile} (dwelled ${Math.round((now - enteredAt) / 60000)}m in ${config.triggerColumn}).`);
            }

            if (archived > 0) {
                this._log(`Sweep complete: ${archived} plan(s) archived${errors.length ? `, ${errors.length} error(s)` : ''}.`);
            }
        } catch (e) {
            errors.push(`Sweep error: ${e instanceof Error ? e.message : String(e)}`);
            this._log(`Sweep error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this._sweeping = false;
        }
        return { archived, errors };
    }

    private _remoteIdOf(kind: RemoteProviderKind, plan: KanbanPlanRecord): string {
        if (kind === 'linear') { return plan.linearIssueId || ''; }
        if (kind === 'notion') { return plan.notionPageId || ''; }
        if (kind === 'control-plane' || kind === 'wiki') {
            return plan.planFile ? path.basename(plan.planFile, '.md') : '';
        }
        return '';
    }

    /** Map a KanbanPlanRecord to the ArchiveManager's PlanRecord shape. */
    private _toArchiveRecord(plan: KanbanPlanRecord): import('./ArchiveManager').PlanRecord {
        return {
            planId: plan.planId,
            sessionId: plan.sessionId,
            topic: plan.topic,
            planFile: plan.planFile,
            kanbanColumn: 'COMPLETED',
            status: 'archived',
            complexity: plan.complexity,
            workspaceId: plan.workspaceId,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            lastAction: 'auto-archived',
            sourceType: plan.sourceType,
            tags: plan.tags,
            routedTo: plan.routedTo || '',
            dispatchedAgent: plan.dispatchedAgent || '',
            dispatchedIde: plan.dispatchedIde || '',
        };
    }
}
