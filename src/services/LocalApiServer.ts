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
}

export class LocalApiServer {
    private _server: http.Server | null = null;
    private _port: number;
    private _options: LocalApiServerOptions;

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
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'GET') {
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
            } else if (pathname === '/metadata/clickup') {
                await this._handleGetMetadata('clickup', res);
            } else if (pathname === '/metadata/linear') {
                await this._handleGetMetadata('linear', res);
            } else if (pathname.startsWith('/task/clickup/')) {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('clickup', taskId, res);
            } else if (pathname.startsWith('/task/linear/')) {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('linear', taskId, res);
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
