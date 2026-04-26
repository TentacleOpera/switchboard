import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';

export type LegacyKanbanSnapshotRow = {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    complexity: string;
    tags: string;
    dependencies: string;
    repoScope: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    lastAction: string;
    sourceType: 'local' | 'brain' | 'clickup-automation' | 'linear-automation';
};

export class KanbanMigration {
    public static readonly SCHEMA_VERSION = 2;

    private static _normalizeLegacyCodedColumn(column: string, lastAction?: string): string {
        if (column !== 'CODED') {
            return column;
        }

        const workflow = String(lastAction || '').trim().toLowerCase();
        if (workflow === 'handoff' || workflow === 'coder' || workflow === 'jules') {
            return 'CODER CODED';
        }

        return 'LEAD CODED';
    }

    private static _toKanbanPlanRecords(snapshotRows: LegacyKanbanSnapshotRow[]): KanbanPlanRecord[] {
        return snapshotRows.map(row => ({
            ...row,
            kanbanColumn: KanbanMigration._normalizeLegacyCodedColumn(row.kanbanColumn, row.lastAction),
            status: 'active',
            tags: row.tags || '',
            dependencies: row.dependencies || '',
            repoScope: row.repoScope || '',
            brainSourcePath: (row as any).brainSourcePath || '',
            mirrorPath: (row as any).mirrorPath || '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: ''
        }));
    }

    private static async _migrateLegacyCodedRows(db: KanbanDatabase, workspaceId: string): Promise<boolean> {
        const existingRows = await db.getBoard(workspaceId);
        for (const row of existingRows) {
            if (row.kanbanColumn !== 'CODED') {
                continue;
            }

            const remappedColumn = KanbanMigration._normalizeLegacyCodedColumn(row.kanbanColumn, row.lastAction);
            const updated = await db.updateColumn(row.sessionId, remappedColumn);
            if (!updated) {
                return false;
            }
        }

        return true;
    }

    public static async bootstrapIfNeeded(
        db: KanbanDatabase,
        workspaceId: string,
        snapshotRows: LegacyKanbanSnapshotRow[]
    ): Promise<boolean> {
        const ready = await db.ensureReady();
        if (!ready) return false;

        const currentVersion = await db.getMigrationVersion();
        const hasActivePlans = await db.hasActivePlans(workspaceId);

        if (!hasActivePlans) {
            // Guard: if the DB already has completed plans for this workspace,
            // the user finished all cards — don't re-bootstrap with derived columns.
            const completedPlans = await db.getCompletedPlans(workspaceId, 1);
            if (completedPlans.length === 0) {
                const rows = KanbanMigration._toKanbanPlanRecords(snapshotRows);
                const upserted = await db.upsertPlans(rows);
                if (!upserted) return false;
            }
        }

        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            const migrated = await KanbanMigration._migrateLegacyCodedRows(db, workspaceId);
            if (!migrated) return false;
            return db.setMigrationVersion(KanbanMigration.SCHEMA_VERSION);
        }

        return true;
    }

    /**
     * Sync snapshot rows into the DB. New plans are inserted with their derived
     * column; existing plans only get metadata updates (topic, plan_file, complexity).
     * kanban_column is never overwritten for existing rows. Status is only revived
     * from deleted -> active when a live snapshot row reappears for the same session.
     *
     * Uses batch operations: one `upsertPlans` for new plans, one `updateMetadataBatch`
     * for existing plans, and one optional deleted-row revival batch.
     */
    public static async syncPlansMetadata(
        db: KanbanDatabase,
        workspaceId: string,
        snapshotRows: LegacyKanbanSnapshotRow[],
        resolveComplexity?: (planFile: string) => Promise<string>,
        resolveTags?: (planFile: string) => Promise<string>,
        resolveDependencies?: (planFile: string) => Promise<string>,
        resolveRepoScope?: (planFile: string) => Promise<string>
    ): Promise<boolean> {
        const ready = await db.ensureReady();
        if (!ready) return false;

        if (snapshotRows.length > 0) {
            const existingIds = await db.getSessionIdSet();
            const newRows: LegacyKanbanSnapshotRow[] = [];
            const metadataUpdates: Array<{
                sessionId: string;
                topic: string;
                planFile: string;
                complexity?: string;
                tags?: string;
                dependencies?: string;
                repoScope?: string;
            }> = [];
            const deletedRowsToRevive = new Set<string>();

            for (const row of snapshotRows) {
                if (!existingIds.has(row.sessionId)) {
                    newRows.push(row);
                } else {
                    const existingRow = await db.getPlanBySessionId(row.sessionId);
                    if (existingRow?.status === 'deleted') {
                        deletedRowsToRevive.add(row.sessionId);
                    }
                    let resolvedComplexity: string | undefined;
                    if (row.complexity && row.complexity !== 'Unknown') {
                        resolvedComplexity = row.complexity;
                    } else if (resolveComplexity) {
                        resolvedComplexity = await resolveComplexity(row.planFile);
                    }
                    let resolvedTags: string | undefined;
                    if (row.tags) {
                        resolvedTags = row.tags;
                    } else if (resolveTags) {
                        const parsed = await resolveTags(row.planFile);
                        resolvedTags = parsed || undefined;
                    }
                    let resolvedDependencies: string | undefined;
                    if (row.dependencies) {
                        resolvedDependencies = row.dependencies;
                    } else if (resolveDependencies) {
                        const parsed = await resolveDependencies(row.planFile);
                        resolvedDependencies = parsed || undefined;
                    }
                    let resolvedRepoScope: string | undefined;
                    if (row.repoScope) {
                        resolvedRepoScope = row.repoScope;
                    } else if (resolveRepoScope) {
                        const parsed = await resolveRepoScope(row.planFile);
                        resolvedRepoScope = parsed || undefined;
                    }
                    metadataUpdates.push({
                        sessionId: row.sessionId,
                        topic: row.topic,
                        planFile: row.planFile,
                        complexity: resolvedComplexity,
                        tags: resolvedTags,
                        dependencies: resolvedDependencies,
                        repoScope: resolvedRepoScope
                    });
                }
            }

            if (newRows.length > 0) {
                const records = KanbanMigration._toKanbanPlanRecords(newRows);
                const inserted = await db.upsertPlans(records);
                if (!inserted) return false;
            }

            if (metadataUpdates.length > 0) {
                const updated = await db.updateMetadataBatch(metadataUpdates, { preserveTimestamps: true });
                if (!updated) return false;
            }

            if (deletedRowsToRevive.size > 0) {
                const revived = await db.reviveDeletedPlans([...deletedRowsToRevive]);
                if (!revived) return false;
            }
        }

        const currentVersion = await db.getMigrationVersion();
        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            const migrated = await KanbanMigration._migrateLegacyCodedRows(db, workspaceId);
            if (!migrated) return false;
            return db.setMigrationVersion(KanbanMigration.SCHEMA_VERSION);
        }

        return true;
    }
}
