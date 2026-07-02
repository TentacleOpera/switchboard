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

export interface RemoteProvider {
    readonly kind: 'linear' | 'notion' | 'control-plane' | 'wiki';

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
}
