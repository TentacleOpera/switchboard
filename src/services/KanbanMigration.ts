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
            const rows: KanbanPlanRecord[] = snapshotRows.map(row => ({
                ...row,
                status: 'active'
            }));
            const upserted = await db.upsertPlans(rows);
            if (!upserted) return false;
        }

        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            return db.setMigrationVersion(KanbanMigration.SCHEMA_VERSION);
        }

        return true;
    }

    public static async syncNewPlansOnly(
        db: KanbanDatabase,
        workspaceId: string,
        snapshotRows: LegacyKanbanSnapshotRow[]
    ): Promise<boolean> {
        const ready = await db.ensureReady();
        if (!ready) return false;

        const activePlanIds = new Set<string>();
        const newRows: KanbanPlanRecord[] = [];

        for (const row of snapshotRows) {
            activePlanIds.add(row.planId);
            if (await db.hasPlan(row.sessionId)) {
                continue;
            }
            newRows.push({
                ...row,
                status: 'active'
            });
        }

        const upserted = await db.upsertPlans(newRows);
        if (!upserted) return false;
        const archived = await db.markMissingAsArchived(workspaceId, activePlanIds);
        if (!archived) return false;

        const currentVersion = await db.getMigrationVersion();
        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            return db.setMigrationVersion(KanbanMigration.SCHEMA_VERSION);
        }

        return true;
    }
}
