import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { KanbanDatabase, KanbanPlanRecord, KanbanPlanStatus } from './KanbanDatabase';
import { extractKanbanState } from './planStateUtils';

/**
 * Scans `.switchboard/plans/*.md` and upserts records into the kanban DB.
 * Used by the "Reset Database" command to repopulate from plan files.
 * When a plan file contains a `## Switchboard State` section, the embedded
 * kanban column and status are used instead of defaulting to CREATED/active.
 */
export async function importPlanFiles(workspaceRoot: string): Promise<number> {
    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
    if (!fs.existsSync(plansDir)) {
        return 0;
    }

    const files = (await fs.promises.readdir(plansDir))
        .filter(f => f.endsWith('.md'));

    if (files.length === 0) {
        return 0;
    }

    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const ready = await db.ensureReady();
    if (!ready) {
        return 0;
    }

    let workspaceId = await db.getWorkspaceId()
        || await db.getDominantWorkspaceId();

    const committedIdPath = path.join(workspaceRoot, '.switchboard', 'workspace-id');

    // Read the committed workspace-id file (cross-machine stable ID).
    // Checked after DB so that the local machine's established ID takes precedence,
    // but before legacy/hash fallbacks so fresh clones pick up the team's ID.
    if (!workspaceId) {
        try {
            const fileContent = await fs.promises.readFile(committedIdPath, 'utf-8');
            const trimmed = fileContent.trim();
            if (/^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i.test(trimmed) && trimmed.length >= 8) {
                workspaceId = trimmed;
            }
        } catch {
            // File doesn't exist or unreadable — fall through
        }
    }

    if (!workspaceId) {
        // Legacy workspace_identity.json fallback (backward compat)
        const legacyIdPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (fs.existsSync(legacyIdPath)) {
                const data = JSON.parse(await fs.promises.readFile(legacyIdPath, 'utf-8'));
                if (typeof data?.workspaceId === 'string' && data.workspaceId.length > 0) {
                    workspaceId = data.workspaceId;
                }
            }
        } catch { /* ignore parse errors */ }
    }

    if (!workspaceId) {
        // Deterministic hash fallback — stable for the same absolute path
        workspaceId = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
    }

    // Persist the resolved workspace ID so downstream consumers (board queries,
    // _getOrCreateWorkspaceId) find it in the config table immediately.
    await db.setWorkspaceId(workspaceId);

    // Opportunistically write committed file for cross-machine sync (wx = exclusive create)
    try {
        await fs.promises.mkdir(path.dirname(committedIdPath), { recursive: true });
        await fs.promises.writeFile(committedIdPath, workspaceId + '\n', { flag: 'wx' });
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            console.warn('[PlanFileImporter] Failed to write workspace-id file:', err);
        }
    }

    const now = new Date().toISOString();
    const records: KanbanPlanRecord[] = [];

    for (const file of files) {
        const filePath = path.join(plansDir, file);
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf-8');
        } catch {
            continue;
        }

        const sessionId = 'import_' + crypto.createHash('sha256')
            .update(filePath)
            .digest('hex')
            .slice(0, 16);

        const topic = extractTopic(content, file);
        const complexity = extractComplexity(content);
        const tags = extractTags(content);
        const planFileNormalized = filePath.replace(/\\/g, '/');

        // Use embedded kanban state if present; fall back to defaults for
        // legacy files that pre-date the ## Switchboard State section.
        const embeddedState = extractKanbanState(content);
        const kanbanColumn = embeddedState?.kanbanColumn ?? 'CREATED';
        const status: KanbanPlanStatus = (embeddedState?.status === 'completed' ? 'completed' : 'active');

        records.push({
            planId: sessionId,
            sessionId,
            topic,
            planFile: planFileNormalized,
            kanbanColumn,
            status,
            complexity,
            tags,
            dependencies: '',
            workspaceId,
            createdAt: now,
            updatedAt: now,
            lastAction: 'imported_from_plan_file',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: ''
        });
    }

    if (records.length === 0) {
        return 0;
    }

    const success = await db.upsertPlans(records);
    return success ? records.length : 0;
}

function extractTopic(content: string, filename: string): string {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    return filename.replace(/\.md$/i, '').replace(/[_-]/g, ' ');
}

function extractComplexity(content: string): string {
    const metadataMatch = content.match(/## Metadata[\s\S]*?\*\*Complexity:\*\*\s*(Low|High|[\d]{1,2})/i);
    if (metadataMatch) {
        const val = metadataMatch[1];
        const lowVal = val.toLowerCase();
        if (lowVal === 'low') return '3';
        if (lowVal === 'high') return '8';
        const num = parseInt(val, 10);
        if (!isNaN(num) && num >= 1 && num <= 10) return num.toString();
    }
    return 'Unknown';
}

function extractTags(content: string): string {
    const tagsMatch = content.match(/## Metadata[\s\S]*?\*\*Tags:\*\*\s*(.+)/i);
    if (tagsMatch) {
        return tagsMatch[1].trim();
    }
    return '';
}
