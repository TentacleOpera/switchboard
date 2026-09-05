import type { KanbanDatabase } from './KanbanDatabase';
import { getMachineId, getMachineLabel } from './machineAttribution';

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
 * arbitration belongs there. Today the codebase only ships a single-writer
 * SQLite file target, which is implicitly owned by the local process. This
 * service therefore no-ops for local-file stores and returns the local machine
 * as owner, while keeping the seam in place so libSQL / git-carried shared
 * targets can add conditional acquire/renew/release later.
 */
export class SyncOwnershipLease {
    private _machineId = getMachineId();
    private _machineLabel = getMachineLabel();
    private _acquiredAt: string | null = null;
    private _expiresAt: string | null = null;
    private _renewTimer: NodeJS.Timeout | null = null;

    /**
     * True if this process is the current owner and may run outbound sync.
     * For local-file targets this is always true; shared targets will consult
     * the lease row and evaluate expiry against the store's own time.
     */
    public async isOwner(_db?: KanbanDatabase): Promise<boolean> {
        // Local-file SQLite is single-writer by construction — no shared lease needed.
        if (!_db || this._isLocalFileStore(_db)) {
            this._touchLocalLease();
            return true;
        }
        // Shared-store path: future conditional read against store-evaluated TTL.
        return false;
    }

    /**
     * Acquire or renew the lease. Returns true when this machine owns it.
     * The local-file no-op keeps the call sites identical once shared stores land.
     */
    public async acquireOrRenew(_db?: KanbanDatabase): Promise<boolean> {
        if (!_db || this._isLocalFileStore(_db)) {
            this._touchLocalLease();
            return true;
        }
        return false;
    }

    /** Release the lease on clean shutdown. */
    public async release(_db?: KanbanDatabase): Promise<void> {
        if (this._renewTimer) {
            clearTimeout(this._renewTimer);
            this._renewTimer = null;
        }
        if (!_db || this._isLocalFileStore(_db)) {
            return;
        }
        // Shared-store path: future conditional delete of this machine's lease row.
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

    private _isLocalFileStore(_db: KanbanDatabase): boolean {
        // All current targets are local .db files; the branch for libSQL / git-carried
        // shared stores will be added when those drivers are wired.
        return true;
    }

    private _touchLocalLease(): void {
        const now = new Date().toISOString();
        const ttlSeconds = 60;
        this._acquiredAt = now;
        this._expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

        if (this._renewTimer) {
            clearTimeout(this._renewTimer);
        }
        this._renewTimer = setTimeout(() => {
            this._expiresAt = null;
        }, Math.max(ttlSeconds * 1000, 10000));
    }

    private _isStale(): boolean {
        if (!this._expiresAt) { return false; }
        return new Date().toISOString() > this._expiresAt;
    }
}

export const syncOwnershipLease = new SyncOwnershipLease();
