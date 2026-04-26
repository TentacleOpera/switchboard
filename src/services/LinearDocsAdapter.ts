import { LinearSyncService } from './LinearSyncService';
import { ResearchSourceAdapter, ResearchFile, TreeNode } from './ResearchImportService';
import * as path from 'path';
import * as fs from 'fs';

export interface LinearDocConfig {
    docId: string;
    docTitle: string;
    docUrl: string;
    setupComplete: boolean;
    lastFetchAt: string | null;
}

export class LinearDocsAdapter implements ResearchSourceAdapter {
    readonly sourceId = 'linear';
    private _workspaceRoot: string;
    private _configPath: string;
    private _cachePath: string;
    private _linearService: LinearSyncService;
    private readonly MAX_CHARS = 50000;

    constructor(workspaceRoot: string, linearService: LinearSyncService) {
        this._workspaceRoot = workspaceRoot;
        this._configPath = path.join(workspaceRoot, '.switchboard', 'linear-docs-config.json');
        this._cachePath = path.join(workspaceRoot, '.switchboard', 'linear-docs-cache.md');
        this._linearService = linearService;
    }

    async loadConfig(): Promise<LinearDocConfig | null> {
        try {
            const content = await fs.promises.readFile(this._configPath, 'utf8');
            return JSON.parse(content);
        } catch { return null; }
    }

    async saveConfig(config: LinearDocConfig): Promise<void> {
        await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
        await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
    }

    async loadCachedContent(): Promise<string | null> {
        try {
            return await fs.promises.readFile(this._cachePath, 'utf8');
        } catch { return null; }
    }

    async saveCachedContent(markdown: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(this._cachePath), { recursive: true });
        await fs.promises.writeFile(this._cachePath, markdown, 'utf8');
    }

    // ── ResearchSourceAdapter ────────────────────────────────────

    async listFiles(): Promise<ResearchFile[]> {
        const docs = await this.listDocuments();
        return docs.map(d => ({
            id: d.id,
            name: d.title,
            source: 'linear',
            url: d.url
        }));
    }

    async fetchContent(fileId: string): Promise<string> {
        const docId = fileId.startsWith('doc:') ? fileId.slice(4) : fileId;
        const result = await this.fetchDocContent(docId);
        if (result.success && result.content) return result.content;
        return (await this.loadCachedContent()) || '';
    }

    async fetchChildren(parentId?: string): Promise<TreeNode[]> {
        const config = await this._linearService.loadConfig();
        if (!config || !config.setupComplete) { return []; }

        try {
            // Root → list teams
            if (parentId === undefined) {
                const query = `
                    query {
                        teams(first: 50) {
                            nodes {
                                id
                                name
                            }
                        }
                    }
                `;
                const result = await this._linearService.graphqlRequest(query);
                return result.data.teams.nodes.map((team: any) => ({
                    id: `team:${team.id}`,
                    name: team.name,
                    kind: 'folder' as const,
                    hasChildren: true
                }));
            }

            // team:<id> → list projects
            if (parentId.startsWith('team:')) {
                const teamId = parentId.slice(5);
                const query = `
                    query($tid: String!) {
                        team(id: $tid) {
                            projects(first: 50) {
                                nodes {
                                    id
                                    name
                                }
                            }
                        }
                    }
                `;
                const result = await this._linearService.graphqlRequest(query, { tid: teamId });
                return result.data.team?.projects?.nodes?.map((project: any) => ({
                    id: `project:${project.id}`,
                    name: project.name,
                    kind: 'folder' as const,
                    parentId,
                    hasChildren: true
                })) || [];
            }

            // project:<id> → list documents
            if (parentId.startsWith('project:')) {
                const projectId = parentId.slice(8);
                const query = `
                    query($pid: String!) {
                        project(id: $pid) {
                            documents(first: 50) {
                                nodes {
                                    id
                                    title
                                    url
                                }
                            }
                        }
                    }
                `;
                const result = await this._linearService.graphqlRequest(query, { pid: projectId });
                return result.data.project?.documents?.nodes?.map((doc: any) => ({
                    id: `doc:${doc.id}`,
                    name: doc.title,
                    kind: 'document' as const,
                    parentId,
                    hasChildren: false,
                    url: doc.url
                })) || [];
            }

            // doc:<id> → no children
            return [];
        } catch {
            return [];
        }
    }

    async listContainers(): Promise<TreeNode[]> {
        const config = await this._linearService.loadConfig();
        if (!config || !config.setupComplete) { return []; }
        try {
            const query = `
                query {
                    teams(first: 50) {
                        nodes {
                            id
                            name
                        }
                    }
                }
            `;
            const result = await this._linearService.graphqlRequest(query);
            return result.data.teams.nodes.map((team: any) => ({
                id: `team:${team.id}`,
                name: team.name,
                kind: 'folder' as const,
                hasChildren: true
            }));
        } catch { return []; }
    }

    async listDocumentsByContainer(containerId: string): Promise<TreeNode[]> {
        const config = await this._linearService.loadConfig();
        if (!config || !config.setupComplete) { return []; }
        try {
            if (containerId.startsWith('team:')) {
                const teamId = containerId.slice(5);
                const query = `
                    query($tid: String!) {
                        team(id: $tid) {
                            documents(first: 50) {
                                nodes {
                                    id
                                    title
                                    url
                                }
                            }
                        }
                    }
                `;
                const result = await this._linearService.graphqlRequest(query, { tid: teamId });
                return result.data.team?.documents?.nodes?.map((doc: any) => ({
                    id: `doc:${doc.id}`,
                    name: doc.title,
                    kind: 'document' as const,
                    hasChildren: false,
                    url: doc.url
                })) || [];
            }
            if (containerId.startsWith('project:')) {
                const projectId = containerId.slice(8);
                const query = `
                    query($pid: String!) {
                        project(id: $pid) {
                            documents(first: 50) {
                                nodes {
                                    id
                                    title
                                    url
                                }
                            }
                        }
                    }
                `;
                const result = await this._linearService.graphqlRequest(query, { pid: projectId });
                return result.data.project?.documents?.nodes?.map((doc: any) => ({
                    id: `doc:${doc.id}`,
                    name: doc.title,
                    kind: 'document' as const,
                    hasChildren: false,
                    url: doc.url
                })) || [];
            }
            return [];
        } catch { return []; }
    }

    // ── Extended API for dropdown + fetch ────────────────────────

    async listDocuments(): Promise<Array<{ id: string; title: string; url: string }>> {
        const config = await this._linearService.loadConfig();
        if (!config || !config.setupComplete || !config.teamId) { return []; }

        try {
            const query = `
                query {
                    documents(first: 50) {
                        nodes {
                            id
                            title
                            url
                        }
                    }
                }
            `;
            // Fixed: Using existing graphqlRequest instead of executeGraphQL
            const result = await this._linearService.graphqlRequest(query);
            return result.data.documents.nodes.map((doc: any) => ({
                id: doc.id,
                title: doc.title,
                url: doc.url
            }));
        } catch { return []; }
    }

    async fetchDocContent(docId: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }> {
        try {
            const query = `
                query($id: ID!) {
                    document(id: $id) {
                        id
                        title
                        url
                        content
                    }
                }
            `;
            const result = await this._linearService.graphqlRequest(query, { id: docId });
            const doc = result.data.document;
            if (!doc) { return { success: false, error: 'Document not found' }; }

            const header = `# ${doc.title}\n\n${doc.url ? `> Fetched from Linear Docs: ${doc.url}\n\n` : '\n'}`;
            let fullContent = header + (doc.content || '');

            // Truncation parity with Notion
            if (fullContent.length > this.MAX_CHARS) {
                const truncated = fullContent.substring(0, this.MAX_CHARS);
                const lastHeading = truncated.lastIndexOf('\n#');
                if (lastHeading > 0) {
                    fullContent = truncated.substring(0, lastHeading) + '\n\n*[Truncated due to size limits]*';
                } else {
                    fullContent = truncated + '\n\n*[Truncated due to size limits]*';
                }
            }

            await this.saveConfig({
                docId,
                docTitle: doc.title,
                docUrl: doc.url,
                setupComplete: true,
                lastFetchAt: new Date().toISOString()
            });
            await this.saveCachedContent(fullContent);

            return { success: true, docTitle: doc.title, content: fullContent };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    async updateContent(fileId: string, content: string): Promise<{ success: boolean; error?: string }> {
        try {
            // Size guard
            const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
            if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
                return { success: false, error: 'Content exceeds 1MB size limit for sync' };
            }

            // Linear uses GraphQL mutations to update document content
            const query = `
                mutation($id: ID!, $content: String!) {
                    documentUpdate(id: $id, input: { content: $content }) {
                        success
                    }
                }
            `;
            const result = await this._linearService.graphqlRequest(query, { id: fileId, content });
            
            if (result.data?.documentUpdate?.success) {
                return { success: true };
            }
            return { success: false, error: 'Linear API update failed' };
        } catch (err) {
            return { success: false, error: String(err) };
        }
    }
}
