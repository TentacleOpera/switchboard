/**
 * GlobalPlanWatcherService — VS Code adapter parity suite (Headless Ingestion
 * piece 1).
 *
 * The engine logic is covered by `PlanIngestionEngine.test.ts` (fake seam).
 * This file verifies the adapter contract that `extension.ts` depends on:
 *   - the constructor signature `(getClickUp, getLinear, getNotion?, outputChannel?)`,
 *   - the public API surface (`initialize`, `setFeatureColumnRecomputer`,
 *     `setFeatureFileRegenerator`, `registerPendingCreation`, `registerRename`,
 *     `refreshWatchers`, `triggerScan`, `runPurgeSweep`, `isGitOpActive`,
 *     `onPlanDiscovered`, `dispose`),
 *   - the `onPlanDiscovered` vscode.Event<{uri, workspaceRoot}> bridge shape.
 *
 * The pre-extraction private-method suites (setCurrentProject / upsertPlans /
 * _handlePlanFile-via-vscode-stubs) were stale — they referenced members
 * removed when project stamping moved to the DB layer. They are replaced here
 * by the engine's fake-seam suite + this adapter contract suite.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GlobalPlanWatcherService } from '../GlobalPlanWatcherService';
import { PlanIngestionEngine } from '../PlanIngestionEngine';

suite('GlobalPlanWatcherService (VS Code adapter parity)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => { sandbox = sinon.createSandbox(); });
    teardown(() => { sandbox.restore(); });

    test('constructs with the extension signature (getClickUp, getLinear, getNotion?, outputChannel?)', () => {
        const getClickUp = sandbox.stub();
        const getLinear = sandbox.stub();
        const outputChannel = { appendLine: sandbox.stub() } as any;
        const service = new GlobalPlanWatcherService(getClickUp, getLinear, undefined, outputChannel);
        assert.ok(service);
        service.dispose();
    });

    test('exposes the public API the extension wires', () => {
        const service = new GlobalPlanWatcherService(sandbox.stub(), sandbox.stub(), undefined, { appendLine: () => {} } as any);
        try {
            assert.strictEqual(typeof service.initialize, 'function');
            assert.strictEqual(typeof service.refreshWatchers, 'function');
            assert.strictEqual(typeof service.triggerScan, 'function');
            assert.strictEqual(typeof service.runPurgeSweep, 'function');
            assert.strictEqual(typeof service.setFeatureColumnRecomputer, 'function');
            assert.strictEqual(typeof service.setFeatureFileRegenerator, 'function');
            assert.strictEqual(typeof service.registerRename, 'function');
            assert.strictEqual(typeof service.isGitOpActive, 'function');
            assert.strictEqual(typeof service.dispose, 'function');
            assert.strictEqual(typeof GlobalPlanWatcherService.registerPendingCreation, 'function');
            assert.ok(service.onPlanDiscovered, 'onPlanDiscovered event must be exposed');
            assert.ok(service.getEngine() instanceof PlanIngestionEngine, 'getEngine() must return the PlanIngestionEngine');
        } finally { service.dispose(); }
    });

    test('onPlanDiscovered fires {uri, workspaceRoot} when the engine discovers a plan', async () => {
        const service = new GlobalPlanWatcherService(sandbox.stub(), sandbox.stub(), undefined, { appendLine: () => {} } as any);
        try {
            const events: { uri: vscode.Uri; workspaceRoot: string }[] = [];
            const sub = service.onPlanDiscovered((e) => { events.push(e); });
            // Drive the engine's discovered-plan callback directly — the adapter bridges it.
            const engine = service.getEngine();
            engine.onPlanDiscovered(() => {}); // ensure listener wiring is exercised
            (engine as any)._firePlanDiscovered('/mock/root', '/mock/root/.switchboard/plans/plan.md');
            // The adapter's bridge listener is registered in the constructor; firing the
            // engine's listeners should propagate to the adapter's EventEmitter.
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].workspaceRoot, '/mock/root');
            assert.strictEqual(events[0].uri.fsPath, '/mock/root/.switchboard/plans/plan.md');
            sub.dispose();
        } finally { service.dispose(); }
    });

    test('dispose disposes the engine and the EventEmitter', () => {
        const service = new GlobalPlanWatcherService(sandbox.stub(), sandbox.stub(), undefined, { appendLine: () => {} } as any);
        const engine = service.getEngine();
        const spy = sandbox.spy(engine, 'dispose');
        service.dispose();
        assert.ok(spy.calledOnce);
    });
});
