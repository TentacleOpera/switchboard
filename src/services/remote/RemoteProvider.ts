/**
 * Provider seam for Remote Control (§7/§9/§10).
 *
 * `RemoteControlService` orchestrates cursors, echo guards, seed-on-first-poll, and
 * advance-after-dispatch provider-agnostically. Each backend (Linear, Notion) supplies
 * a `RemoteProvider` that knows how to ask its own API "what changed since my cursor?"
 * and how to map a remote state key onto a local Kanban column.
 *
 * Delta model (per the plan's D4): instead of fetching every tracked card each poll,
 * the provider returns only the rows the remote agent actually touched since the last
 * cursor. State deltas and comment deltas are TWO separate streams with TWO cursors —
 * required for Linear, where a comment does NOT bump the issue's `updatedAt`
 * (research-confirmed; see docs/technical_platform_integration_analysis.md, Finding 6).
 */

import type { KanbanPlanRecord } from '../KanbanDatabase';

/** A single remote state change: a card whose status/column moved. */
export interface RemoteStateDelta {
    /** Provider id of the card — `linearIssueId` (Linear) or `notionPageId` (Notion). */
    remoteId: string;
    /** Opaque provider state key. Linear: state UUID. Notion: the `Kanban Column` select name. */
    stateKey: string;
    /** If the remote card's parent changed, the new parent's remote id (or '' if unparented).
     *  Undefined = no parent change detected (provider didn't query it). */
    parentRemoteId?: string;
    /** If the remote card is itself a parent (has children), mark it as a feature candidate.
     *  Undefined = provider didn't query it. */
    isFeatureCandidate?: boolean;
    /** ISO timestamp of the remote item's last update. Linear: issue.updatedAt. Notion: page.last_edited_time. */
    updatedAt?: string;
    /** Remote item body/description. Linear: issue.description. Notion: undefined (deferred — fetched lazily via fetchDescription). */
    description?: string;
    /**
     * Notion echo guard: true when the page's `last_edited_by` is the Switchboard
     * integration bot itself (i.e. the change was our own outbound push). When true,
     * `_pollDescriptions` advances the cursor without writing — the bot's own push
     * is invisible to the puller regardless of markdown round-trip lossiness.
     * Linear/ClickUp leave this undefined (they use the byte-hash guard + cursor-advance-on-push).
     */
    selfEdited?: boolean;
}

/** A single inbound comment from the remote agent. */
export interface RemoteCommentDelta {
    /** Provider id of the card the comment targets. */
    remoteId: string;
    /** Stable provider id of the comment — used to de-dup under inclusive/minute-rounded cursors. */
    commentId: string;
    /** Comment body (verbatim; routed to the column agent). */
    body: string;
    /** ISO timestamp — the comment high-watermark. */
    createdAt: string;
    /** true → Switchboard/local authored this comment → skip on ingest (no feedback loop). */
    authoredBySelf: boolean;
}

/**
 * Declared provider capabilities — gates UI honestly (no toggle offers a capability
 * a provider lacks). The Remote Sync Refactor (1/3) formalized pull/push; the
 * project-context + archive capabilities ride the same object so feature 1's context
 * sync and the auto-archive rule dispatch through the provider seam, not a parallel
 * pipeline.
 */
export interface RemoteProviderCapabilities {
    /** Provider can pull/ingest state + comments (Linear, Notion). ClickUp = state-pull only (no comment bus). */
    pull: boolean;
    /** Provider can push state + content (Linear, ClickUp, Notion-after-2/3). */
    push: boolean;
    /** Provider can receive the project-level context bundle (Dev Docs + PRDs + constitution). */
    projectContextPush: boolean;
    /** Provider can archive a card (Linear issueArchive / Notion page archive). */
    archive: boolean;
}

/** One project-context document (a dev doc, a project PRD, the constitution, or the root README). */
export interface ProjectContextDocument {
    kind: 'devdoc' | 'prd' | 'constitution' | 'readme';
    /** Display title — dev-doc H1, project name for PRDs, 'Workspace Constitution'. */
    title: string;
    /** Raw markdown body. */
    markdown: string;
}

/** The assembled project-level context pushed outward. Switchboard is the source of truth. */
export interface ProjectContextBundle {
    /** Workspace display name (basename of the workspace root). */
    workspaceLabel: string;
    /** Board keys from remote.config ('' = base board) — Linear resolves project docs from these. */
    boards: string[];
    documents: ProjectContextDocument[];
    /** Single combined markdown rendering of all documents (providers may use this or the parts). */
    combinedMarkdown: string;
    /** ISO timestamp of this sync run (for staleness banners in the pushed doc). */
    syncedAt: string;
}

/** Outcome of a project-context push against one provider. */
export interface ProjectContextPushResult {
    ok: boolean;
    /** true → provider isn't configured for this workspace; not an error. */
    skipped?: boolean;
    /** Human-readable outcome: 'replaced', 'appended', or an error/skip reason. */
    detail?: string;
}

/** Outcome of archiving a single remote card. */
export interface ArchiveResult {
    ok: boolean;
    /** true → provider isn't configured for this workspace; not an error. */
    skipped?: boolean;
    error?: string;
}

export interface RemoteProvider {
    readonly kind: 'linear' | 'notion' | 'clickup';

    /** Declared capabilities — gate callers on these, never on `kind`. */
    readonly capabilities: RemoteProviderCapabilities;

    /**
     * State deltas since `sinceCursor` (an opaque cursor string the provider serializes
     * itself — for both providers this is an ISO timestamp high-watermark). Returns the
     * changed cards and the next cursor (max timestamp seen, or the input cursor if none).
     */
    fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }>;

    /**
     * Comment deltas since `sinceCursor`. Linear queries the `comments` entity directly
     * (a comment does not bump the issue's `updatedAt`); Notion queries the Comments DB.
     */
    fetchCommentDeltas(sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }>;

    /** Map a state key to a local Kanban column, or undefined if it maps to nothing. */
    stateKeyToColumn(stateKey: string): string | undefined;

    /**
     * Refresh the local plan file from the remote source before dispatch (Notion page body /
     * Linear issue description), so the local agent runs against the latest remote content.
     */
    refreshLocalPlanFromRemote(remoteId: string): Promise<void>;

    /**
     * Import a remote item the poll found with no local plan as a NEW local markdown file +
     * DB record (linked by remote id). Returns the new record, or null if it can't be
     * imported. Lets the board pick up plans authored remotely (new Linear issues / Notion
     * pages) on the next ping.
     */
    importRemotePlan(remoteId: string): Promise<KanbanPlanRecord | null>;

    /**
     * Post a comment on the remote card. Used to acknowledge dispatch back to the
     * remote agent. Implementations delegate to the provider's postManagedComment —
     * the stamp marker is applied there, ensuring authoredBySelf = true on ingest
     * (no feedback loop).
     */
    postComment(remoteId: string, body: string): Promise<void>;

    /**
     * Push a column/state change to the remote (outbound status sync).
     * Implementations delegate to the concrete sync service's syncPlan.
     * Pull-only providers log and return (no-op stub).
     */
    pushState(remoteId: string, column: string): Promise<void>;

    /**
     * Push plan body/content to the remote description/body (outbound content sync).
     * Implementations delegate to the concrete sync service's syncPlanContent.
     * Pull-only providers log and return (no-op stub).
     */
    pushContent(remoteId: string, markdown: string): Promise<void>;

    /**
     * Lazily fetch the remote item's body/description for content-pull. Only
     * providers whose `fetchStateDeltas` does NOT populate `description` inline
     * implement this (Notion — body must be assembled via the Markdown API, not
     * a single field on the delta row). `_pollDescriptions` calls this only for
     * rows whose `updatedAt` is past their per-issue cursor AND `selfEdited` is
     * not true, so the extra API call fires only when a real inbound edit is
     * suspected. Returns `{ body, updatedAt }` or null if the body can't be
     * fetched (deleted, truncated, permission error).
     */
    fetchDescription?(remoteId: string): Promise<{ body: string; updatedAt: string } | null>;

    /**
     * Push the project-level context bundle (Dev Docs + PRDs + constitution) to the
     * provider's project surface — Notion: the Switchboard context page beside the
     * plans DB; Linear: a "Switchboard Project Context" document on the matching
     * project(s). Notion writes MUST obey the overwrite guard: append-by-default,
     * full replace only after a verified no-inline-children check, and abort (never
     * destructive-write) when the check can't be made.
     */
    pushProjectContext(bundle: ProjectContextBundle): Promise<ProjectContextPushResult>;

    /**
     * Archive a remote card (Linear issueArchive / Notion page archive). Called
     * by the auto-archive rule after the local plan is moved to Completed +
     * archived locally — the local board is the source of truth and push mirrors
     * the archive outward. Idempotent: safe to call on an already-archived card.
     */
    archiveCard(remoteId: string): Promise<ArchiveResult>;
}
