/**
 * Shared self-comment marker logic for the integration comment loop (§7/§8).
 *
 * Every comment Switchboard posts outbound carries a hidden marker so the inbound
 * poll can skip its own comments and avoid a feedback loop. The HTML-comment marker
 * is primary; a short visible text prefix is the fallback for renderers (verified
 * during implementation) that strip HTML comments.
 *
 * The marker is applied HOST-SIDE only (in postManagedComment), never by the agent —
 * so an agent can't accidentally break the feedback-loop guard.
 */

/** Primary marker — an HTML comment, invisible in rendered markdown. */
export const SWITCHBOARD_COMMENT_MARKER = '<!-- switchboard -->';

/** Fallback marker — a short visible prefix that survives markdown rendering. */
export const SWITCHBOARD_COMMENT_TEXT_MARKER = '[sb]';

/** Append the hidden marker to an outbound comment body. */
export function stampMarker(body: string): string {
    const trimmed = String(body || '').trimEnd();
    return `${trimmed}\n\n${SWITCHBOARD_COMMENT_MARKER}`;
}

/** True if a comment body was authored by Switchboard (either marker form). */
export function hasMarker(body: string | undefined | null): boolean {
    const text = String(body || '');
    return text.includes(SWITCHBOARD_COMMENT_MARKER) || text.includes(SWITCHBOARD_COMMENT_TEXT_MARKER);
}

/**
 * Truncate an outbound comment to a provider size limit, posting a head plus a
 * truncation tail when the body is too long.
 */
export function truncateForComment(body: string, limit: number): string {
    const text = String(body || '');
    if (text.length <= limit) return text;
    const tail = '\n\n*[truncated — see plan file]*';
    return text.slice(0, Math.max(0, limit - tail.length)) + tail;
}
