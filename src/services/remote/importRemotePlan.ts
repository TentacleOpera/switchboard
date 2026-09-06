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
    // Written straight to the archive, NOT via plans/intake/. Intake is the door
    // for writers that rely on the scanner to import; this function inserts its
    // own row below, so an intake hop it immediately renames out of would be
    // invisible to the scanner — and a failed rename would leave a file the
    // scanner imports as a SECOND card for the row created here.
    const archiveAbsPath = path.join(plansDir, filename);
    // Provenance marker: a reviewer sees what authored this plan without
    // consulting a queue or a comment history. Placed above the body so it
    // survives a body rewrite; the H1 the importer parses is still the body's.
    const provenance = `> **Provenance:** Author: remote (${sourceType || 'unknown'}) | Status: Unreviewed\n\n`;
    const fullBody = body ? `${provenance}${body}` : `${provenance}# ${title || 'Untitled'}\n`;
    await fs.promises.mkdir(plansDir, { recursive: true });
    await fs.promises.writeFile(archiveAbsPath, fullBody, 'utf8');

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
    return (await db.getPlanByPlanFile(archiveAbsPath, workspaceId)) || record;
}
