/**
 * Shared persistence for the Notion Remote-Control setup blob.
 *
 * The blob lives in the kanban DB `config` table (the blessed home for all state/config —
 * never a JSON sidecar). Both the poll path (`NotionRemoteProvider`) and the write-back
 * bridge (`NotionFetchService.postManagedComment`) read it, so it must be reachable from
 * a plain `KanbanDatabase` handle.
 */

export const NOTION_REMOTE_SETUP_KEY = 'remote.notion.setup';

export interface NotionRemoteSetup {
    /** The plans database (reuses the Notion backup DB). Its rows are the cards. */
    plansDatabaseId: string;
    /** The dedicated "Switchboard Comments" database (the async message bus). */
    commentsDatabaseId: string;
    /** Integration bot id from `GET /v1/users/me` — drives `authoredBySelf`. */
    botId: string;
    /**
     * The "Switchboard Project Context" page (Dev Docs + PRDs + constitution mirror).
     * Created lazily by the first project-context push; empty until then.
     */
    contextPageId?: string;
}

/** Minimal config surface — satisfied by KanbanDatabase, avoids an import cycle. */
export interface NotionRemoteConfigStore {
    getConfig(key: string): Promise<string | null>;
    setConfig(key: string, value: string): Promise<boolean>;
}

export async function loadNotionRemoteSetup(db: NotionRemoteConfigStore): Promise<NotionRemoteSetup | null> {
    try {
        const raw = await db.getConfig(NOTION_REMOTE_SETUP_KEY);
        if (!raw) { return null; }
        const parsed = JSON.parse(raw);
        return {
            plansDatabaseId: String(parsed.plansDatabaseId || ''),
            commentsDatabaseId: String(parsed.commentsDatabaseId || ''),
            botId: String(parsed.botId || ''),
            contextPageId: String(parsed.contextPageId || ''),
        };
    } catch {
        return null;
    }
}

export async function saveNotionRemoteSetup(db: NotionRemoteConfigStore, setup: NotionRemoteSetup): Promise<void> {
    // Callers that predate contextPageId (e.g. NotionBackupService.setupRemoteControl)
    // build the blob without it — preserve the stored id rather than wiping it on
    // a setup re-run. Pass an explicit '' to intentionally clear it.
    let contextPageId = setup.contextPageId;
    if (contextPageId === undefined) {
        const existing = await loadNotionRemoteSetup(db);
        contextPageId = existing?.contextPageId || '';
    }
    await db.setConfig(NOTION_REMOTE_SETUP_KEY, JSON.stringify({
        plansDatabaseId: String(setup.plansDatabaseId || ''),
        commentsDatabaseId: String(setup.commentsDatabaseId || ''),
        botId: String(setup.botId || ''),
        contextPageId: String(contextPageId || ''),
    }));
}
