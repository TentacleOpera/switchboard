/**
 * Content conflict resolution seam for bidirectional plan-content sync.
 *
 * When a remote description pull and a local plan edit both touch the same plan,
 * the resolver decides whether the remote body should overwrite the local file.
 * The default `LastWriteWinsResolver` resolves in favour of whichever side
 * changed more recently (remote wins only when `remoteUpdatedAt > cursor`).
 *
 * The seam exists so the follow-on `cross-platform-agent-collaboration` plan can
 * swap in a locking/turn-taking resolver without touching `_pollDescriptions` —
 * inject a different implementation into the `RemoteControlService` deps.
 */

export interface ContentConflictResolver {
    /**
     * @param remoteUpdatedAt ISO timestamp of the remote item's last edit.
     * @param cursor          The per-issue description cursor (last-synced timestamp).
     * @param remoteBody      The body that would be pulled from the remote.
     * @param localBody       The current local plan file body.
     * @returns true → pull the remote body into the local file; false → skip.
     */
    shouldPull(remoteUpdatedAt: string, cursor: string, remoteBody: string, localBody: string): boolean;
}

/**
 * Default resolver: remote wins iff its timestamp is strictly newer than the
 * per-issue cursor. The byte-hash echo guard in `_pollDescriptions` already
 * no-ops a byte-identical round-trip; this resolver only fires on a genuine
 * divergence, and resolves it in favour of the more recent side.
 */
export class LastWriteWinsResolver implements ContentConflictResolver {
    shouldPull(remoteUpdatedAt: string, cursor: string): boolean {
        if (!remoteUpdatedAt) { return false; }
        if (!cursor) { return true; } // first sync for this issue — pull
        return remoteUpdatedAt > cursor;
    }
}
