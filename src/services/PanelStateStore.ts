import * as vscode from 'vscode';
import * as path from 'path';

export class PanelStateStore {
    constructor(private memento: vscode.Memento, private panelKey: string) {}

    // Per-root state (e.g. tickets navigation for a specific repo)
    getRootState<T>(tabKey: string, root: string): T | undefined {
        const map = this.memento.get<Record<string, T>>(this._key(tabKey)) || {};
        return map[path.resolve(root)];
    }
    async setRootState<T>(tabKey: string, root: string, value: T): Promise<void> {
        const key = this._key(tabKey);
        const map = { ...(this.memento.get<Record<string, T>>(key) || {}) };
        map[path.resolve(root)] = value;
        await this.memento.update(key, map);
    }

    // Panel-level state (e.g. which root a tab's dropdown points at)
    getPanelState<T>(tabKey: string): T | undefined {
        return this.memento.get<T>(this._key(tabKey + '.panel'));
    }
    async setPanelState<T>(tabKey: string, value: T): Promise<void> {
        await this.memento.update(this._key(tabKey + '.panel'), value);
    }

    getAllStates(tabKeys: string[], roots: string[]): { panel: Record<string, any>; byRoot: Record<string, Record<string, any>> } {
        const panel: Record<string, any> = {};
        const byRoot: Record<string, Record<string, any>> = {};
        for (const tabKey of tabKeys) {
            const val = this.getPanelState(tabKey);
            if (val !== undefined) {
                panel[tabKey] = val;
            }
            byRoot[tabKey] = {};
            for (const root of roots) {
                const rval = this.getRootState(tabKey, root);
                if (rval !== undefined) {
                    byRoot[tabKey][root] = rval;
                }
            }
        }
        return { panel, byRoot };
    }

    private _key(tabKey: string) { return `switchboard.panelState.${this.panelKey}.${tabKey}`; }
}
