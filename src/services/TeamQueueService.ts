import * as fs from 'fs';
import * as path from 'path';

/**
 * Team Work Queue — file-based per-team work queue, reusing the inbox
 * primitives from ScheduledJobsService.ts.
 *
 * Storage layout:
 *   .switchboard/teams/<groupId>/queue/           — pending items
 *   .switchboard/teams/<groupId>/queue/claimed/   — claim sidecars
 *
 * Each item is a markdown file with YAML-like frontmatter:
 *   ---
 *   kind: plan|prompt|card
 *   planId: <optional>
 *   feature: <optional>
 *   target: head|any-member|<memberName>
 *   priority: <optional integer>
 *   enqueued_ts: <ISO>
 *   ---
 *   <body — the prompt text or plan reference>
 *
 * Claim sidecars live in `claimed/<filename>.claim` and carry
 * `claimed_ts` + `agent`. A claim older than the staleness window (24h
 * default) is reclaimable.
 *
 * Security: groupId and item filenames are validated against path
 * traversal BEFORE any filesystem call. The traversal guard rejects
 * `../`, absolute paths, and URL-encoded traversal. No caller-supplied
 * path fragment is ever interpolated into a filesystem path.
 */

/** Maximum item body size — 256 KB. Prompts have practical CLI limits,
 *  and the image paste path caps at 4 MB; a queue item is a prompt, not
 *  a file transfer. Reject at enqueue rather than truncating at dispatch. */
export const MAX_QUEUE_ITEM_BODY = 256 * 1024;

/** Claim staleness in hours. A claim older than this is reclaimable. */
export const CLAIM_STALENESS_HOURS = 24;

/** A single queue item as returned by listQueue. */
export interface QueueItem {
    id: string;          // filename without extension
    filename: string;    // full filename including .md
    kind: string;        // 'plan' | 'prompt' | 'card'
    planId?: string;
    feature?: string;
    target: string;      // 'head' | 'any-member' | <memberName>
    priority: number;
    enqueuedTs: string;  // ISO
    body: string;
    state: 'pending' | 'claimed';
    claimedBy?: string;
    claimedTs?: string;
}

export interface QueueListResult {
    success: boolean;
    items?: QueueItem[];
    error?: string;
}

export interface QueueEnqueueResult {
    success: boolean;
    item?: QueueItem;
    error?: string;
}

export interface QueueClaimResult {
    success: boolean;
    item?: QueueItem;
    error?: string;
}

export interface QueueReorderResult {
    success: boolean;
    error?: string;
}

/**
 * Validate that an id (groupId or item id) is a safe path component.
 * Rejects `../`, absolute paths, URL-encoded traversal, and any character
 * that is not alphanumeric, underscore, hyphen, or dot. This guard MUST
 * run before any DB lookup or filesystem call.
 */
export function isSafeId(id: string): boolean {
    if (!id || typeof id !== 'string') { return false; }
    // Reject empty, path separators, parent traversal, and absolute paths.
    if (id.includes('/') || id.includes('\\') || id.includes('..')) { return false; }
    if (path.isAbsolute(id)) { return false; }
    // Reject URL-encoded traversal (%2e, %2f, %5c).
    const decoded = (() => { try { return decodeURIComponent(id); } catch { return id; } })();
    if (decoded !== id && (decoded.includes('/') || decoded.includes('\\') || decoded.includes('..'))) {
        return false;
    }
    // Only allow safe characters: alphanumeric, underscore, hyphen, dot.
    return /^[a-zA-Z0-9._-]+$/.test(id);
}

/**
 * Lazily creates `.switchboard/teams/<groupId>/queue/` with a `claimed/`
 * subdirectory. Returns the queue directory path, or `null` when
 * `.switchboard/` is absent — same lazy guard as
 * `bootstrapInstructionsDirectory`.
 *
 * `groupId` MUST be validated by `isSafeId` BEFORE calling this function.
 */
export async function bootstrapTeamQueue(workspaceRoot: string, groupId: string): Promise<string | null> {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    if (!fs.existsSync(sbDir)) {
        return null;
    }
    const queueDir = path.join(sbDir, 'teams', groupId, 'queue');
    const claimedDir = path.join(queueDir, 'claimed');
    await fs.promises.mkdir(claimedDir, { recursive: true });
    return queueDir;
}

/**
 * Parse a queue item file's frontmatter + body into a QueueItem.
 * Defensive against malformed frontmatter — a missing or unparseable
 * field degrades to a default, never throws.
 */
function parseQueueItem(filename: string, content: string, claimed: boolean, claimData?: { agent?: string; ts?: string }): QueueItem {
    const id = filename.replace(/\.md$/, '');
    const lines = content.split('\n');
    const fm: Record<string, string> = {};
    let bodyStart = 0;

    if (lines[0] && lines[0].trim() === '---') {
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
                bodyStart = i + 1;
                break;
            }
            const match = lines[i].match(/^(\w+):\s*(.*)$/);
            if (match) {
                fm[match[1]] = match[2].trim();
            }
        }
    }

    const body = lines.slice(bodyStart).join('\n').trim();
    return {
        id,
        filename,
        kind: fm.kind || 'prompt',
        planId: fm.planId || undefined,
        feature: fm.feature || undefined,
        target: fm.target || 'head',
        priority: fm.priority ? parseInt(fm.priority, 10) || 0 : 0,
        enqueuedTs: fm.enqueued_ts || fm.created || new Date().toISOString(),
        body,
        state: claimed ? 'claimed' : 'pending',
        claimedBy: claimData?.agent,
        claimedTs: claimData?.ts,
    };
}

/** Read a claim sidecar if it exists and is fresh. Returns claim data or null. */
async function readClaim(claimedDir: string, filename: string): Promise<{ agent: string; ts: string } | null> {
    const claimPath = path.join(claimedDir, `${filename}.claim`);
    try {
        const content = await fs.promises.readFile(claimPath, 'utf8');
        const tsMatch = content.match(/claimed_ts:\s*([^\n]+)/);
        const agentMatch = content.match(/agent:\s*([^\n]+)/);
        const ts = tsMatch ? tsMatch[1].trim() : '';
        const agent = agentMatch ? agentMatch[1].trim() : 'unknown';
        if (ts) {
            const ageMs = Date.now() - new Date(ts).getTime();
            if (ageMs < CLAIM_STALENESS_HOURS * 3600 * 1000) {
                return { agent, ts };
            }
        }
    } catch { /* no claim or parse failure -> unclaimed */ }
    return null;
}

/**
 * List all queue items for a team, sorted by priority (desc) then
 * enqueued_ts (asc — oldest first within the same priority).
 *
 * `groupId` MUST be validated by `isSafeId` BEFORE calling.
 */
export async function listQueue(workspaceRoot: string, groupId: string): Promise<QueueListResult> {
    try {
        const queueDir = await bootstrapTeamQueue(workspaceRoot, groupId);
        if (!queueDir) {
            return { success: true, items: [] };
        }
        const claimedDir = path.join(queueDir, 'claimed');
        const entries = await fs.promises.readdir(queueDir);
        const mdFiles = entries.filter(f => f.endsWith('.md'));

        const items: QueueItem[] = [];
        for (const filename of mdFiles) {
            // Defensive: skip any filename that somehow contains traversal
            // despite the isSafeId guard at the API layer.
            if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
                continue;
            }
            const filePath = path.join(queueDir, filename);
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                const claimData = await readClaim(claimedDir, filename);
                items.push(parseQueueItem(filename, content, !!claimData, claimData || undefined));
            } catch { /* skip unreadable */ }
        }

        // Sort: priority descending, then enqueued_ts ascending (FIFO within priority).
        items.sort((a, b) => {
            if (b.priority !== a.priority) { return b.priority - a.priority; }
            return String(a.enqueuedTs).localeCompare(String(b.enqueuedTs));
        });

        return { success: true, items };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Enqueue a new item. Writes with `{ flag: 'wx' }` (exclusive-create) and
 * retries up to 5 times on a same-second filename collision — same
 * mechanics as `writeInboxFile` in ScheduledJobsService.ts.
 *
 * `groupId` MUST be validated by `isSafeId` BEFORE calling.
 */
export async function enqueueItem(
    workspaceRoot: string,
    groupId: string,
    params: { kind: string; body: string; planId?: string; feature?: string; target?: string; priority?: number }
): Promise<QueueEnqueueResult> {
    try {
        const body = String(params.body || '');
        if (body.length > MAX_QUEUE_ITEM_BODY) {
            return { success: false, error: `Item body exceeds ${MAX_QUEUE_ITEM_BODY} bytes` };
        }
        const kind = String(params.kind || 'prompt').trim();
        if (!['plan', 'prompt', 'card'].includes(kind)) {
            return { success: false, error: "kind must be 'plan', 'prompt', or 'card'" };
        }

        const queueDir = await bootstrapTeamQueue(workspaceRoot, groupId);
        if (!queueDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }

        const flatten = (s: string) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
        const now = new Date();
        const iso = now.toISOString();
        const compact = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const target = String(params.target || 'head').trim();
        const priority = typeof params.priority === 'number' ? params.priority : 0;

        const fmLines: string[] = ['---'];
        fmLines.push(`kind: ${flatten(kind)}`);
        if (params.planId) { fmLines.push(`planId: ${flatten(params.planId)}`); }
        if (params.feature) { fmLines.push(`feature: ${flatten(params.feature)}`); }
        fmLines.push(`target: ${flatten(target)}`);
        fmLines.push(`priority: ${priority}`);
        fmLines.push(`enqueued_ts: ${iso}`);
        fmLines.push('---');
        fmLines.push('');
        fmLines.push(body);
        const content = fmLines.join('\n');

        let filePath: string | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            const rand = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
            const filename = `q-${compact}-${flatten(kind)}-${rand}.md`;
            filePath = path.join(queueDir, filename);
            try {
                await fs.promises.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
                // Read back to return the parsed item.
                const readContent = await fs.promises.readFile(filePath, 'utf8');
                const item = parseQueueItem(filename, readContent, false);
                return { success: true, item };
            } catch (err: any) {
                if (err?.code === 'EEXIST') { continue; }
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
        return { success: false, error: 'Failed to write queue item after 5 collision retries' };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Claim an item atomically. Uses `{ flag: 'wx' }` (exclusive-create) for
 * the claim sidecar so two concurrent claims yield exactly one winner.
 *
 * `groupId` and `itemId` MUST be validated by `isSafeId` BEFORE calling.
 */
export async function claimItem(
    workspaceRoot: string,
    groupId: string,
    itemId: string,
    agentId = 'team-queue-pump'
): Promise<QueueClaimResult> {
    try {
        const queueDir = await bootstrapTeamQueue(workspaceRoot, groupId);
        if (!queueDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
        const claimedDir = path.join(queueDir, 'claimed');
        // Find the file matching the itemId (id is filename without .md).
        const entries = await fs.promises.readdir(queueDir);
        const filename = entries.find(f => f === `${itemId}.md`);
        if (!filename) {
            return { success: false, error: `Queue item '${itemId}' not found` };
        }

        // Check for an existing fresh claim.
        const existingClaim = await readClaim(claimedDir, filename);
        if (existingClaim) {
            return { success: false, error: `Item '${itemId}' is already claimed by ${existingClaim.agent}` };
        }

        // Atomic exclusive-create claim sidecar.
        const claimPath = path.join(claimedDir, `${filename}.claim`);
        const claimContent = `claimed_ts: ${new Date().toISOString()}\nagent: ${agentId}\n`;
        try {
            await fs.promises.writeFile(claimPath, claimContent, { encoding: 'utf8', flag: 'wx' });
        } catch (err: any) {
            if (err?.code === 'EEXIST') {
                // Another caller claimed it between our check and our write.
                return { success: false, error: `Item '${itemId}' was claimed by another caller` };
            }
            throw err;
        }

        // Read back the item to return it.
        const content = await fs.promises.readFile(path.join(queueDir, filename), 'utf8');
        const item = parseQueueItem(filename, content, true, { agent: agentId, ts: new Date().toISOString() });
        return { success: true, item };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Delete a queue item and its claim sidecar (if any). Immediate, no
 * confirmation — the CLAUDE.md rule.
 *
 * `groupId` and `itemId` MUST be validated by `isSafeId` BEFORE calling.
 */
export async function deleteItem(
    workspaceRoot: string,
    groupId: string,
    itemId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const queueDir = await bootstrapTeamQueue(workspaceRoot, groupId);
        if (!queueDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
        const entries = await fs.promises.readdir(queueDir);
        const filename = entries.find(f => f === `${itemId}.md`);
        if (!filename) {
            return { success: false, error: `Queue item '${itemId}' not found` };
        }
        const filePath = path.join(queueDir, filename);
        const claimPath = path.join(queueDir, 'claimed', `${filename}.claim`);
        try { await fs.promises.unlink(filePath); } catch { /* already gone */ }
        try { await fs.promises.unlink(claimPath); } catch { /* no claim */ }
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Reorder queue items by renaming them with a numeric prefix. The order
 * array is a list of itemIds in the desired display order. Items not in
 * the array keep their original filenames.
 *
 * `groupId` MUST be validated by `isSafeId` BEFORE calling.
 */
export async function reorderQueue(
    workspaceRoot: string,
    groupId: string,
    order: string[]
): Promise<QueueReorderResult> {
    try {
        const queueDir = await bootstrapTeamQueue(workspaceRoot, groupId);
        if (!queueDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
        // Validate every id in the order array.
        for (const id of order) {
            if (!isSafeId(id)) {
                return { success: false, error: `Invalid item id in order: '${id}'` };
            }
        }

        const entries = await fs.promises.readdir(queueDir);
        const mdFiles = entries.filter(f => f.endsWith('.md'));

        // Rename each item in the order array to a zero-padded prefix.
        // The list function sorts by priority then enqueued_ts; a numeric
        // prefix in the filename does NOT affect sort order because the
        // sort is on parsed frontmatter, not filename. So instead we
        // update the `priority` frontmatter field to the position index.
        for (let i = 0; i < order.length; i++) {
            const itemId = order[i];
            const filename = mdFiles.find(f => f === `${itemId}.md`);
            if (!filename) { continue; }
            const filePath = path.join(queueDir, filename);
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                // Replace or insert the priority line in frontmatter.
                const lines = content.split('\n');
                let prioritySet = false;
                for (let j = 1; j < lines.length; j++) {
                    if (lines[j].trim() === '---') { break; }
                    if (lines[j].startsWith('priority:')) {
                        lines[j] = `priority: ${order.length - i}`; // higher = earlier
                        prioritySet = true;
                        break;
                    }
                }
                if (!prioritySet) {
                    // Insert before the closing ---
                    for (let j = 1; j < lines.length; j++) {
                        if (lines[j].trim() === '---') {
                            lines.splice(j, 0, `priority: ${order.length - i}`);
                            break;
                        }
                    }
                }
                await fs.promises.writeFile(filePath, lines.join('\n'), 'utf8');
            } catch { /* skip on error */ }
        }

        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Release a claim (mark item as pending again). Deletes the claim
 * sidecar so the item returns to the pending pool.
 *
 * `groupId` and `itemId` MUST be validated by `isSafeId` BEFORE calling.
 */
export async function releaseClaim(
    workspaceRoot: string,
    groupId: string,
    itemId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const queueDir = await bootstrapTeamQueue(workspaceRoot, groupId);
        if (!queueDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
        const claimPath = path.join(queueDir, 'claimed', `${itemId}.md.claim`);
        try { await fs.promises.unlink(claimPath); } catch { /* no claim */ }
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
