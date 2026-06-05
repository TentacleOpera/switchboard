import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { NotionFetchService } from './NotionFetchService';
import { LocalFolderService } from './LocalFolderService';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { PlanningPanelCacheService } from './PlanningPanelCacheService';

export interface PlannerPromptWriterOptions {
    getNotionService: (workspaceRoot: string) => NotionFetchService;
    getLocalFolderService: (workspaceRoot: string) => LocalFolderService;
    getLinearDocsAdapter: (workspaceRoot: string) => LinearDocsAdapter;
    getClickUpDocsAdapter: (workspaceRoot: string) => ClickUpDocsAdapter;
    getCacheService: (workspaceRoot: string) => PlanningPanelCacheService;
    syncDesignDocLinkForActiveSources: (workspaceRoot: string) => Promise<string | null>;
}

export class PlannerPromptWriter {
    private _writeQueue = new Map<string, Promise<any>>();

    constructor(private _options: PlannerPromptWriterOptions) {}

    private async _getWorkspaceId(workspaceRoot: string): Promise<string> {
        // Derive from workspace root or use KanbanDatabase.forWorkspace(workspaceRoot).getWorkspaceId()
        try {
            const { KanbanDatabase } = require('./KanbanDatabase');
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            const wsId = await db.getWorkspaceId();
            if (wsId) return wsId;

            // If we have a DB instance but no workspace ID, something is wrong
            throw new Error(
                `[PlannerPromptWriter] No workspace_id configured in database for ${workspaceRoot}. ` +
                `Please run "Switchboard: Reset Kanban Database" to recreate.`
            );
        } catch (err) {
            // If it's our specific configuration error, rethrow it
            if (err instanceof Error && err.message.includes('No workspace_id configured')) {
                throw err;
            }
            // Otherwise it's a structural failure (require failed, etc.) - use hash as last resort
        }
        return crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
    }

    /**
     * Shared logic: write content to the first configured local docs folder.
     * Idempotent by design: same content → same filename → overwrite with identical content.
     * @param options.skipDesignDocLink - (DEPRECATED) If true, do NOT set designDocLink. Previously used by removed "Copy Link" feature.
     */
    private async _writeDocToDocsDir(
        workspaceRoot: string,
        content: string,
        docTitle: string,
        sourceId: string,
        options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string; targetFolder?: string } = {}
    ): Promise<{ success?: boolean; error?: string; source?: string; savedPath?: string; message?: string }> {
        const localFolderService = this._options.getLocalFolderService(workspaceRoot);
        const folderPaths = localFolderService.getFolderPaths();
        if (folderPaths.length === 0) {
            throw new Error("No local docs folder configured. Add a folder in the LOCAL DOCS tab before importing.");
        }
        let docsDir: string;
        if (options.targetFolder) {
            if (!folderPaths.includes(options.targetFolder)) {
                throw new Error(`Target folder "${options.targetFolder}" is not a configured local docs folder.`);
            }
            docsDir = options.targetFolder;
        } else {
            docsDir = folderPaths[0];
        }

        // Generate collision-resistant filename
        const rawSlug = (docTitle || sourceId)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || sourceId;

        await fs.promises.mkdir(docsDir, { recursive: true });

        let finalSlug = rawSlug;
        let suffix = 0;
        let newDocPath = path.join(docsDir, `${finalSlug}.md`);
        while (true) {
            try {
                const existingContent = await fs.promises.readFile(newDocPath, 'utf8');
                if (existingContent === content) {
                    break;
                }
                suffix++;
                finalSlug = `${rawSlug}_${suffix}`;
                newDocPath = path.join(docsDir, `${finalSlug}.md`);
            } catch (err) {
                break;
            }
        }

        // Write the doc without front-matter
        await fs.promises.writeFile(newDocPath, content, 'utf8');

        if (!options.skipDesignDocLink) {
            // Point designDocLink at the structured docs/ path AND enable the feature
            await vscode.workspace.getConfiguration('switchboard').update(
                'planner.designDocLink',
                newDocPath,
                vscode.ConfigurationTarget.Workspace
            );
            await vscode.workspace.getConfiguration('switchboard').update(
                'planner.designDocEnabled',
                true,
                vscode.ConfigurationTarget.Workspace
            );

            // Multi-source aggregation check
            let aggregatedPath: string | null = null;
            try {
                aggregatedPath = await this._options.syncDesignDocLinkForActiveSources(workspaceRoot);
            } catch (aggErr) {
                console.warn('[PlannerPromptWriter] aggregate cache sync failed:', aggErr);
            }

            const sourceName = this._sourceDisplayName(sourceId);
            return {
                success: true,
                source: sourceId,
                savedPath: newDocPath,
                message: aggregatedPath
                    ? `Design doc imported and activated from ${sourceName} (aggregated with other active sources)`
                    : `Design doc imported and activated from ${sourceName}`
            };
        }

        return {
            success: true,
            source: sourceId,
            savedPath: newDocPath,
            message: `Document imported to ${newDocPath}`
        };
    }

    private _sourceDisplayName(sourceId: string): string {
        const names: Record<string, string> = { notion: 'Notion', 'local-folder': 'Local Folder', linear: 'Linear Docs', clickup: 'ClickUp Docs', 'research-clipboard': 'Research' };
        return names[sourceId] || sourceId;
    }

    /**
     * Write content directly to the first configured local docs folder (used for pages that aren't cached).
     * Idempotent by design: same content → same filename → overwrite with identical content.
     */
    async writeContentToDocsDir(
        workspaceRoot: string,
        content: string,
        docTitle: string,
        sourceId: string,
        options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string; targetFolder?: string } = {}
    ): Promise<{ success?: boolean; error?: string; source?: string; savedPath?: string; message?: string }> {
        const resolvedRoot = path.resolve(workspaceRoot);
        const existingWrite = this._writeQueue.get(resolvedRoot);
        if (existingWrite) {
            return { error: 'Planner prompt update already in progress. Please wait.' };
        }

        const writePromise = (async () => {
            try {
                // Strip any YAML front-matter before writing
                const contentWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');

                const result = await this._writeDocToDocsDir(workspaceRoot, contentWithoutFrontMatter, docTitle, sourceId, options);

                // Note: Import registration is the caller's responsibility.
                // This method only has docTitle, not the source-specific docId needed for correct registration.

                return result;
            } catch (err) {
                return { error: String(err) };
            } finally {
                this._writeQueue.delete(resolvedRoot);
            }
        })();

        this._writeQueue.set(resolvedRoot, writePromise);
        return await writePromise;
    }

    /**
     * Write document from the planning cache (new cache system) to the first configured local docs folder.
     * Reads from PlanningPanelCacheService instead of old per-source cache files.
     */
    async writeFromPlanningCache(
        workspaceRoot: string,
        sourceId: string,
        docId: string,
        docName: string,
        options: { skipDesignDocLink?: boolean } = {}
    ): Promise<{ success?: boolean; error?: string; source?: string; savedPath?: string; message?: string }> {
        const resolvedRoot = path.resolve(workspaceRoot);
        const existingWrite = this._writeQueue.get(resolvedRoot);
        if (existingWrite) {
            return { error: 'Planner prompt update already in progress. Please wait.' };
        }

        const writePromise = (async () => {
            try {
                const cacheService = this._options.getCacheService(workspaceRoot);
                const cachedContent = await cacheService.getCachedDocument(sourceId, docId);
                if (!cachedContent) {
                    return { error: 'Document not found in planning cache. Please re-select the document.' };
                }

                // Strip YAML front-matter before writing to docs/
                const contentWithoutFrontMatter = cachedContent.replace(/^---\n[\s\S]*?\n---\n*/, '');

                const result = await this._writeDocToDocsDir(workspaceRoot, contentWithoutFrontMatter, docName, sourceId, options);

                // Note: Import registration is the caller's responsibility.
                // This method only has docName, not the source-specific docId needed for correct registration.

                return result;
            } catch (err) {
                return { error: String(err) };
            } finally {
                this._writeQueue.delete(resolvedRoot);
            }
        })();

        this._writeQueue.set(resolvedRoot, writePromise);
        return await writePromise;
    }

    async writeFromCache(
        workspaceRoot: string,
        sourceId: string,
        options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string } = {}
    ): Promise<{ success?: boolean; error?: string; source?: string; savedPath?: string; message?: string }> {
        // Serialize planner prompt writes per workspace to prevent race conditions
        const resolvedRoot = path.resolve(workspaceRoot);
        const existingWrite = this._writeQueue.get(resolvedRoot);
        if (existingWrite) {
            return { error: 'Planner prompt update already in progress. Please wait.' };
        }

        const writePromise = (async () => {
            try {
                let cachePath: string | null = null;
                let docTitle = '';

                switch (sourceId) {
                    case 'notion': {
                        const notionService = this._options.getNotionService(workspaceRoot);
                        const notionContent = await notionService.loadCachedContent();
                        if (!notionContent) {
                            return { error: 'No content available. Please fetch content first.' };
                        }
                        cachePath = path.join(workspaceRoot, '.switchboard', 'notion-cache.md');
                        const notionCfg = await notionService.loadConfig();
                        docTitle = notionCfg?.pageTitle || notionCfg?.designDocUrl || 'notion';
                        break;
                    }
                    case 'local-folder': {
                        const localService = this._options.getLocalFolderService(workspaceRoot);
                        const localContent = await localService.loadCachedContent();
                        if (!localContent) {
                            return { error: 'No content available. Please fetch content first.' };
                        }
                        cachePath = path.join(workspaceRoot, '.switchboard', 'local-folder-cache.md');
                        const localCfg = await localService.loadConfig();
                        docTitle = localCfg?.docTitle || 'local-folder';
                        break;
                    }
                    case 'linear': {
                        const linearAdapter = this._options.getLinearDocsAdapter(workspaceRoot);
                        const linearContent = await linearAdapter.loadCachedContent();
                        if (!linearContent) {
                            return { error: 'No content available. Please fetch content first.' };
                        }
                        cachePath = path.join(workspaceRoot, '.switchboard', 'linear-docs-cache.md');
                        const linearCfg = await linearAdapter.loadConfig();
                        docTitle = linearCfg?.docTitle || 'linear-docs';
                        break;
                    }
                    case 'clickup': {
                        const clickUpAdapter = this._options.getClickUpDocsAdapter(workspaceRoot);
                        const clickUpContent = await clickUpAdapter.loadCachedContent();
                        if (!clickUpContent) {
                            return { error: 'No content available. Please fetch content first.' };
                        }
                        cachePath = path.join(workspaceRoot, '.switchboard', 'clickup-docs-cache.md');
                        const clickUpCfg = await clickUpAdapter.loadConfig();
                        docTitle = clickUpCfg?.docTitle || 'clickup-docs';
                        break;
                    }
                }

                if (!cachePath) {
                    return { error: 'Invalid source specified.' };
                }

                // Read cached content — this also validates the cache file exists
                let content: string;
                try {
                    content = await fs.promises.readFile(cachePath, 'utf8');
                } catch {
                    return { error: 'Cache file not found. Please fetch content first.' };
                }

                // Strip YAML front-matter before writing
                const contentWithoutFrontMatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');

                return await this._writeDocToDocsDir(workspaceRoot, contentWithoutFrontMatter, docTitle, sourceId, options);
            } catch (err) {
                return { error: String(err) };
            } finally {
                this._writeQueue.delete(resolvedRoot);
            }
        })();

        this._writeQueue.set(resolvedRoot, writePromise);
        return await writePromise;
    }
}
