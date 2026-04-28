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

    /**
     * Shared logic: write content to .switchboard/docs/ with hash-based filename.
     * Idempotent by design: same content → same hash → same filename → overwrite with identical content.
     * @param options.skipDesignDocLink - (DEPRECATED) If true, do NOT set designDocLink. Previously used by removed "Copy Link" feature.
     */
    private async _writeDocToDocsDir(
        workspaceRoot: string,
        content: string,
        docTitle: string,
        sourceId: string,
        options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string } = {}
    ): Promise<{ success?: boolean; error?: string; source?: string; savedPath?: string; message?: string }> {
        // Generate collision-resistant filename
        const rawSlug = (docTitle || sourceId)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || sourceId;
        const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
        const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
        await fs.promises.mkdir(docsDir, { recursive: true });
        const newDocPath = path.join(docsDir, `${rawSlug}_${contentHash}.md`);

        // Add front-matter with original metadata for display purposes
        // Store order from pageOrder option (defaults to 0)
        const order = options.pageOrder ?? 0;
        const frontMatter = `---
docName: ${docTitle}
sourceId: ${sourceId}
slugPrefix: ${rawSlug}_${contentHash}
order: ${order}
parentDocName: ${options.parentDocName || docTitle}
---

`;
        const contentWithFrontMatter = frontMatter + content;

        // Write the doc (idempotent: same content hash = same file)
        await fs.promises.writeFile(newDocPath, contentWithFrontMatter, 'utf8');

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
        const names: Record<string, string> = { notion: 'Notion', 'local-folder': 'Local Folder', linear: 'Linear Docs', clickup: 'ClickUp Docs' };
        return names[sourceId] || sourceId;
    }

    /**
     * Write content directly to .switchboard/docs/ (used for pages that aren't cached).
     * Idempotent by design: same content → same hash → same filename → overwrite with identical content.
     */
    async writeContentToDocsDir(
        workspaceRoot: string,
        content: string,
        docTitle: string,
        sourceId: string,
        options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string } = {}
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

                // Register import in the import registry
                if (result.success && result.savedPath) {
                    try {
                        const cacheService = this._options.getCacheService(workspaceRoot);
                        const rawSlug = (docTitle || sourceId)
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, '_')
                            .replace(/^_+|_+$/g, '')
                            .slice(0, 60) || sourceId;
                        const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                        await cacheService.registerImport(sourceId, docTitle, docTitle, rawSlug, { remoteContentHash: contentHash });
                    } catch (regErr) {
                        console.warn('[PlannerPromptWriter] Failed to register import:', regErr);
                    }
                }

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
     * Write document from the planning cache (new cache system) to .switchboard/docs/.
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

                // Register import in the import registry
                if (result.success && result.savedPath) {
                    try {
                        const rawSlug = (docName || sourceId)
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, '_')
                            .replace(/^_+|_+$/g, '')
                            .slice(0, 60) || sourceId;
                        const contentHash = crypto.createHash('sha256').update(contentWithoutFrontMatter).digest('hex');
                        await cacheService.registerImport(sourceId, docId, docName, rawSlug, { remoteContentHash: contentHash });
                    } catch (regErr) {
                        console.warn('[PlannerPromptWriter] Failed to register import:', regErr);
                    }
                }

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
        sourceId: string
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

                return await this._writeDocToDocsDir(workspaceRoot, content, docTitle, sourceId);
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
