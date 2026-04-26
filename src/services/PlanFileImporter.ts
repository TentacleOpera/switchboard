import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { buildKanbanColumns, parseCustomAgents, parseCustomKanbanColumns } from './agentConfig';
import { KanbanDatabase, KanbanPlanRecord, KanbanPlanStatus } from './KanbanDatabase';
import { inspectKanbanState } from './planStateUtils';
import { ensureWorkspaceIdentity } from './WorkspaceIdentityService';

type ImportablePlanFile = {
    filePath: string;
    repoScope: string;
};

export interface ImportPlanFilesResult {
    count: number;
    sessionIds: string[];
    /** Maps sessionId → kanbanColumn for integration sync */
    columns: Record<string, string>;
}

/**
 * Scans top-level `.switchboard/plans/*.md` files plus one immediate
 * `.switchboard/plans/<repoName>/*.md` layer and upserts records into the
 * kanban DB.
 * Used by the "Reset Database" command to repopulate from plan files.
 * When a plan file contains a `## Switchboard State` section, the embedded
 * kanban column and status are used instead of defaulting to CREATED/active.
 */
export async function importPlanFiles(workspaceRoot: string, effectiveStateRoot?: string): Promise<ImportPlanFilesResult> {
    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
    if (!fs.existsSync(plansDir)) {
        return { count: 0, sessionIds: [], columns: {} };
    }

    const files = await listImportablePlanFiles(plansDir);

    if (files.length === 0) {
        return { count: 0, sessionIds: [], columns: {} };
    }

    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const ready = await db.ensureReady();
    if (!ready) {
        return { count: 0, sessionIds: [], columns: {} };
    }

    const validKanbanColumns = await readImportableKanbanColumns(
        resolveImportableStateRoot(workspaceRoot, effectiveStateRoot)
    );

    const workspaceId = await ensureWorkspaceIdentity(workspaceRoot);

    const now = new Date().toISOString();
    const records: KanbanPlanRecord[] = [];

    for (const file of files) {
        const filePath = file.filePath;
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

        const topic = extractTopic(content, path.basename(filePath));
        const complexity = extractComplexity(content);
        const tags = extractTags(content);
        const embeddedRepoScope = extractRepoScope(content);
        const repoScope = file.repoScope || embeddedRepoScope;
        const planFileNormalized = filePath.replace(/\\/g, '/');
        if (file.repoScope && embeddedRepoScope && embeddedRepoScope !== file.repoScope) {
            console.warn(
                `[PlanFileImporter] Repo scope mismatch in ${planFileNormalized}; using folder scope '${file.repoScope}' instead of embedded metadata '${embeddedRepoScope}'.`
            );
        }

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
            repoScope,
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
        return { count: 0, sessionIds: [], columns: {} };
    }

    const success = await db.upsertPlans(records);
    if (!success) {
        return { count: 0, sessionIds: [], columns: {} };
    }
    const columns: Record<string, string> = {};
    for (const record of records) {
        columns[record.sessionId] = record.kanbanColumn;
    }
    return {
        count: records.length,
        sessionIds: records.map(r => r.sessionId),
        columns
    };
}

async function listImportablePlanFiles(plansDir: string): Promise<ImportablePlanFile[]> {
    const entries = await fs.promises.readdir(plansDir, { withFileTypes: true });
    const files: ImportablePlanFile[] = [];

    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
            if (isRuntimeMirrorPlanFile(entry.name)) {
                continue;
            }
            files.push({
                filePath: path.join(plansDir, entry.name),
                repoScope: ''
            });
            continue;
        }

        if (!entry.isDirectory()) {
            continue;
        }

        const repoScope = sanitizeRepoScope(entry.name);
        if (!repoScope) {
            continue;
        }

        const repoDir = path.join(plansDir, entry.name);
        const childEntries = await fs.promises.readdir(repoDir, { withFileTypes: true });
        for (const childEntry of childEntries) {
            if (!childEntry.isFile() || !childEntry.name.endsWith('.md')) {
                continue;
            }
            if (isRuntimeMirrorPlanFile(childEntry.name)) {
                continue;
            }
            files.push({
                filePath: path.join(repoDir, childEntry.name),
                repoScope
            });
        }
    }

    return files.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function resolveImportableStateRoot(workspaceRoot: string, effectiveStateRoot?: string): string {
    const providedStateRoot = String(effectiveStateRoot || '').trim();
    if (providedStateRoot) {
        return path.resolve(providedStateRoot);
    }
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const directParentRoot = path.dirname(resolvedWorkspaceRoot);
    if (directParentRoot !== resolvedWorkspaceRoot) {
        const parentKanbanDb = path.join(directParentRoot, '.switchboard', 'kanban.db');
        if (fs.existsSync(parentKanbanDb)) {
            return directParentRoot;
        }
    }
    return resolvedWorkspaceRoot;
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

export function sanitizeRepoScope(raw: string): string {
    const value = String(raw || '').trim().replace(/^['"`]|['"`]$/g, '');
    if (!value || value.includes('/') || value.includes('\\') || value.includes('.')) {
        return '';
    }
    return value;
}

function isRuntimeMirrorPlanFile(fileName: string): boolean {
    return /^brain_[0-9a-f]{64}\.md$/i.test(fileName)
        || /^ingested_[0-9a-f]{64}\.md$/i.test(fileName);
}

export function extractRepoScope(content: string): string {
    const match = content.match(/## Metadata[\s\S]*?\*\*Repo:\*\*\s*([^\r\n]+)/i);
    return sanitizeRepoScope(match ? match[1] : '');
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
