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
    /**
     * Outbound push opt-in (provider-sync full parity). Default false — the ~4,000
     * existing installs are unchanged until enabled. Mirrors ClickUp/Linear's
     * `realTimeSyncEnabled` flag: when true, `_queueNotionSync` pushes state and
     * create-if-missing fires for plans with no `notionPageId`, independent of which
     * provider is the active poll backend (all three push simultaneously).
     */
    realTimeSyncEnabled?: boolean;
    /**
     * Outbound archive-on-delete opt-in (provider-sync full parity). Default false.
     * When true, a local plan delete/archives the mapped Notion page (recoverable
     * archive, never hard-delete). Mirrors ClickUp/Linear's `deleteSyncEnabled` flag.
     */
    deleteSyncEnabled?: boolean;
    /**
     * Inbound delete opt-in (provider-sync inbound-delete). Default false. When true,
     * the reconcile-sweep tombstones (recoverably) the mapped local plan when the
     * remote Notion page is deleted/archived. Never touches unmapped plans.
     */
    inboundDeleteEnabled?: boolean;
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
            realTimeSyncEnabled: parsed.realTimeSyncEnabled === true,
            deleteSyncEnabled: parsed.deleteSyncEnabled === true,
            inboundDeleteEnabled: parsed.inboundDeleteEnabled === true,
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
    // Preserve the provider-sync opt-in flags across a setup re-run that doesn't
    // pass them (same preserve-on-rerun pattern as contextPageId). Pass an explicit
    // `false` to intentionally disable.
    let realTimeSyncEnabled = setup.realTimeSyncEnabled;
    let deleteSyncEnabled = setup.deleteSyncEnabled;
    let inboundDeleteEnabled = setup.inboundDeleteEnabled;
    if (realTimeSyncEnabled === undefined || deleteSyncEnabled === undefined || inboundDeleteEnabled === undefined) {
        const existing = await loadNotionRemoteSetup(db);
        if (realTimeSyncEnabled === undefined) { realTimeSyncEnabled = existing?.realTimeSyncEnabled === true; }
        if (deleteSyncEnabled === undefined) { deleteSyncEnabled = existing?.deleteSyncEnabled === true; }
        if (inboundDeleteEnabled === undefined) { inboundDeleteEnabled = existing?.inboundDeleteEnabled === true; }
    }
    await db.setConfig(NOTION_REMOTE_SETUP_KEY, JSON.stringify({
        plansDatabaseId: String(setup.plansDatabaseId || ''),
        commentsDatabaseId: String(setup.commentsDatabaseId || ''),
        botId: String(setup.botId || ''),
        contextPageId: String(contextPageId || ''),
        realTimeSyncEnabled: realTimeSyncEnabled === true,
        deleteSyncEnabled: deleteSyncEnabled === true,
        inboundDeleteEnabled: inboundDeleteEnabled === true,
    }));
}
