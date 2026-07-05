import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getProjectPrdPath } from '../prdUtils';
import type { ProjectContextBundle, ProjectContextDocument, ProjectContextPushResult } from './RemoteProvider';

/**
 * Project-context sync state (feature: Project Context & Remote UI Hub).
 *
 * Assembles the workspace's curated planning context — Dev Docs + project PRDs +
 * constitution, all authored in project.html — into one bundle for the provider
 * seam's `pushProjectContext`, and persists the sync state in the kanban DB
 * `config` table (the blessed home for state; never a JSON sidecar).
 *
 * The change gate is deliberately coarse (one hash over all content): Notion's
 * ~3 req/s budget is the binding constraint, and per the program plan there is
 * NO per-page content-hash machinery — that was the cut incremental design.
 */

export const PROJECT_CONTEXT_STATE_KEY = 'remote.projectContext';

export interface ProjectContextProviderStatus {
    ok: boolean;
    skipped?: boolean;
    detail?: string;
}

export interface ProjectContextSyncState {
    /** Auto-push after a Dev Doc / PRD / constitution save. Manual "Sync Now" ignores this. */
    enabled: boolean;
    /** sha256 of the assembled content (timestamp excluded) — the coarse change gate. */
    lastHash: string;
    /** ISO timestamp of the last completed push attempt. */
    lastSyncAt: string;
    /** Per-provider outcome of the last push attempt. */
    providers: { notion?: ProjectContextProviderStatus; linear?: ProjectContextProviderStatus };
    /** Human-readable summary of the last run ('skipped — unchanged', errors, …). */
    lastResult: string;
}

const DEFAULT_STATE: ProjectContextSyncState = {
    enabled: false,
    lastHash: '',
    lastSyncAt: '',
    providers: {},
    lastResult: '',
};

/** Minimal config surface — satisfied by KanbanDatabase, avoids an import cycle. */
export interface ProjectContextStateStore {
    getConfig(key: string): Promise<string | null>;
    setConfig(key: string, value: string): Promise<boolean>;
}

export async function loadProjectContextState(db: ProjectContextStateStore): Promise<ProjectContextSyncState> {
    try {
        const raw = await db.getConfig(PROJECT_CONTEXT_STATE_KEY);
        if (!raw) { return { ...DEFAULT_STATE }; }
        const parsed = JSON.parse(raw);
        return {
            enabled: parsed.enabled === true,
            lastHash: String(parsed.lastHash || ''),
            lastSyncAt: String(parsed.lastSyncAt || ''),
            providers: (parsed.providers && typeof parsed.providers === 'object') ? parsed.providers : {},
            lastResult: String(parsed.lastResult || ''),
        };
    } catch {
        return { ...DEFAULT_STATE };
    }
}

export async function saveProjectContextState(db: ProjectContextStateStore, state: ProjectContextSyncState): Promise<void> {
    await db.setConfig(PROJECT_CONTEXT_STATE_KEY, JSON.stringify(state));
}

export interface AssembleContextOptions {
    workspaceRoot: string;
    workspaceLabel: string;
    /** Board keys from remote.config ('' = base board). */
    boards: string[];
    /** Resolved constitution path (constitutionUtils.getConstitutionPath — may not exist). */
    constitutionPath: string;
    /** Project names from the kanban DB — PRD paths derive from these. */
    projectNames: string[];
}

/**
 * Read the current project-context documents from disk and assemble the bundle.
 * Returns null when there is no context at all (nothing authored yet).
 */
export async function assembleProjectContextBundle(
    opts: AssembleContextOptions
): Promise<{ bundle: ProjectContextBundle; hash: string } | null> {
    const documents: ProjectContextDocument[] = [];

    const readIfExists = async (filePath: string): Promise<string | null> => {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            return content.trim() ? content : null;
        } catch {
            return null;
        }
    };

    const constitution = await readIfExists(opts.constitutionPath);
    if (constitution) {
        documents.push({ kind: 'constitution', title: 'Workspace Constitution', markdown: constitution });
    }

    for (const projectName of opts.projectNames) {
        const prd = await readIfExists(getProjectPrdPath(opts.workspaceRoot, projectName));
        if (prd) {
            documents.push({ kind: 'prd', title: projectName, markdown: prd });
        }
    }

    const devDocsDir = path.join(opts.workspaceRoot, '.switchboard', 'devdocs');
    let devDocFiles: string[] = [];
    try { devDocFiles = (await fs.promises.readdir(devDocsDir)).filter(f => f.endsWith('.md')).sort(); } catch { /* none */ }
    for (const file of devDocFiles) {
        const markdown = await readIfExists(path.join(devDocsDir, file));
        if (!markdown) { continue; }
        const heading = markdown.match(/^#\s+(.+)$/m);
        documents.push({ kind: 'devdoc', title: heading ? heading[1].trim() : file.replace(/\.md$/, ''), markdown });
    }

    if (documents.length === 0) { return null; }

    // Hash over the stable content only — the syncedAt banner must not defeat the gate.
    const hash = crypto.createHash('sha256')
        .update(documents.map(d => [d.kind, d.title, d.markdown].join('\u0000')).join('\u0001'))
        .digest('hex');

    const syncedAt = new Date().toISOString();
    const sectionFor = (d: ProjectContextDocument): string => {
        const label = d.kind === 'constitution' ? d.title
            : d.kind === 'prd' ? `PRD — ${d.title}`
            : `Dev Doc — ${d.title}`;
        return `## ${label}\n\n${d.markdown.trim()}\n`;
    };
    const combinedMarkdown = [
        `# Switchboard Project Context — ${opts.workspaceLabel}`,
        '',
        `> Synced from Switchboard (project.html) at ${syncedAt}. **Do not edit this document here** — it is regenerated on every sync and edits will be overwritten. Author plans as cards; author context changes in Switchboard's Project panel.`,
        '',
        ...documents.map(sectionFor),
    ].join('\n');

    return {
        bundle: {
            workspaceLabel: opts.workspaceLabel,
            boards: opts.boards,
            documents,
            combinedMarkdown,
            syncedAt,
        },
        hash,
    };
}

/** Fold per-provider results into the persisted state + a one-line summary. */
export function summarizePushResults(results: { notion?: ProjectContextPushResult; linear?: ProjectContextPushResult }): {
    providers: ProjectContextSyncState['providers'];
    lastResult: string;
} {
    const parts: string[] = [];
    for (const [name, result] of Object.entries(results)) {
        if (!result) { continue; }
        if (result.skipped) { parts.push(`${name}: skipped (${result.detail || 'not configured'})`); }
        else if (result.ok) { parts.push(`${name}: ${result.detail || 'ok'}`); }
        else { parts.push(`${name}: FAILED — ${result.detail || 'unknown error'}`); }
    }
    return {
        providers: results,
        lastResult: parts.join(' · ') || 'nothing to push',
    };
}
