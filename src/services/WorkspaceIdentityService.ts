import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase } from './KanbanDatabase';

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i;

function isValidWorkspaceId(value: string): boolean {
    return WORKSPACE_ID_PATTERN.test(value) && value.length >= 8;
}

export async function tryWriteCommittedWorkspaceId(workspaceRoot: string, workspaceId: string): Promise<void> {
    const committedPath = path.join(path.resolve(workspaceRoot), '.switchboard', 'workspace-id');
    try {
        await fs.promises.mkdir(path.dirname(committedPath), { recursive: true });
        await fs.promises.writeFile(committedPath, `${workspaceId}\n`, { flag: 'wx' });
    } catch (error: any) {
        if (error?.code !== 'EEXIST') {
            console.warn('[WorkspaceIdentityService] Failed to write workspace-id file:', error);
        }
    }
}

export async function ensureWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const committedPath = path.join(resolvedRoot, '.switchboard', 'workspace-id');
    const legacyPath = path.join(resolvedRoot, '.switchboard', 'workspace_identity.json');
    const db = KanbanDatabase.forWorkspace(resolvedRoot);
    const dbReady = await db.ensureReady();

    if (dbReady) {
        const stored = await db.getWorkspaceId();
        if (stored) {
            await tryWriteCommittedWorkspaceId(resolvedRoot, stored);
            return stored;
        }
    }

    try {
        const fileContent = await fs.promises.readFile(committedPath, 'utf8');
        const trimmed = fileContent.trim();
        if (isValidWorkspaceId(trimmed)) {
            if (dbReady) {
                await db.setWorkspaceId(trimmed);
            }
            return trimmed;
        }
    } catch {
        // File does not exist or is unreadable.
    }

    if (dbReady) {
        const dominant = await db.getDominantWorkspaceId();
        if (dominant) {
            await db.setWorkspaceId(dominant);
            await tryWriteCommittedWorkspaceId(resolvedRoot, dominant);
            return dominant;
        }
    }

    try {
        if (fs.existsSync(legacyPath)) {
            const data = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
            const legacyWorkspaceId = typeof data?.workspaceId === 'string' ? data.workspaceId.trim() : '';
            if (isValidWorkspaceId(legacyWorkspaceId)) {
                if (dbReady) {
                    await db.setWorkspaceId(legacyWorkspaceId);
                }
                await tryWriteCommittedWorkspaceId(resolvedRoot, legacyWorkspaceId);
                return legacyWorkspaceId;
            }
        }
    } catch (error) {
        console.error('[WorkspaceIdentityService] Failed to read legacy workspace identity:', error);
    }

    const hashId = crypto.createHash('sha256').update(resolvedRoot).digest('hex').slice(0, 12);
    if (dbReady) {
        await db.setWorkspaceId(hashId);
    }
    await tryWriteCommittedWorkspaceId(resolvedRoot, hashId);
    return hashId;
}
