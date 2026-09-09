import type { KanbanDatabase } from './KanbanDatabase';
import { getMachineId, getMachineLabel } from './machineAttribution';
import { resolveStoreTarget } from './storeTarget';

export interface SyncLeaseStatus {
    isOwner: boolean;
    ownerId: string | null;
    ownerLabel: string | null;
    acquiredAt: string | null;
    expiresAt: string | null;
    /** True when the current owner has not pushed recently enough to keep projections fresh. */
    stale: boolean;
}

/**
 * One-machine ownership of outbound provider sync.
 *
 * The shared store is the only place all candidates can see the lease, so real
 * arbitration belongs there. For local-file stores (the default), the single
 * machine is trivially the owner and the lease is a no-op. For libSQL shared
 * stores, the lease uses a `sync_lease` table in the shared store with a
 * short TTL (60s) and renewal (20s), so a crashed owner's lease expires and
 * another machine takes over within a minute.
 *
 * See `.switchboard/plans/sync-owner-lease-and-write-attribution.md`.
 */
export class SyncOwnershipLease {
    private _machineId = getMachineId();
    private _machineLabel = getMachineLabel();
    private _acquiredAt: string | null = null;
    private _expiresAt: string | null = null;
    private _renewTimer: NodeJS.Timeout | null = null;
    private static readonly TTL_SECONDS = 60;
    private static readonly RENEW_INTERVAL_MS = 20 * 1000;

    /**
     * True if this process is the current owner and may run outbound sync.
     * For local-file targets this is always true; shared targets consult
     * the lease row and evaluate expiry against the store's own time.
     */
    public async isOwner(db?: KanbanDatabase): Promise<boolean> {
        if (!db || this._isLocalFileStore()) {
            this._touchLocalLease();
            return true;
        }
        // Shared-store path: check the lease row.
        return this._checkSharedLease(db);
    }

    /**
     * Acquire or renew the lease. Returns true when this machine owns it.
     * The local-file no-op keeps the call sites identical once shared stores land.
     */
    public async acquireOrRenew(db?: KanbanDatabase): Promise<boolean> {
        if (!db || this._isLocalFileStore()) {
            this._touchLocalLease();
            return true;
        }
        // Shared-store path: try to acquire or renew the lease row.
        const acquired = await this._acquireSharedLease(db);
        if (acquired) {
            this._startRenewalTimer(db);
        }
        return acquired;
    }

    /** Release the lease on clean shutdown. */
    public async release(db?: KanbanDatabase): Promise<void> {
        if (this._renewTimer) {
            clearTimeout(this._renewTimer);
            this._renewTimer = null;
        }
        if (!db || this._isLocalFileStore()) {
            return;
        }
        // Shared-store path: delete this machine's lease row.
        await this._releaseSharedLease(db);
    }

    /** Current owner, lease age, and staleness for the Database panel. */
    public getStatus(): SyncLeaseStatus {
        return {
            isOwner: true,
            ownerId: this._machineId,
            ownerLabel: this._machineLabel,
            acquiredAt: this._acquiredAt,
            expiresAt: this._expiresAt,
            stale: this._isStale()
        };
    }

    private _isLocalFileStore(): boolean {
        const target = resolveStoreTarget();
        return target.kind === 'local-file';
    }

    /**
     * Check the shared-store lease row. Returns true if this machine owns
     * the lease and it hasn't expired.
     */
    private async _checkSharedLease(db: KanbanDatabase): Promise<boolean> {
        try {
            const row = await db.getSharedLeaseRow();
            if (!row) {
                // No lease row — this machine can acquire it.
                return false;
            }
            if (row.owner_id === this._machineId) {
                // We own it — check if it's still valid.
                const expiresAt = new Date(row.expires_at).getTime();
                if (Date.now() < expiresAt) {
                    this._acquiredAt = row.acquired_at;
                    this._expiresAt = row.expires_at;
                    return true;
                }
                // Expired — we can re-acquire.
                return false;
            }
            // Another machine owns it — check if their lease has expired.
            const expiresAt = new Date(row.expires_at).getTime();
            if (Date.now() >= expiresAt) {
                // Their lease expired — we can acquire.
                return false;
            }
            return false;
        } catch {
            return false;
        }
    }

    /**
     * Acquire or renew the shared-store lease row. Uses INSERT OR REPLACE
     * with a TTL: if no row exists or the existing row has expired, this
     * machine takes ownership. If this machine already owns it, the lease
     * is renewed.
     */
    private async _acquireSharedLease(db: KanbanDatabase): Promise<boolean> {
        try {
            const now = new Date().toISOString();
            const expiresAt = new Date(Date.now() + SyncOwnershipLease.TTL_SECONDS * 1000).toISOString();

            // Ensure the sync_lease table exists.
            await db.ensureSharedLeaseTable();

            // Try to acquire: if no row exists or the existing row has expired,
            // this machine takes ownership. The CAS is done via a transaction
            // that checks the row before writing.
            const acquired = await db.acquireSyncLease(
                this._machineId,
                this._machineLabel,
                now,
                expiresAt,
                SyncOwnershipLease.TTL_SECONDS
            );

            if (acquired) {
                this._acquiredAt = now;
                this._expiresAt = expiresAt;
            }
            return acquired;
        } catch (e) {
            console.error('[SyncOwnershipLease] acquireSharedLease failed:', e);
            return false;
        }
    }

    /** Release the shared-store lease row. */
    private async _releaseSharedLease(db: KanbanDatabase): Promise<void> {
        try {
            await db.releaseSyncLease(this._machineId);
            this._acquiredAt = null;
            this._expiresAt = null;
        } catch (e) {
            console.error('[SyncOwnershipLease] releaseSharedLease failed:', e);
        }
    }

    /** Start a renewal timer that renews the lease before it expires. */
    private _startRenewalTimer(db: KanbanDatabase): void {
        if (this._renewTimer) {
            clearTimeout(this._renewTimer);
        }
        this._renewTimer = setTimeout(() => {
            this._renewTimer = null;
            void this.acquireOrRenew(db);
        }, SyncOwnershipLease.RENEW_INTERVAL_MS);
    }

    private _touchLocalLease(): void {
        const now = new Date().toISOString();
        this._acquiredAt = now;
        this._expiresAt = new Date(Date.now() + SyncOwnershipLease.TTL_SECONDS * 1000).toISOString();

        if (this._renewTimer) {
            clearTimeout(this._renewTimer);
        }
        this._renewTimer = setTimeout(() => {
            this._expiresAt = null;
        }, Math.max(SyncOwnershipLease.TTL_SECONDS * 1000, 10000));
    }

    private _isStale(): boolean {
        if (!this._expiresAt) { return false; }
        return new Date().toISOString() > this._expiresAt;
    }
}

export const syncOwnershipLease = new SyncOwnershipLease();
