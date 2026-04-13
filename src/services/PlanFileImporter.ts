import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { buildKanbanColumns, parseCustomAgents, parseCustomKanbanColumns } from './agentConfig';
import { KanbanDatabase, KanbanPlanRecord, KanbanPlanStatus } from './KanbanDatabase';
import { inspectKanbanState } from './planStateUtils';

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

    const validKanbanColumns = await readImportableKanbanColumns(workspaceRoot);

    let workspaceId = await db.getWorkspaceId()
        || await db.getDominantWorkspaceId();

    const committedIdPath = path.join(workspaceRoot, '.switchboard', 'workspace-id');

    // Read the workspace-local workspace-id file if present.
    // Checked after DB so that the local machine's established ID takes precedence,
    // but before legacy/hash fallbacks so existing local workspaces keep using the same ID source.
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

    // Opportunistically write the workspace-local file (wx = exclusive create)
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

        const defaultSessionId = 'import_' + crypto.createHash('sha256')
            .update(filePath)
            .digest('hex')
            .slice(0, 16);
        const planId = extractEmbeddedMetadata(content, 'Plan ID') || defaultSessionId;
        const sessionId = extractEmbeddedMetadata(content, 'Session ID') || planId;
        const automationRuleName = extractEmbeddedMetadata(content, 'Automation Rule');
        const clickupTaskId = extractClickUpTaskId(content);
        const linearIssueId = extractLinearIssueId(content);
        const hasMixedAutomationMetadata = !!clickupTaskId && !!linearIssueId;
        let sourceType: KanbanPlanRecord['sourceType'] = 'local';
        if (hasMixedAutomationMetadata) {
            console.warn(
                `[PlanFileImporter] Found mixed ClickUp and Linear automation metadata in ${filePath.replace(/\\/g, '/')}; importing as local and ignoring provider-specific IDs.`
            );
        } else if (automationRuleName) {
            if (clickupTaskId) {
                sourceType = 'clickup-automation';
            } else if (linearIssueId) {
                sourceType = 'linear-automation';
            }
        }

        const topic = extractTopic(content, file);
        const complexity = extractComplexity(content);
        const tags = extractTags(content);
        const planFileNormalized = filePath.replace(/\\/g, '/');

        // Use embedded kanban state if present; fall back to defaults for
        // legacy files that pre-date the ## Switchboard State section.
        const embeddedStateInspection = inspectKanbanState(content, { validColumns: validKanbanColumns });
        const embeddedState = embeddedStateInspection.state;
        if (embeddedStateInspection.topLevelSectionCount > 1) {
            console.warn(
                `[PlanFileImporter] Detected ${embeddedStateInspection.topLevelSectionCount} top-level Switchboard State sections in ${planFileNormalized}; using the last valid section.`
            );
        } else if (!embeddedState && embeddedStateInspection.topLevelSectionCount > 0) {
            console.warn(
                `[PlanFileImporter] Found top-level Switchboard State section(s) in ${planFileNormalized} but '${embeddedStateInspection.lastSeenColumn || 'unknown'}' is not importable in this workspace; defaulting to CREATED/active.`
            );
        }

        const kanbanColumn = embeddedState?.kanbanColumn ?? 'CREATED';
        const status: KanbanPlanStatus = embeddedState?.status === 'completed' ? 'completed' : 'active';

        records.push({
            planId,
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
            sourceType,
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: hasMixedAutomationMetadata ? '' : clickupTaskId,
            linearIssueId: hasMixedAutomationMetadata ? '' : linearIssueId
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

function extractEmbeddedMetadata(content: string, label: string): string {
    const pattern = new RegExp(`^(?:>\\s+)?\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*\\s*(.+)$`, 'im');
    const match = content.match(pattern);
    return match ? match[1].trim() : '';
}

function extractClickUpTaskId(content: string): string {
    const explicitId = extractEmbeddedMetadata(content, 'ClickUp Task ID');
    if (explicitId) {
        return explicitId;
    }

    const importedMatch = content.match(/^>\s+Imported from ClickUp task\s+`([^`]+)`$/im);
    return importedMatch ? importedMatch[1].trim() : '';
}

function extractLinearIssueId(content: string): string {
    return extractEmbeddedMetadata(content, 'Linear Issue ID');
}

function extractTags(content: string): string {
    const tagsMatch = content.match(/## Metadata[\s\S]*?\*\*Tags:\*\*\s*(.+)/i);
    if (tagsMatch) {
        return tagsMatch[1].trim();
    }
    return '';
}

async function readImportableKanbanColumns(workspaceRoot: string): Promise<Set<string>> {
    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
    let customAgents: unknown[] = [];
    let customKanbanColumns: unknown[] = [];

    try {
        if (fs.existsSync(statePath)) {
            const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
            customAgents = Array.isArray(state.customAgents) ? state.customAgents : [];
            customKanbanColumns = Array.isArray(state.customKanbanColumns) ? state.customKanbanColumns : [];
        }
    } catch (error) {
        console.warn('[PlanFileImporter] Failed to read custom kanban column config from state.json:', error);
    }

    const validColumns = new Set(
        buildKanbanColumns(
            parseCustomAgents(customAgents),
            parseCustomKanbanColumns(customKanbanColumns)
        ).map((column) => column.id)
    );

    validColumns.add('BACKLOG');
    validColumns.add('CODED');

    return validColumns;
}
