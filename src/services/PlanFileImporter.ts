import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { KanbanDatabase, KanbanPlanRecord, KanbanPlanStatus } from './KanbanDatabase';
import { ensureWorkspaceIdentity } from './WorkspaceIdentityService';

type ImportablePlanFile = {
    filePath: string;
    repoScope: string;
};

export interface ImportPlanFilesResult {
    count: number;
    planFiles: string[];
    /** Maps planFile → kanbanColumn for integration sync */
    columns: Record<string, string>;
}

/**
 * Scans top-level `.switchboard/plans/*.md` files plus one immediate
 * `.switchboard/plans/<repoName>/*.md` layer and upserts records into the
 * kanban DB.
 * Used by the "Reset Database" command to repopulate from plan files.
 * All imported plans default to CREATED/active. The KanbanDatabase is the
 * sole source of truth for plan state.
 */
export async function importPlanFiles(workspaceRoot: string, effectiveStateRoot?: string): Promise<ImportPlanFilesResult> {
    // Resolve effective root for shared database support
    const effectiveRoot = effectiveStateRoot || workspaceRoot;

    const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
    if (!fs.existsSync(plansDir)) {
        return { count: 0, planFiles: [], columns: {} };
    }

    const files = await listImportablePlanFiles(plansDir);

    if (files.length === 0) {
        return { count: 0, planFiles: [], columns: {} };
    }

    // Use effectiveRoot for DB and identity to ensure shared database consistency
    const db = KanbanDatabase.forWorkspace(effectiveRoot);
    const ready = await db.ensureReady();
    if (!ready) {
        return { count: 0, planFiles: [], columns: {} };
    }

    const workspaceId = await ensureWorkspaceIdentity(effectiveRoot);
    const workspaceMappings = await db.getWorkspaceMappings();
    const workspaceNameMap = new Map(workspaceMappings.mappings.map(m => [m.id, m.name]));

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

        const planId = extractEmbeddedMetadata(content, 'Plan ID') || uuidv4();
        const sessionId = ''; // session_id is no longer the unique key; plan_file+workspace_id is
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
        let planFileNormalized = filePath.replace(/\\/g, '/');

        // For control plane workspaces, store path relative to workspace root (not repo scope)
        const isControlPlane = await detectControlPlaneWorkspace(workspaceRoot);
        if (isControlPlane && file.repoScope && planFileNormalized.startsWith(`${file.repoScope}/`)) {
            planFileNormalized = planFileNormalized.substring(`${file.repoScope}/`.length);
        }

        if (file.repoScope && embeddedRepoScope && embeddedRepoScope !== file.repoScope) {
            console.warn(
                `[PlanFileImporter] Repo scope mismatch in ${planFileNormalized}; using folder scope '${file.repoScope}' instead of embedded metadata '${embeddedRepoScope}'.`
            );
        }

        // Always default to CREATED/active - KanbanDatabase is the sole source of truth
        const kanbanColumn = 'CREATED';
        const status: KanbanPlanStatus = 'active';

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
            linearIssueId: hasMixedAutomationMetadata ? '' : linearIssueId,
            workspaceName: workspaceNameMap.get(workspaceId) || '',
            projectId: null
        });
    }

    if (records.length === 0) {
        return { count: 0, planFiles: [], columns: {} };
    }

    const success = await db.upsertPlans(records);
    if (!success) {
        return { count: 0, planFiles: [], columns: {} };
    }
    const columns: Record<string, string> = {};
    for (const record of records) {
        columns[record.planFile] = record.kanbanColumn;
    }
    return {
        count: records.length,
        planFiles: records.map(r => r.planFile),
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

export function isRuntimeMirrorPlanFile(fileName: string): boolean {
    return /^brain_[0-9a-f]{64}\.md$/i.test(fileName)
        || /^ingested_[0-9a-f]{64}\.md$/i.test(fileName);
}

export function extractRepoScope(content: string): string {
    const match = content.match(/## Metadata[\s\S]*?\*\*Repo:\*\*\s*([^\r\n]+)/i);
    return sanitizeRepoScope(match ? match[1] : '');
}

async function detectControlPlaneWorkspace(workspaceRoot: string): Promise<boolean> {
    try {
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const raw = await db.getConfig('workspace_mappings');
        if (!raw) return false;
        const mappings = JSON.parse(raw);
        return Array.isArray(mappings) && mappings.length > 0;
    } catch {
        return false;
    }
}

