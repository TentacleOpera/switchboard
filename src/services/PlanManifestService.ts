import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase, VALID_KANBAN_COLUMNS } from './KanbanDatabase';

/**
 * Plan-Import DB Manifest (v1)
 * ============================
 * Lets externally-authored plans land in the correct kanban column/state on
 * import instead of always defaulting to CREATED. A workflow writes a JSON
 * manifest sidecar (`.switchboard/plans/manifest.json`) alongside the plan
 * `.md` files; the watcher ingests it (setting DB-owned state the `.md` can't
 * express), then deletes it so it never re-applies.
 *
 * Manifest carries, per plan: kanban column, status, epic relationships
 * (`is_epic` / `epic_id`), and project name. Plan *content* metadata (title,
 * complexity, tags) continues to come from the `.md` front-matter.
 *
 * Key design facts (verified against source):
 *  - `insertFileDerivedPlan` preserves `kanban_column` on conflict (its ON
 *    CONFLICT clause omits kanban_column from the UPDATE SET), so once the
 *    manifest upgrades a plan's column, the periodic scanner will NOT reset
 *    it. This is why consume-then-delete is safe and sufficient.
 *  - `upsertPlans` does NOT override `kanban_column` on existing rows, so the
 *    manifest uses the targeted methods: `movePlanByPlanFile` (column),
 *    `updateEpicStatus` (epic links), `updateStatusByPlanFile` (status),
 *    `updatePlanProjectByPlanFile` (project).
 *  - The existing scan cycle only reads `.md` files, so the manifest needs an
 *    explicit dedicated check in the periodic timer — not a ride-along.
 */

const VALID_STATUSES = new Set(['active', 'archived', 'completed', 'deleted']);
const MANIFEST_FILENAME = 'manifest.json';
const STALENESS_MAX_ATTEMPTS = 18;   // ~3 minutes at 10s scan interval
const STALENESS_MAX_MS = 10 * 60 * 1000; // 10 minutes absolute cap

export interface ManifestEntry {
    planFile: string;
    planId?: string;
    kanbanColumn?: string;
    status?: string;
    isEpic?: boolean;
    epicId?: string;
    project?: string;
}

export interface ManifestFile {
    version: number;
    plans: ManifestEntry[];
}

export interface ManifestApplyResult {
    applied: number;
    deferred: number;
    /** True when the manifest was fully consumed and deleted from disk. */
    consumed: boolean;
}

export class PlanManifestService {
    /** Per-workspace attempt counters for the staleness guard. */
    private _attempts = new Map<string, { count: number; firstSeen: number }>();

    /**
     * Read, validate, and apply the manifest for a workspace. Caller invokes
     * this every periodic scan cycle (and on manual `triggerScan`), AFTER the
     * `.md` import pass so plan rows exist before being upgraded.
     *
     * Returns counts; the caller does not need to act on them — the service
     * deletes the manifest itself once all entries are applied.
     */
    public async applyManifest(
        workspaceRoot: string,
        workspaceId: string,
        db: KanbanDatabase,
        log?: (msg: string) => void
    ): Promise<ManifestApplyResult> {
        const manifestPath = path.join(workspaceRoot, '.switchboard', 'plans', MANIFEST_FILENAME);
        const result: ManifestApplyResult = { applied: 0, deferred: 0, consumed: false };

        let raw: string;
        try {
            raw = await fs.promises.readFile(manifestPath, 'utf8');
        } catch {
            // No manifest — common steady state. Clear any stale attempt counter.
            this._attempts.delete(workspaceRoot);
            return result;
        }

        // Freshness guard: skip files < 500ms old (partial-write guard, matches
        // the periodic-scan guard at GlobalPlanWatcherService.ts:229).
        try {
            const stats = await fs.promises.stat(manifestPath);
            if (Date.now() - stats.mtimeMs < 500) {
                log?.(`[PlanManifest] Manifest < 500ms old, deferring this cycle: ${manifestPath}`);
                return result;
            }
        } catch {
            return result; // vanished between read and stat
        }

        // Defensive parse — primary race guard against truncated JSON.
        let parsed: ManifestFile;
        try {
            parsed = JSON.parse(raw) as ManifestFile;
        } catch (err) {
            log?.(`[PlanManifest] Failed to parse manifest (likely partial write), will retry next cycle: ${err}`);
            return result;
        }

        if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.plans)) {
            log?.(`[PlanManifest] Manifest missing/unknown version or plans array; skipping this cycle`);
            return result;
        }

        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');

        // Sort: epics first so subtask epic_id links resolve against in-batch epics.
        const entries = [...parsed.plans].sort((a, b) => {
            const ae = a.isEpic ? 0 : 1;
            const be = b.isEpic ? 0 : 1;
            return ae - be;
        });

        // Track in-batch epic planIds for epic_id resolution.
        const inBatchEpicIds = new Set<string>();
        let anyDeferred = false;

        for (const entry of entries) {
            const r = await this._applyEntry(entry, db, workspaceId, workspaceRoot, plansDir, epicsDir, inBatchEpicIds, log);
            if (r === 'applied') {
                result.applied++;
                if (entry.isEpic && entry.planId) {
                    inBatchEpicIds.add(entry.planId);
                }
            } else {
                result.deferred++;
                anyDeferred = true;
            }
        }

        if (anyDeferred) {
            // Staleness tracking — drop the manifest if it can never resolve.
            const att = this._attempts.get(workspaceRoot);
            const now = Date.now();
            const count = att ? att.count + 1 : 1;
            const firstSeen = att ? att.firstSeen : now;
            this._attempts.set(workspaceRoot, { count, firstSeen });
            if (count >= STALENESS_MAX_ATTEMPTS || (now - firstSeen) >= STALENESS_MAX_MS) {
                log?.(`[PlanManifest] Staleness guard fired after ${count} attempts (~${Math.round((now - firstSeen) / 1000)}s); dropping manifest to unblock scan loop.`);
                await this._safeDelete(manifestPath, log);
                this._attempts.delete(workspaceRoot);
                result.consumed = true; // consumed by force-drop
                result.deferred = 0;
            }
            log?.(`[PlanManifest] Applied ${result.applied}, deferred ${result.deferred} (manifest retained for retry).`);
            return result;
        }

        // All entries applied — delete the manifest so it never re-applies.
        await this._safeDelete(manifestPath, log);
        this._attempts.delete(workspaceRoot);
        result.consumed = true;
        log?.(`[PlanManifest] Applied ${result.applied} entr${result.applied === 1 ? 'y' : 'ies'}; manifest deleted.`);
        return result;
    }

    private async _applyEntry(
        entry: ManifestEntry,
        db: KanbanDatabase,
        workspaceId: string,
        workspaceRoot: string,
        plansDir: string,
        epicsDir: string,
        inBatchEpicIds: Set<string>,
        log?: (msg: string) => void
    ): Promise<'applied' | 'deferred'> {
        if (!entry || !entry.planFile || typeof entry.planFile !== 'string') {
            log?.(`[PlanManifest] Entry missing planFile; skipping.`);
            return 'applied'; // not deferrable — treat as handled (skip)
        }

        // Security: reject path traversal / absolute paths. planFile must resolve
        // strictly inside .switchboard/plans or .switchboard/epics for this workspace.
        if (path.isAbsolute(entry.planFile) || entry.planFile.includes('..')) {
            log?.(`[PlanManifest] Rejected path-traversal/absolute planFile: ${entry.planFile}`);
            return 'applied'; // not deferrable — invalid entry, skip
        }
        const resolved = path.resolve(workspaceRoot, entry.planFile);
        const plansRoot = path.resolve(plansDir);
        const epicsRoot = path.resolve(epicsDir);
        const insidePlans = resolved === plansRoot || resolved.startsWith(plansRoot + path.sep);
        const insideEpics = resolved === epicsRoot || resolved.startsWith(epicsRoot + path.sep);
        if (!insidePlans && !insideEpics) {
            log?.(`[PlanManifest] Rejected planFile outside plans/epics dir: ${entry.planFile}`);
            return 'applied'; // invalid, skip
        }

        // Ensure the .md row exists. If the file is on disk but not yet imported,
        // defer this cycle — the .md import pass (run before us) should pick it up
        // next cycle, or the watcher event will. If the file is missing entirely,
        // also defer (staleness guard will eventually drop it).
        let plan = await db.getPlanByPlanFile(entry.planFile, workspaceId);
        if (!plan) {
            if (!fs.existsSync(resolved)) {
                log?.(`[PlanManifest] .md not on disk yet, deferring entry: ${entry.planFile}`);
                return 'deferred';
            }
            // File exists but row missing — defer; the .md pass or watcher will import it.
            log?.(`[PlanManifest] Row not yet imported for existing .md, deferring entry: ${entry.planFile}`);
            return 'deferred';
        }

        // ── kanbanColumn (stale-manifest guard: only override if still CREATED) ──
        if (entry.kanbanColumn) {
            if (VALID_KANBAN_COLUMNS.has(entry.kanbanColumn)) {
                if (plan.kanbanColumn === 'CREATED') {
                    const moved = await db.movePlanByPlanFile(entry.planFile, workspaceId, entry.kanbanColumn);
                    if (!moved) {
                        log?.(`[PlanManifest] movePlanByPlanFile failed for ${entry.planFile} → ${entry.kanbanColumn}`);
                    }
                } else if (plan.kanbanColumn !== entry.kanbanColumn) {
                    log?.(`[PlanManifest] Stale-manifest guard: ${entry.planFile} already at '${plan.kanbanColumn}', not overriding to '${entry.kanbanColumn}' (epic/project still applied).`);
                }
            } else {
                log?.(`[PlanManifest] Invalid kanbanColumn '${entry.kanbanColumn}' for ${entry.planFile}; skipping column override.`);
            }
        }

        // ── status ──
        if (entry.status && VALID_STATUSES.has(entry.status)) {
            if (plan.status !== entry.status) {
                const ok = await db.updateStatusByPlanFile(entry.planFile, workspaceId, entry.status as 'active' | 'archived' | 'completed' | 'deleted');
                if (!ok) {
                    log?.(`[PlanManifest] updateStatusByPlanFile failed for ${entry.planFile} → ${entry.status}`);
                }
            }
        } else if (entry.status && !VALID_STATUSES.has(entry.status)) {
            log?.(`[PlanManifest] Invalid status '${entry.status}' for ${entry.planFile}; skipping status override.`);
        }

        // ── project ──
        if (entry.project) {
            const ok = await db.updatePlanProjectByPlanFile(entry.planFile, workspaceId, entry.project);
            if (!ok) {
                log?.(`[PlanManifest] updatePlanProjectByPlanFile failed (0 rows / race) for ${entry.planFile}`);
            }
        }

        // ── isEpic / epicId ──
        // Resolve epicId against in-batch epics first, then the DB.
        let resolvedEpicId = '';
        if (entry.epicId) {
            if (inBatchEpicIds.has(entry.epicId)) {
                resolvedEpicId = entry.epicId;
            } else {
                const epicPlan = await db.getPlanByPlanId(entry.epicId);
                if (epicPlan) {
                    resolvedEpicId = entry.epicId;
                } else {
                    log?.(`[PlanManifest] epicId '${entry.epicId}' does not resolve to an in-batch or DB epic; importing ${entry.planFile} without the link.`);
                }
            }
        }
        const isEpicVal = entry.isEpic ? 1 : 0;
        // Only touch epic state when the manifest actually specifies it (isEpic
        // present OR an epicId link to apply). A manifest that omits both must
        // leave existing epic state untouched — otherwise a column-only manifest
        // would clobber an epic's is_epic flag or strip its epic_id.
        if (entry.isEpic !== undefined || resolvedEpicId) {
            const planIdForEpic = entry.planId || plan.planId;
            if (planIdForEpic) {
                const ok = await db.updateEpicStatus(planIdForEpic, isEpicVal, resolvedEpicId);
                if (!ok) {
                    log?.(`[PlanManifest] updateEpicStatus failed for planId=${planIdForEpic}`);
                }
            }
        }

        return 'applied';
    }

    private async _safeDelete(manifestPath: string, log?: (msg: string) => void): Promise<void> {
        try {
            await fs.promises.unlink(manifestPath);
        } catch (err) {
            log?.(`[PlanManifest] Failed to delete manifest after consume: ${err}`);
        }
    }
}
