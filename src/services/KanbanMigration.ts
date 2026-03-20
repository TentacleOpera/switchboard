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
            status: 'active'
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
            const rows = KanbanMigration._toKanbanPlanRecords(snapshotRows);
            const upserted = await db.upsertPlans(rows);
            if (!upserted) return false;
        }

        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            const migrated = await KanbanMigration._migrateLegacyCodedRows(db, workspaceId);
            if (!migrated) return false;
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

        const rows = KanbanMigration._toKanbanPlanRecords(snapshotRows);

        const upserted = await db.upsertPlans(rows);
        if (!upserted) return false;

        const currentVersion = await db.getMigrationVersion();
        if (currentVersion < KanbanMigration.SCHEMA_VERSION) {
            const migrated = await KanbanMigration._migrateLegacyCodedRows(db, workspaceId);
            if (!migrated) return false;
            return db.setMigrationVersion(KanbanMigration.SCHEMA_VERSION);
        }

        return true;
    }
}
