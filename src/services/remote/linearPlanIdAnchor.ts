/**
 * Linear's durable `planId` identity anchor.
 *
 * Linear persists no planId on the remote object — identity lived solely in the
 * local `linear_issue_id` column, so an issue could never be matched back to a
 * card except through that one local row. The anchor gives the remote object a
 * durable identity of its own, which is what makes the per-project seed
 * re-runnable: a second seed pass ATTACHES to the issue it already created
 * instead of duplicating it. The outbound push appends it to the description:
 *
 *     [Switchboard] Plan: {planId}
 *
 * The description footer wins over the alternatives: a label per plan would
 * create thousands of labels, and `attachmentCreate` requires a URL while
 * `uploadAttachment` is an extra file-upload call per issue just to carry a
 * 36-character string. This mirrors the shape ClickUp already uses.
 *
 * The anchor must survive `syncPlanContent` (which replaces the whole
 * description) and must NOT be pulled back into the local plan file, or a
 * pull→push round-trip would duplicate it. Both directions live here so the
 * write and the strip cannot drift.
 *
 * This anchor is NOT half a board restore. Rebuilding a board out of a tracker
 * was removed deliberately (see NotionSyncService's header); the anchor is kept
 * for the seed's attach-on-re-run, and
 * `provider-capability-parity-contract.test.js` fails if board push/restore
 * grows back on the seam.
 */

/** Separator + marker + value, appended at the very end of a description. */
export const LINEAR_PLAN_ANCHOR_MARKER = '[Switchboard] Plan: ';

/** Build the footer appended to an issue description. '' when there is no planId. */
export function buildLinearPlanIdAnchor(planId: string): string {
    const id = String(planId || '').trim();
    return id ? `\n\n---\n${LINEAR_PLAN_ANCHOR_MARKER}${id}` : '';
}

/**
 * Remove the anchor footer from a remote description before it is written to a
 * local plan file. Only strips a footer that sits at the very end — a
 * description a human appended to after the anchor keeps its content intact.
 */
export function stripLinearPlanIdAnchor(body: string): string {
    const text = String(body || '');
    const re = new RegExp(`\\n*---\\n${escapeRegExp(LINEAR_PLAN_ANCHOR_MARKER)}[^\\s|]+\\s*$`);
    return re.test(text) ? text.replace(re, '').replace(/\s+$/, '') : text;
}

/** Parse the planId a remote description carries, or null when absent. */
export function parseLinearPlanIdAnchor(body: string): string | null {
    const m = String(body || '').match(/\[Switchboard\]\s*Plan:\s*([^\s|]+)/);
    return m && m[1] ? m[1].trim() : null;
}

/** Append the anchor unless the body already carries this exact one. */
export function ensureLinearPlanIdAnchor(body: string, planId: string): string {
    const id = String(planId || '').trim();
    if (!id) { return body; }
    return parseLinearPlanIdAnchor(body) === id ? body : `${body}${buildLinearPlanIdAnchor(id)}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
