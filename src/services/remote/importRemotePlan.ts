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
    const absPath = path.join(plansDir, `${slug}-${id}.md`);
    await fs.promises.mkdir(plansDir, { recursive: true });
    await fs.promises.writeFile(absPath, body, 'utf8');

    const now = new Date().toISOString();
    const record: KanbanPlanRecord = {
        planId: id, sessionId: id, topic: title || 'Untitled', planFile: absPath,
        kanbanColumn: 'CREATED', status: 'active', complexity: 'Unknown', tags: '',
        repoScope: '', project: '', workspaceId, createdAt: now, updatedAt: now,
        lastAction: 'imported from remote', sourceType, brainSourcePath: '', mirrorPath: '',
        routedTo: '', dispatchedAgent: '', dispatchedIde: '',
    };
    const ok = await db.insertFileDerivedPlan(record);
    if (!ok) { return null; }
    return (await db.getPlanByPlanFile(absPath, workspaceId)) || record;
}
