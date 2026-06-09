import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URL } from 'url';
import { ClickUpSyncService } from './ClickUpSyncService';
import { LinearSyncService } from './LinearSyncService';

interface LocalApiServerOptions {
    workspaceRoot: string;
    clickupMetadataPath: string;
    linearMetadataPath: string;
    getClickUpService: () => ClickUpSyncService | null;
    getLinearService: () => LinearSyncService | null;
    getAuthToken: () => Promise<string>;
}

export class LocalApiServer {
    private _server: http.Server | null = null;
    private _port: number;
    private _options: LocalApiServerOptions;
    private _nameResolutionCache: Map<string, { id: string; timestamp: number }> = new Map();
    private readonly _CACHE_TTL_MS = 30000; // 30 seconds
    private readonly _MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    private _mermaidCliAvailable: boolean | null = null;

    constructor(options: LocalApiServerOptions) {
        this._options = options;
        this._port = 0; // Will be assigned on start
    }

    /**
     * Start the local API server on a random free port.
     * Returns the port number.
     */
    async start(): Promise<number> {
        // Cleanup temp files from previous interrupted writes
        await this._cleanupTempFiles();

        return new Promise((resolve, reject) => {
            this._server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
                await this._handleRequest(req, res);
            });

            this._server.listen(0, '127.0.0.1', () => {
                const address = this._server?.address() as { port: number };
                this._port = address.port;
                console.log(`[LocalApiServer] Started on port ${this._port}`);

                // Write port to file for agent discovery
                this._writePortFile(this._port).catch(err => {
                    console.warn('[LocalApiServer] Failed to write port file:', err);
                });

                resolve(this._port);
            });

            this._server.on('error', (err: Error) => {
                console.error('[LocalApiServer] Server error:', err);
                reject(err);
            });
        });
    }

    /**
     * Stop the local API server.
     */
    async stop(): Promise<void> {
        if (this._server) {
            return new Promise((resolve) => {
                this._server?.close(() => {
                    console.log('[LocalApiServer] Stopped');
                    resolve();
                });
            });
        }
    }

    /**
     * Cleanup temp files from interrupted writes.
     */
    private async _cleanupTempFiles(): Promise<void> {
        try {
            const switchboardDir = path.join(this._options.workspaceRoot, '.switchboard');
            const files = await fs.readdir(switchboardDir);
            for (const file of files) {
                if (file.endsWith('.json.tmp')) {
                    await fs.unlink(path.join(switchboardDir, file)).catch(() => {
                        // Ignore errors (file may be locked on Windows)
                    });
                }
            }
        } catch {
            // Directory may not exist yet
        }
    }

    /**
     * Write the server port to a file for agent discovery.
     */
    private async _writePortFile(port: number): Promise<void> {
        const portFilePath = path.join(this._options.workspaceRoot, '.switchboard', 'api-server-port.txt');
        await fs.mkdir(path.dirname(portFilePath), { recursive: true });
        await fs.writeFile(portFilePath, port.toString(), 'utf8');
    }

    private async _checkAuth(req: http.IncomingMessage, requireAuth: boolean = true): Promise<boolean> {
        const authHeader = req.headers['authorization'];
        const expectedToken = await this._options.getAuthToken();
        
        // CLARIFICATION: Phase 2 - strict enforcement for write operations
        if (!expectedToken) {
            if (requireAuth) {
                return false; // No token configured, deny write operations
            }
            return true; // Allow read-only if no token (backward compat)
        }
        
        return authHeader === `Bearer ${expectedToken}`;
    }

    private async _parseJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let body = '';
            let bodySize = 0;
            req.on('data', chunk => {
                body += chunk;
                bodySize += chunk.length;
                if (bodySize > this._MAX_FILE_SIZE_BYTES) {
                    req.destroy();
                    reject(new Error('Payload too large'));
                }
            });
            req.on('end', () => {
                try {
                    if (!body) {
                        resolve(null);
                        return;
                    }
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error('Invalid JSON body'));
                }
            });
            req.on('error', reject);
        });
    }

    private _pruneCache(): void {
        if (this._nameResolutionCache.size < 100) return; // Prevent O(N^2) pruning
        const now = Date.now();
        for (const [key, value] of this._nameResolutionCache.entries()) {
            if (now - value.timestamp >= this._CACHE_TTL_MS) {
                this._nameResolutionCache.delete(key);
            }
        }
    }

    private async _handleClickUpApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, false)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { method, endpoint, query, body: apiBody } = body || {};
            
            // Validate inputs
            if (!method || !endpoint) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing method or endpoint' }));
                return;
            }
            
            // Call ClickUp API via service
            const result = await service.makeApiRequest(method, endpoint, query, apiBody);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] ClickUp API proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
        }
    }

    private async _handleCreateClickUpTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // CLARIFICATION: Strict auth enforcement for write operations
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { name, listId, description, assignees, dueDate, subtasks } = body;
            
            // Validation
            if (!name || !listId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: name and listId' }));
                return;
            }
            
            // Create parent task first
            const parentTask = await service.createTask({
                name,
                listId,
                description,
                assignees,
                dueDate
            });
            
            // Create subtasks if provided
            let createdSubtasks: any[] = [];
            let failedSubtasks: any[] = [];
            
            if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
                for (let i = 0; i < subtasks.length; i++) {
                    const subtask = subtasks[i];
                    try {
                        const created = await service.createTask({
                            name: subtask.name,
                            listId,
                            description: subtask.description,
                            assignees: subtask.assignees,
                            dueDate: subtask.dueDate,
                            parent: parentTask?.id
                        });
                        createdSubtasks.push(created);
                    } catch (err) {
                        console.warn(`[LocalApiServer] Subtask creation failed for index ${i}:`, err);
                        // CLARIFICATION: Record failed subtasks instead of failing silently
                        failedSubtasks.push({
                            index: i,
                            name: subtask.name,
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                }
            }
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                task: parentTask,
                subtasks: createdSubtasks,
                subtaskCount: createdSubtasks.length,
                failedSubtasks: failedSubtasks.length > 0 ? failedSubtasks : undefined
            }));
        } catch (err) {
            console.error('[LocalApiServer] Task creation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task creation failed' }));
        }
    }

    private async _handleUpdateClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            
            // CLARIFICATION: Build update payload only with provided fields
            const updatePayload: any = {};
            
            if ('name' in body) updatePayload.name = body.name;
            if ('description' in body) updatePayload.description = body.description;
            if ('status' in body) updatePayload.status = body.status;
            if ('assignees' in body) updatePayload.assignees = body.assignees;
            if ('dueDate' in body) {
                const date = new Date(body.dueDate);
                if (!isNaN(date.getTime())) {
                    updatePayload.due_date = date.getTime();
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid dueDate format' }));
                    return;
                }
            }
            if ('priority' in body) updatePayload.priority = body.priority;
            if ('tags' in body) updatePayload.tags = body.tags;
            
            // Validate at least one field provided
            if (Object.keys(updatePayload).length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No fields provided for update' }));
                return;
            }
            
            const result = await service.updateTask(taskId, updatePayload);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                task: result,
                updatedFields: Object.keys(updatePayload)
            }));
        } catch (err) {
            console.error('[LocalApiServer] Task update error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task update failed' }));
        }
    }

    private async _handleAttachFile(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { fileName, fileDataBase64, comment } = body;
            
            // Validation
            if (!fileName || !fileDataBase64) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: fileName and fileDataBase64' }));
                return;
            }
            
            // Check file size (Base64 is ~4/3 of binary size)
            const estimatedSize = (fileDataBase64.length * 3) / 4;
            if (estimatedSize > this._MAX_FILE_SIZE_BYTES) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'File too large',
                    maxSize: `${this._MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
                    receivedSize: `${(estimatedSize / 1024 / 1024).toFixed(2)}MB`
                }));
                return;
            }
            
            // Validate file extension
            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.txt', '.md', '.json'];
            const ext = path.extname(fileName).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'File type not allowed',
                    allowedTypes: allowedExtensions
                }));
                return;
            }
            
            // Decode Base64
            let buffer: Buffer;
            try {
                // Buffer.from silently ignores invalid base64 characters, so we must strictly validate
                const stripped = fileDataBase64.replace(/\s/g, '');
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
                    throw new Error('Invalid Base64 data');
                }
                buffer = Buffer.from(stripped, 'base64');
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid Base64 data' }));
                return;
            }
            
            // Upload via service
            const result = await service.attachFile(taskId, fileName, buffer, comment);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                url: result.url,
                fileName: result.fileName,
                size: buffer.length
            }));
        } catch (err) {
            console.error('[LocalApiServer] File attachment error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Upload failed' }));
        }
    }

    private async _handleCreateDocPage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { workspaceId, docId, pageName, content, parentPageId } = body;
            
            // Validation
            if (!docId || !pageName || !content) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: docId, pageName, content' }));
                return;
            }
            
            const result = await service.createDocPage({
                workspaceId,
                docId,
                pageName,
                content,
                parentPageId
            });
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                pageId: result.id,
                url: result.url,
                docId,
                pageName
            }));
        } catch (err) {
            console.error('[LocalApiServer] Doc page creation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: err instanceof Error ? err.message : 'Doc page creation failed',
                hint: 'Ensure docId is valid and you have write access to the document'
            }));
        }
    }

    private async _checkMermaidCli(): Promise<boolean> {
        if (this._mermaidCliAvailable !== null) {
            return this._mermaidCliAvailable;
        }
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            // Check for mmdc (mermaid-cli binary)
            const cmd = process.platform === 'win32' ? 'where mmdc' : 'which mmdc';
            await execAsync(cmd);
            this._mermaidCliAvailable = true;
        } catch {
            this._mermaidCliAvailable = false;
        }
        return this._mermaidCliAvailable;
    }

    private _generateMermaidSyntax(diagramType: string, maxNodes: number, focusPath?: string): string {
        // CLARIFICATION: This is a placeholder - actual implementation would use ArchitectureAnalyzer
        return `graph TD\nA[Start] --> B[End]`;
    }

    private async _handleGenerateDiagram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }
        
        try {
            const body = await this._parseJsonBody(req);
            const { diagramType, maxNodes, focusPath, detailLevel, targetId, platform } = body;
            
            // Validate required fields
            if (!diagramType) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: diagramType' }));
                return;
            }
            
            // Generate Mermaid syntax (always available)
            const mermaidSyntax = this._generateMermaidSyntax(diagramType, maxNodes || 50, focusPath);
            
            // Check if mermaid-cli is available
            const canRender = await this._checkMermaidCli();
            
            if (!canRender) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    rendered: false,
                    warning: 'mermaid-cli not installed. Install with: npm install -g @mermaid-js/mermaid-cli',
                    mermaidSyntax: mermaidSyntax,
                    installCommand: 'npm install -g @mermaid-js/mermaid-cli'
                }));
                return;
            }
            
            // Render using mermaid-cli
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const os = require('os');
            const crypto = require('crypto');
            
            const safeId = crypto.randomUUID();
            const tempPath = path.join(os.tmpdir(), `diagram-${safeId}.mmd`);
            const tempOutputPath = `${tempPath}.png`;
            
            // Write Mermaid syntax to temp file
            await fs.writeFile(tempPath, mermaidSyntax);
            
            try {
                // Render with mermaid-cli
                await execAsync(`mmdc -i "${tempPath}" -o "${tempOutputPath}" -b transparent`);
                
                // Read rendered image
                const imageBuffer = await fs.readFile(tempOutputPath);
                
                // Upload to platform if target provided
                if (targetId && platform) {
                    let uploadResult;
                    if (platform === 'clickup') {
                        const service = this._options.getClickUpService();
                        if (!service) throw new Error('ClickUp service not available');
                        uploadResult = await service.attachFile(targetId, 'diagram.png', imageBuffer, 'Generated diagram');
                    } else if (platform === 'linear') {
                        const service = this._options.getLinearService();
                        if (!service) throw new Error('Linear service not available');
                        uploadResult = await service.uploadAttachment(targetId, imageBuffer, 'diagram.png');
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        rendered: true, 
                        url: uploadResult?.url,
                        uploadedTo: platform,
                        targetId
                    }));
                } else {
                    // Return image directly
                    res.writeHead(200, { 
                        'Content-Type': 'image/png',
                        'Content-Disposition': 'attachment; filename="diagram.png"'
                    });
                    res.end(imageBuffer);
                }
            } catch (renderErr) {
                console.warn('[LocalApiServer] Diagram render failed:', renderErr);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    rendered: false,
                    warning: 'Render failed: ' + (renderErr instanceof Error ? renderErr.message : 'Unknown error'),
                    mermaidSyntax: mermaidSyntax,
                    renderError: renderErr instanceof Error ? renderErr.message : 'Unknown'
                }));
            } finally {
                // Cleanup temp files
                await fs.unlink(tempPath).catch(() => {});
                await fs.unlink(tempOutputPath).catch(() => {});
            }
        } catch (err) {
            console.error('[LocalApiServer] Diagram generation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Diagram generation failed' }));
        }
    }

    private async _handleLinearApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, false)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Unauthorized',
                detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window'
            }));
            return;
        }

        const service = this._options.getLinearService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Linear service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { query, variables } = body || {};
            
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing GraphQL query' }));
                return;
            }
            
            const result = await service.makeGraphQLRequest(query, variables);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] Linear API proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
        }
    }

    private async _handleResolveName(source: string, name: string, res: http.ServerResponse): Promise<void> {
        const cacheKey = `${source}:${name}`;
        const cached = this._nameResolutionCache.get(cacheKey);
        
        // Return cached result if valid
        if (cached && Date.now() - cached.timestamp < this._CACHE_TTL_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: cached.id, cached: true }));
            return;
        }
        
        try {
            let id: string | null = null;
            
            if (source === 'clickup') {
                const service = this._options.getClickUpService();
                if (!service) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                    return;
                }
                id = await service.resolveNameToId(name);
            } else if (source === 'linear') {
                const service = this._options.getLinearService();
                if (!service) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Linear service not available' }));
                    return;
                }
                id = await service.resolveNameToId(name);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid source. Use "clickup" or "linear"' }));
                return;
            }
            
            if (!id) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Name "${name}" not found in ${source}` }));
                return;
            }
            
            // Cache the result and prune old entries
            this._nameResolutionCache.set(cacheKey, { id, timestamp: Date.now() });
            this._pruneCache();
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, cached: false }));
        } catch (err) {
            console.error('[LocalApiServer] Name resolution error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Resolution failed' }));
        }
    }

    /**
     * Handle incoming HTTP requests.
     */
    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Restrict to localhost only
        const remoteAddress = req.socket.remoteAddress;
        if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: localhost only' }));
            return;
        }

        // Add CORS headers - allow any localhost origin
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const pathname = url.pathname;

        try {
            if (pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', port: this._port }));
            } else if (pathname === '/metadata/clickup' && req.method === 'GET') {
                await this._handleGetMetadata('clickup', res);
            } else if (pathname === '/metadata/linear' && req.method === 'GET') {
                await this._handleGetMetadata('linear', res);
            } else if (pathname.startsWith('/task/clickup/') && req.method === 'GET') {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('clickup', taskId, res);
            } else if (pathname.startsWith('/task/linear/') && req.method === 'GET') {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('linear', taskId, res);
            } else if (pathname === '/task/clickup' && req.method === 'POST') {
                await this._handleCreateClickUpTask(req, res);
            } else if (pathname.startsWith('/task/clickup/') && req.method === 'PUT') {
                const taskId = pathname.split('/')[3];
                await this._handleUpdateClickUpTask(taskId, req, res);
            } else if (pathname === '/api/clickup' && req.method === 'POST') {
                await this._handleClickUpApiProxy(req, res);
            } else if (pathname === '/api/linear' && req.method === 'POST') {
                await this._handleLinearApiProxy(req, res);
            } else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/attach') && req.method === 'POST') {
                const taskId = pathname.split('/')[3];
                await this._handleAttachFile(taskId, req, res);
            } else if (pathname === '/doc/clickup' && req.method === 'POST') {
                await this._handleCreateDocPage(req, res);
            } else if (pathname === '/diagram/generate' && req.method === 'POST') {
                await this._handleGenerateDiagram(req, res);
            } else if (pathname.startsWith('/resolve/') && req.method === 'GET') {
                const parts = pathname.split('/');
                const source = parts[2]; // 'clickup' or 'linear'
                const name = decodeURIComponent(parts[4]);
                await this._handleResolveName(source, name, res);
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] Request error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Handle GET /metadata/{source} requests.
     */
    private async _handleGetMetadata(sourceId: string, res: http.ServerResponse): Promise<void> {
        const filePath = sourceId === 'clickup'
            ? this._options.clickupMetadataPath
            : this._options.linearMetadataPath;

        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch {
            // File doesn't exist or is invalid — return empty metadata
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 1, sourceId, metadata: [], writtenAt: Date.now() }));
        }
    }

    /**
     * Handle GET /task/{source}/{taskId} requests.
     */
    private async _handleGetTask(sourceId: string, taskId: string, res: http.ServerResponse): Promise<void> {
        if (sourceId === 'clickup') {
            const service = this._options.getClickUpService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                return;
            }

            try {
                const details = await service.getTaskDetails(taskId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(details));
            } catch (err) {
                console.error('[LocalApiServer] ClickUp task fetch error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch task details' }));
            }
        } else if (sourceId === 'linear') {
            const service = this._options.getLinearService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Linear service not available' }));
                return;
            }

            try {
                const issue = await service.getIssue(taskId);
                let subtasks: any[] = [];
                let comments: any[] = [];
                let attachments: any[] = [];
                if (issue) {
                    try { subtasks = await service.getSubtasks(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear subtasks:', e);
                    }
                    try { comments = await service.getComments(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear comments:', e);
                    }
                    try { attachments = await service.getAttachments(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear attachments:', e);
                    }
                }

                if (!issue) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Linear issue ${taskId} not found` }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ issue, subtasks, comments, attachments }));
            } catch (err) {
                console.error('[LocalApiServer] Linear issue fetch error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch issue details' }));
            }
        }
    }
}
