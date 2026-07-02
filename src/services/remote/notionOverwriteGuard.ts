/**
 * Notion Overwrite Data-Loss Guard (epic 7 — Auto-Archive & Production Hardening).
 *
 * Enforces, **in code**, that no Notion body write can silently destroy user data.
 * A `replace_content` full overwrite (delete-all-children + append) permanently
 * deletes/orphans nested inline sub-pages, database views, and templates, and
 * changes block IDs (breaking deep-links, comments, anchors). This is an
 * irreversible data-loss path and must not depend on agent/skill compliance.
 *
 * The guard is a cross-cutting utility consumed by ALL Notion body writes:
 *   - `pushProjectContext` (NotionRemoteProvider)
 *   - `updatePageContent` (NotionFetchService — sync-to-source)
 *   - future `pushContent` and `/improve-remote-plan` write-back paths
 *
 * Contract:
 *   1. Append-by-default. Use additive block writes (`PATCH /blocks/{id}/children`)
 *      for improvements/updates wherever possible.
 *   2. Overwrite only after a verified childless check. A full clear-and-rewrite
 *      is permitted only after confirming the target page has NO inline sub-pages,
 *      DB views, or templates. If the check cannot be made confidently, do NOT overwrite.
 *   3. Scoped rewrite fallback. Where a body must be replaced, prefer clearing only
 *      the known plan-body block range rather than the whole page.
 *   4. Fail safe. On uncertainty, prefer append or abort with a surfaced error over
 *      a destructive write.
 */

import type { NotionFetchService } from '../NotionFetchService';

const PAGE_SIZE = 100;
const MAX_PAGES = 5;       // safety backstop: ≤ 500 children listed
const LIMITER_MS = 350;    // Notion ~3 req/s

/** Block types that a full overwrite would destroy or orphan. */
const PROTECTED_TYPES = new Set(['child_page', 'child_database', 'template']);

export interface NotionBlock {
    id?: string;
    type?: string;
    [key: string]: unknown;
}

export type GuardedWriteOutcome =
    | { ok: true; mode: 'appended'; detail: string }
    | { ok: true; mode: 'replaced'; detail: string }
    | { ok: false; mode: 'aborted'; detail: string };

/**
 * List every child block of a page. Returns `null` when the listing can't be
 * trusted (API error, or the page exceeds the listing backstop — an unverified
 * tail could hold nested content, so the childless check is inconclusive).
 */
export async function listAllChildren(
    notion: NotionFetchService,
    pageId: string,
    log?: (msg: string) => void
): Promise<NotionBlock[] | null> {
    const blocks: NotionBlock[] = [];
    let startCursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const qs = `page_size=${PAGE_SIZE}` + (startCursor ? `&start_cursor=${encodeURIComponent(startCursor)}` : '');
        const result = await notion.httpRequest('GET', `/blocks/${pageId}/children?${qs}`, undefined, 15000);
        if (result.status !== 200) {
            log?.(`[NotionOverwriteGuard] listAllChildren failed: HTTP ${result.status}`);
            return null;
        }
        blocks.push(...(result.data?.results || []));
        if (!result.data?.has_more) { return blocks; }
        startCursor = result.data?.next_cursor || undefined;
        if (!startCursor) { return blocks; }
        await delay(LIMITER_MS);
    }
    // More than MAX_PAGES × PAGE_SIZE children — inconclusive. Fail safe.
    log?.('[NotionOverwriteGuard] page exceeds listing backstop — treating childless check as inconclusive.');
    return null;
}

/** True if the child list contains any protected (destructive-to-overwrite) block. */
export function hasProtectedChildren(children: NotionBlock[]): boolean {
    return children.some(b => PROTECTED_TYPES.has(String(b.type || '')));
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The single guarded write path for a Notion page body. Given a set of new
 * blocks to write, it:
 *   - lists existing children;
 *   - if protected children exist → APPEND only (nested content survives);
 *   - if childless of protected content → clear the verified plain blocks, then write;
 *   - if the children check is inconclusive → ABORT without writing.
 *
 * Returns the outcome so callers can surface it (e.g. in the Remote tab health UI).
 */
export async function guardedWritePageBody(
    notion: NotionFetchService,
    pageId: string,
    blocks: NotionBlock[],
    log?: (msg: string) => void
): Promise<GuardedWriteOutcome> {
    const children = await listAllChildren(notion, pageId, log);
    if (children === null) {
        // Fail safe: an unverifiable page is never destructively written.
        return { ok: false, mode: 'aborted', detail: 'Children check failed — aborted without writing (overwrite guard)' };
    }

    if (hasProtectedChildren(children)) {
        // Append-by-default: nested content survives; the fresh content lands
        // under a divider so the newest section is unambiguous.
        const toAppend: NotionBlock[] = [
            { object: 'block', type: 'divider', divider: {} },
            ...blocks,
        ];
        const appended = await appendBlocks(notion, pageId, toAppend, log);
        return appended
            ? { ok: true, mode: 'appended', detail: 'appended (page has nested content — full replace withheld)' }
            : { ok: false, mode: 'aborted', detail: 'append failed' };
    }

    // Verified childless of protected content → clear the plain blocks we saw,
    // then write the fresh content. Deleting only the listed block ids keeps the
    // operation scoped to content we actually verified.
    for (const block of children) {
        const id = String(block.id || '');
        if (!id) { continue; }
        const del = await notion.httpRequest('DELETE', `/blocks/${id}`, undefined, 15000);
        if (del.status !== 200) {
            log?.(`[NotionOverwriteGuard] deleting block ${id} failed (HTTP ${del.status}) — switching to append.`);
            const appended = await appendBlocks(notion, pageId, [
                { object: 'block', type: 'divider', divider: {} },
                ...blocks,
            ], log);
            return appended
                ? { ok: true, mode: 'appended', detail: 'appended (replace aborted mid-clear)' }
                : { ok: false, mode: 'aborted', detail: 'replace aborted mid-clear and append failed' };
        }
        await delay(LIMITER_MS);
    }

    const written = await appendBlocks(notion, pageId, blocks, log);
    return written
        ? { ok: true, mode: 'replaced', detail: 'replaced' }
        : { ok: false, mode: 'aborted', detail: 'write failed after clear' };
}

/** Append blocks in ≤100-block batches (API limit), rate-limited. */
async function appendBlocks(
    notion: NotionFetchService,
    pageId: string,
    blocks: NotionBlock[],
    log?: (msg: string) => void
): Promise<boolean> {
    for (let i = 0; i < blocks.length; i += 100) {
        const batch = blocks.slice(i, i + 100);
        const result = await notion.httpRequest('PATCH', `/blocks/${pageId}/children`, { children: batch }, 30000);
        if (result.status !== 200) {
            log?.(`[NotionOverwriteGuard] appendBlocks failed at batch ${i / 100} (HTTP ${result.status}): ${JSON.stringify(result.data)?.slice(0, 200)}`);
            return false;
        }
        if (i + 100 < blocks.length) { await delay(LIMITER_MS); }
    }
    return true;
}
