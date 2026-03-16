import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';

export type LegacyKanbanSnapshotRow = {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    complexity: 'Unknown' | 'Low' | 'High';
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    lastAction: string;
    sourceType: 'local' | 'brain';
};

export class KanbanMigration {
    public static readonly SCHEMA_VERSION = 1;

    public static async bootstrapAndSync(
        db: KanbanDatabase,
        workspaceId: string,
        snapshotRows: LegacyKanbanSnapshotRow[]
    ): Promise<boolean> {
        const ready = await db.ensureReady();
        if (!ready) return false;

        const rows: KanbanPlanRecord[] = snapshotRows.map(row => ({
            ...row,
            status: 'active'
        }));
        const activePlanIds = new Set(rows.map(row => row.planId));
        const currentVersion = await db.getMigrationVersion();

        const upserted = await db.upsertPlans(rows);
        if (!upserted) return false;
        const archived = await db.markMissingAsArchived(workspaceId, activePlanIds);
        if (!archived) return false;

        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            return db.setMigrationVersion(KanbanMigration.SCHEMA_VERSION);
        }

        return true;
    }
}
