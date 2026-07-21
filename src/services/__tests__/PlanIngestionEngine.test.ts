/**
 * PlanIngestionEngine — shared behavioural suite (Headless Ingestion piece 1).
 *
 * Exercises the host-agnostic engine through a FAKE host seam (no VS Code, no
 * real filesystem watcher) so parity is a passing suite, not a claim. The VS
 * Code adapter (`GlobalPlanWatcherService`) is behaviour-preserving over this
 * engine; this suite is the guard that any behavioural drift shows up as a
 * failing test.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { PlanIngestionEngine, expandHome, type PlanIngestionHost, type PlanIngestionWatcher, type PlanIngestionWatchHandle, type PlanIngestionWatchEvent } from '../PlanIngestionEngine';
import { KanbanDatabase } from '../KanbanDatabase';

// ─── Fake host seam ─────────────────────────────────────────────────────────

interface FakeHostOptions {
    periodicScanEnabled?: boolean;
    scanIntervalMs?: number;
    activityLightTimeoutMs?: number;
    roots?: string[];
}

class FakePlanIngestionHost implements PlanIngestionHost {
    readonly logs: string[] = [];
    readonly watcher: PlanIngestionWatcher;
    readonly envHandlers = new Set<(kind: 'roots' | 'config') => void>();
    private _opts: Required<FakeHostOptions>;
    private _roots: string[];

    constructor(opts: FakeHostOptions = {}) {
        this._opts = {
            periodicScanEnabled: opts.periodicScanEnabled ?? false,
            scanIntervalMs: opts.scanIntervalMs ?? 10000,
            activityLightTimeoutMs: opts.activityLightTimeoutMs ?? 600000,
            roots: opts.roots ?? [],
        };
        this._roots = this._opts.roots;
        this.watcher = {
            watchFolder: () => ({ dispose: () => {} }),
            watchFile: () => ({ dispose: () => {} }),
        };
    }

    setRoots(roots: string[]): void { this._roots = roots; }
    fireEnvironment(kind: 'roots' | 'config'): void {
        for (const h of this.envHandlers) { try { h(kind); } catch {} }
    }

    getConfig(section: 'planWatcher' | 'activityLight') {
        return {
            getBoolean: (key: string, def: boolean) => {
                if (section === 'planWatcher' && key === 'periodicScanEnabled') return this._opts.periodicScanEnabled;
                return def;
            },
            getNumber: (key: string, def: number) => {
                if (section === 'planWatcher' && key === 'scanIntervalMs') return this._opts.scanIntervalMs;
                if (section === 'activityLight' && key === 'timeoutMs') return this._opts.activityLightTimeoutMs;
                return def;
            },
        };
    }

    logger = { appendLine: (line: string) => { this.logs.push(line); } };

    async listWatchedRoots(): Promise<string[]> { return this._roots; }

    onEnvironmentChanged(handler: (kind: 'roots' | 'config') => void): PlanIngestionWatchHandle {
        this.envHandlers.add(handler);
        return { dispose: () => { this.envHandlers.delete(handler); } };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTempWorkspace(): { root: string; plansDir: string; featuresDir: string; dbPath: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-engine-test-'));
    const switchboardDir = path.join(root, '.switchboard');
    const plansDir = path.join(switchboardDir, 'plans');
    const featuresDir = path.join(switchboardDir, 'features');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(featuresDir, { recursive: true });
    // The DB file must exist on disk before ensureReady() can initialise it
    // (matches bootstrap.ts's behaviour). Create an empty file so sql.js picks it up.
    const dbPath = path.join(switchboardDir, 'kanban.db');
    fs.writeFileSync(dbPath, Buffer.alloc(0));
    return { root, plansDir, featuresDir, dbPath, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function fakeClickUpFactory() {
    return sinon.stub().returns({
        loadConfig: sinon.stub().resolves({ setupComplete: false, realTimeSyncEnabled: false }),
        hasApiToken: sinon.stub().resolves(false),
        debouncedSync: sinon.stub(),
        archiveTask: sinon.stub(),
    });
}

function fakeLinearFactory() {
    return sinon.stub().returns({
        loadConfig: sinon.stub().resolves({ deleteSyncEnabled: false }),
        archiveIssue: sinon.stub(),
    });
}

suite('PlanIngestionEngine (shared behavioural suite, fake seam)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => { sandbox = sinon.createSandbox(); });
    teardown(() => { sandbox.restore(); });

    suite('initialize / periodic scan', () => {
        test('periodic scan disabled = no interval started', async () => {
            const host = new FakePlanIngestionHost({ periodicScanEnabled: false, roots: [] });
            const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
            try {
                await engine.initialize();
                assert.strictEqual((engine as any)._scanInterval, undefined);
                assert.ok(host.logs.some(l => l.includes('Periodic scan disabled')));
            } finally { engine.dispose(); }
        });

        test('periodic scan enabled = interval started', async () => {
            const host = new FakePlanIngestionHost({ periodicScanEnabled: true, scanIntervalMs: 10000, roots: [] });
            const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
            try {
                await engine.initialize();
                assert.notStrictEqual((engine as any)._scanInterval, undefined);
            } finally { engine.dispose(); }
        });

        test('environment config change restarts periodic scan', async () => {
            const host = new FakePlanIngestionHost({ periodicScanEnabled: true, roots: [] });
            const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
            try {
                await engine.initialize();
                const first = (engine as any)._scanInterval;
                host.fireEnvironment('config');
                assert.ok(host.logs.some(l => l.includes('config changed, restarting periodic scan')));
                // The interval is rebuilt; the old timer is cleared and a new one set.
                assert.notStrictEqual((engine as any)._scanInterval, undefined);
                void first;
            } finally { engine.dispose(); }
        });

        test('environment roots change triggers refreshWatchers', async () => {
            const host = new FakePlanIngestionHost({ periodicScanEnabled: false, roots: [] });
            const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
            try {
                await engine.initialize();
                host.fireEnvironment('roots');
                assert.ok(host.logs.some(l => l.includes('Workspace folders changed, refreshing watchers')));
            } finally { engine.dispose(); }
        });
    });

    suite('ingestPlanFile (create / update / delete)', () => {
        test('ingesting a new plan file inserts it into the DB', async () => {
            const ws = makeTempWorkspace();
            try {
                KanbanDatabase.setPathConfigProvider({
                    workspaceRoot: ws.root,
                    getConfigString: () => '',
                    getConfigStringWithDefault: (_k: string, d: string) => d,
                    getConfigBoolean: (_k: string, d: boolean) => d,
                    getConfigNumber: (_k: string, d: number) => d,
                    getConfigJson: <T>(_k: string, d: T): T => d,
                    updateConfigGlobal: async () => {},
                    updateConfigWorkspace: async () => {},
                } as any);
                const db = KanbanDatabase.forWorkspace(ws.root);
                await db.ensureReady();
                const workspaceId = await db.getWorkspaceId();
                assert.ok(workspaceId);

                const host = new FakePlanIngestionHost({ roots: [ws.root] });
                const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
                let discovered = 0;
                engine.onPlanDiscovered(() => { discovered++; });
                try {
                    const planPath = path.join(ws.plansDir, 'plan-alpha.md');
                    fs.writeFileSync(planPath, '# Plan Alpha\n\n## Goal\nDo the thing.\n', 'utf8');
                    await engine.ingestPlanFile(planPath, ws.root);
                    assert.ok(discovered >= 1, 'onPlanDiscovered should fire on ingest');
                    const plans = await db.getAllPlans(workspaceId!);
                    assert.ok(plans.some(p => p.planFile.endsWith('plan-alpha.md')));
                } finally {
                    engine.dispose();
                }
            } finally {
                ws.cleanup();
            }
        });

        test('brain-mirror file is skipped', async () => {
            const ws = makeTempWorkspace();
            try {
                KanbanDatabase.setPathConfigProvider({
                    workspaceRoot: ws.root,
                    getConfigString: () => '',
                    getConfigStringWithDefault: (_k: string, d: string) => d,
                    getConfigBoolean: (_k: string, d: boolean) => d,
                    getConfigNumber: (_k: string, d: number) => d,
                    getConfigJson: <T>(_k: string, d: T): T => d,
                    updateConfigGlobal: async () => {},
                    updateConfigWorkspace: async () => {},
                } as any);
                const db = KanbanDatabase.forWorkspace(ws.root);
                await db.ensureReady();
                const workspaceId = await db.getWorkspaceId();

                const host = new FakePlanIngestionHost({ roots: [ws.root] });
                const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
                try {
                    // A runtime-mirror filename (matches isRuntimeMirrorPlanFile's heuristic:
                    // brain_<64-hex>.md or ingested_<64-hex>.md).
                    const hex64 = 'a'.repeat(64);
                    const mirrorPath = path.join(ws.plansDir, `brain_${hex64}.md`);
                    fs.writeFileSync(mirrorPath, '# mirror\n', 'utf8');
                    await engine.ingestPlanFile(mirrorPath, ws.root);
                    assert.ok(host.logs.some(l => l.includes('Skipped brain mirror file')));
                    const plans = await db.getAllPlans(workspaceId!);
                    assert.ok(!plans.some(p => p.planFile.includes(`brain_${hex64}`)));
                } finally { engine.dispose(); }
            } finally { ws.cleanup(); }
        });
    });

    suite('registerPendingCreation / registerRename', () => {
        test('registerPendingCreation suppresses ingest for internally-created files', async () => {
            const ws = makeTempWorkspace();
            try {
                KanbanDatabase.setPathConfigProvider({
                    workspaceRoot: ws.root,
                    getConfigString: () => '',
                    getConfigStringWithDefault: (_k: string, d: string) => d,
                    getConfigBoolean: (_k: string, d: boolean) => d,
                    getConfigNumber: (_k: string, d: number) => d,
                    getConfigJson: <T>(_k: string, d: T): T => d,
                    updateConfigGlobal: async () => {},
                    updateConfigWorkspace: async () => {},
                } as any);
                const db = KanbanDatabase.forWorkspace(ws.root);
                await db.ensureReady();
                const workspaceId = await db.getWorkspaceId();

                const host = new FakePlanIngestionHost({ roots: [ws.root] });
                const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
                try {
                    const planPath = path.join(ws.plansDir, 'plan-pending.md');
                    fs.writeFileSync(planPath, '# pending\n', 'utf8');
                    PlanIngestionEngine.registerPendingCreation(planPath);
                    await engine.ingestPlanFile(planPath, ws.root);
                    assert.ok(host.logs.some(l => l.includes('Skipping watcher insert for internally created plan')));
                    const plans = await db.getAllPlans(workspaceId!);
                    assert.ok(!plans.some(p => p.planFile.includes('plan-pending')));
                } finally { engine.dispose(); }
            } finally { ws.cleanup(); }
        });

        test('registerRename marks a rename that suppresses the subsequent delete', async () => {
            const ws = makeTempWorkspace();
            try {
                KanbanDatabase.setPathConfigProvider({
                    workspaceRoot: ws.root,
                    getConfigString: () => '',
                    getConfigStringWithDefault: (_k: string, d: string) => d,
                    getConfigBoolean: (_k: string, d: boolean) => d,
                    getConfigNumber: (_k: string, d: number) => d,
                    getConfigJson: <T>(_k: string, d: T): T => d,
                    updateConfigGlobal: async () => {},
                    updateConfigWorkspace: async () => {},
                } as any);
                await KanbanDatabase.forWorkspace(ws.root).ensureReady();

                const host = new FakePlanIngestionHost({ roots: [ws.root] });
                const engine = new PlanIngestionEngine(fakeClickUpFactory(), fakeLinearFactory(), host);
                try {
                    engine.registerRename('.switchboard/plans/old.md');
                    // Drive the delete path directly; the file does not exist on disk so the
                    // atomic-write guard would normally proceed — the rename guard must pre-empt it.
                    await (engine as any)._handlePlanDelete(path.join(ws.plansDir, 'old.md'), ws.root);
                    assert.ok(host.logs.some(l => l.includes('Skipping delete for recently-renamed plan')));
                } finally { engine.dispose(); }
            } finally { ws.cleanup(); }
        });
    });

    suite('expandHome', () => {
        test('expands a leading ~ to the home directory', () => {
            const home = os.homedir();
            assert.strictEqual(expandHome('~/foo/bar'), path.join(home, 'foo/bar'));
        });
        test('leaves absolute paths untouched', () => {
            assert.strictEqual(expandHome('/abs/path'), '/abs/path');
        });
    });
});
