import * as fs from 'fs';
import * as path from 'path';

export interface ManualGroup {
    id: string;
    name: string;
    source: 'manual';
    layout?: string;
    members: string[];
    order?: string[];
}

export class ManualGroupStore {
    private static _instance: ManualGroupStore | null = null;
    private _groups: Map<string, ManualGroup> = new Map();
    private _mutationChain: Promise<void> = Promise.resolve();

    public static getInstance(): ManualGroupStore {
        if (!ManualGroupStore._instance) {
            ManualGroupStore._instance = new ManualGroupStore();
        }
        return ManualGroupStore._instance;
    }

    public static resetInstance(): void {
        ManualGroupStore._instance = null;
    }

    /**
     * List all current in-memory manual groups.
     */
    public list(): ManualGroup[] {
        return Array.from(this._groups.values()).map(g => ({
            ...g,
            members: [...g.members],
            order: g.order ? [...g.order] : [...g.members],
        }));
    }

    /**
     * Get a manual group by ID.
     */
    public get(id: string): ManualGroup | undefined {
        const g = this._groups.get(id);
        if (!g) return undefined;
        return {
            ...g,
            members: [...g.members],
            order: g.order ? [...g.order] : [...g.members],
        };
    }

    /**
     * Create or register a manual group in in-memory session state.
     */
    public async create(group: {
        id?: string;
        name: string;
        layout?: string;
        members: string[];
        order?: string[];
    }): Promise<ManualGroup> {
        return this._serialize(async () => {
            const id = group.id || `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const members = Array.isArray(group.members) ? [...group.members] : [];
            const order = Array.isArray(group.order) ? [...group.order] : [...members];
            const stored: ManualGroup = {
                id,
                name: (group.name || '').trim() || 'Group',
                source: 'manual',
                layout: group.layout || '1',
                members,
                order,
            };
            this._groups.set(id, stored);
            return {
                ...stored,
                members: [...stored.members],
                order: stored.order ? [...stored.order] : [...stored.members],
            };
        });
    }

    /**
     * Delete a manual group by ID.
     */
    public async delete(id: string): Promise<boolean> {
        return this._serialize(async () => {
            return this._groups.delete(id);
        });
    }

    /**
     * Add a member to an existing manual group.
     */
    public async addMember(groupId: string, memberName: string): Promise<boolean> {
        return this._serialize(async () => {
            const g = this._groups.get(groupId);
            if (!g) return false;
            if (!g.members.includes(memberName)) {
                g.members.push(memberName);
            }
            if (!g.order) {
                g.order = [...g.members];
            } else if (!g.order.includes(memberName)) {
                g.order.push(memberName);
            }
            return true;
        });
    }

    /**
     * Remove a member from an existing manual group. If group becomes empty, it is deleted.
     */
    public async removeMember(groupId: string, memberName: string): Promise<{ ok: boolean; groupDeleted: boolean }> {
        return this._serialize(async () => {
            const g = this._groups.get(groupId);
            if (!g) return { ok: false, groupDeleted: false };
            g.members = g.members.filter(m => m !== memberName);
            if (g.order) {
                g.order = g.order.filter(m => m !== memberName);
            }
            if (g.members.length === 0) {
                this._groups.delete(groupId);
                return { ok: true, groupDeleted: true };
            }
            return { ok: true, groupDeleted: false };
        });
    }

    /**
     * Drop a terminal across ALL manual groups when it closes or exits.
     * If a group becomes empty, deletes the group.
     * Logs dropped member and deleted group names.
     */
    public async onTerminalExit(terminalName: string): Promise<{ droppedFrom: string[]; deletedGroups: string[] }> {
        return this._serialize(async () => {
            const droppedFrom: string[] = [];
            const deletedGroups: string[] = [];
            for (const [id, g] of this._groups.entries()) {
                if (g.members.includes(terminalName)) {
                    g.members = g.members.filter(m => m !== terminalName);
                    if (g.order) {
                        g.order = g.order.filter(m => m !== terminalName);
                    }
                    droppedFrom.push(g.name || id);
                    console.log(`[ManualGroupStore] Terminal '${terminalName}' exited, dropped from manual group '${g.name || id}'`);
                    if (g.members.length === 0) {
                        this._groups.delete(id);
                        deletedGroups.push(g.name || id);
                        console.log(`[ManualGroupStore] Manual group '${g.name || id}' is now empty, removed`);
                    }
                }
            }
            return { droppedFrom, deletedGroups };
        });
    }

    /**
     * Sidecar file path for a given workspace root.
     */
    public static getSidecarPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'manual-groups-sidecar.json');
    }

    /**
     * Atomic save to sidecar with mode 0600 on clean shutdown.
     */
    public async saveSidecar(workspaceRoot: string): Promise<void> {
        return this._serialize(async () => {
            const sidecarPath = ManualGroupStore.getSidecarPath(workspaceRoot);
            const dir = path.dirname(sidecarPath);
            await fs.promises.mkdir(dir, { recursive: true });

            const groups = Array.from(this._groups.values());
            const json = JSON.stringify({ version: 1, groups }, null, 2);

            const tempPath = path.join(dir, `.manual-groups-sidecar.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`);
            await fs.promises.writeFile(tempPath, json, { mode: 0o600, encoding: 'utf8' });
            await fs.promises.chmod(tempPath, 0o600).catch(() => {});
            await fs.promises.rename(tempPath, sidecarPath);
        });
    }

    /**
     * Restore from sidecar file, intersecting members with the live adopted fleet.
     * Drops dead members. If a group's members are all dead, group is dropped.
     * Clean up sidecar file after restore (or on empty) so stale files don't linger.
     */
    public async restoreSidecar(workspaceRoot: string, liveFleetTerminalNames: string[]): Promise<ManualGroup[]> {
        return this._serialize(async () => {
            const sidecarPath = ManualGroupStore.getSidecarPath(workspaceRoot);
            if (!fs.existsSync(sidecarPath)) {
                return [];
            }

            const liveSet = new Set(liveFleetTerminalNames);
            const restored: ManualGroup[] = [];

            try {
                const raw = await fs.promises.readFile(sidecarPath, 'utf8');
                const data = JSON.parse(raw);
                const rawGroups = Array.isArray(data?.groups) ? data.groups : [];

                for (const g of rawGroups) {
                    if (!g || typeof g.id !== 'string') continue;
                    const members = Array.isArray(g.members) ? g.members.filter((m: any) => typeof m === 'string' && liveSet.has(m)) : [];
                    if (members.length === 0) {
                        // All members died or didn't survive adoption — do not restore
                        continue;
                    }
                    const order = Array.isArray(g.order) ? g.order.filter((m: any) => typeof m === 'string' && liveSet.has(m)) : [...members];
                    const restoredGroup: ManualGroup = {
                        id: g.id,
                        name: (g.name || '').trim() || 'Group',
                        source: 'manual',
                        layout: g.layout || '1',
                        members,
                        order,
                    };
                    this._groups.set(restoredGroup.id, restoredGroup);
                    restored.push(restoredGroup);
                }
            } catch (err) {
                console.warn('[ManualGroupStore] Failed to restore groups from sidecar:', err);
            } finally {
                // Delete sidecar once read so a subsequent crash does not resurrect old state
                try {
                    await fs.promises.unlink(sidecarPath);
                } catch { /* ignore */ }
            }

            return restored;
        });
    }

    private async _serialize<T>(op: () => Promise<T>): Promise<T> {
        const next = this._mutationChain.then(op, op);
        this._mutationChain = next.then(() => {}, () => {});
        return next;
    }
}
