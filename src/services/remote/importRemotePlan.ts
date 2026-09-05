import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';

/**
 * Create a new local plan file + DB record from a remote item (a Linear issue or a Notion
 * page) the inbound poll found with no local counterpart. Lands in the workspace plans dir
 * on the CREATED column; the caller then sets the provider id and (optionally) mirrors the
 * remote column. Returns the saved record, or null on failure.
 */
export async function importRemoteMarkdownPlan(opts: {
    db: KanbanDatabase;
    workspaceId: string;
    plansDir: string;
    title: string;
    body: string;
    sourceType: KanbanPlanRecord['sourceType'];
}): Promise<KanbanPlanRecord | null> {
    const { db, workspaceId, plansDir, title, body, sourceType } = opts;
    const id = crypto.randomUUID();
    const slug = (title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'plan';
    const filename = `${slug}-${id}.md`;
    // Write to the intake folder, then move to plans/ after the DB row is written.
    // The record's planFile points to the archive destination, not intake.
    const intakeDir = path.join(plansDir, 'intake');
    const intakeAbsPath = path.join(intakeDir, filename);
    const archiveAbsPath = path.join(plansDir, filename);
    const provenance = `> **Provenance:** Author: remote (${sourceType || 'unknown'}) | Status: Unreviewed\n\n`;
    const fullBody = body ? `${provenance}${body}` : `${provenance}# ${title || 'Untitled'}\n`;
    await fs.promises.mkdir(intakeDir, { recursive: true });
    await fs.promises.writeFile(intakeAbsPath, fullBody, 'utf8');

    const now = new Date().toISOString();
    const record: KanbanPlanRecord = {
        planId: id, sessionId: id, topic: title || 'Untitled', planFile: archiveAbsPath,
        kanbanColumn: 'CREATED', status: 'active', complexity: 'Unknown', tags: '',
        repoScope: '', project: '', workspaceId, createdAt: now, updatedAt: now,
        lastAction: 'imported from remote', sourceType, brainSourcePath: '', mirrorPath: '',
        routedTo: '', dispatchedAgent: '', dispatchedIde: '',
    };
    const ok = await db.insertFileDerivedPlan(record);
    if (!ok) { return null; }
    // Move from intake to archive after the DB row is committed.
    try {
        await fs.promises.rename(intakeAbsPath, archiveAbsPath);
    } catch (moveErr) {
        // Non-fatal: the file is in intake and the record points to the archive.
        // The scanner will not re-import it (the record exists), but the file
        // should be moved manually or on next scan.
        console.warn(`[importRemotePlan] Intake move failed: ${moveErr}`);
    }
    return (await db.getPlanByPlanFile(archiveAbsPath, workspaceId)) || record;
}
