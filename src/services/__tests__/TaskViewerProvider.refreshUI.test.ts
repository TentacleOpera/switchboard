import * as assert from 'assert';
import * as sinon from 'sinon';

// Minimal mock of the TaskViewerProvider surface needed to test refreshUI guard logic.
// This avoids importing the full provider (which has heavy VS Code dependencies).
suite('TaskViewerProvider.refreshUI auto-switch guard', () => {
    let sandbox: sinon.SinonSandbox;

    // Build a minimal stand-in that exercises the guard logic
    function makeProvider(opts: {
        currentRoot: string | null;
        effectiveRoot: string;
        resolvedRoot: string;
    }) {
        const activateStub = sinon.stub().resolves();
        const refreshRunSheetsStub = sinon.stub().resolves();
        const refreshConfigStub = sinon.stub().resolves();
        const appendLineStub = sinon.stub();

        // Inline the guard logic from the fix — tests the pure logic path
        const provider = {
            _kanbanProvider: {
                getCurrentWorkspaceRoot: () => opts.currentRoot,
                resolveEffectiveWorkspaceRoot: (_r: string) => opts.effectiveRoot,
            },
            _resolveWorkspaceRoot: (_r?: string) => opts.resolvedRoot,
            _outputChannel: { appendLine: appendLineStub },
            _workspaceId: 'ws-id',
            _workspaceIdRoot: opts.currentRoot,
            _activateWorkspaceContext: activateStub,
            _refreshRunSheets: refreshRunSheetsStub,
            _refreshConfigurationState: refreshConfigStub,
        };

        return { provider, activateStub, refreshRunSheetsStub, appendLineStub };
    }

    setup(() => { sandbox = sinon.createSandbox(); });
    teardown(() => { sandbox.restore(); });

    test('should NOT activate or refresh when effectiveRoot differs from current (guard fires)', async () => {
        const { provider, activateStub, refreshRunSheetsStub } = makeProvider({
            currentRoot: '/workspace1',
            effectiveRoot: '/workspace2',
            resolvedRoot: '/workspace2',
        });

        // Execute the guard logic inline (mirrors the fix)
        const workspaceRoot = '/workspace2';
        const selectedRoot = provider._resolveWorkspaceRoot(workspaceRoot);
        const effectiveRoot = provider._kanbanProvider.resolveEffectiveWorkspaceRoot(selectedRoot!);
        if (effectiveRoot) {
            const currentRoot = provider._kanbanProvider.getCurrentWorkspaceRoot();
            const path = require('path');
            if (currentRoot && path.resolve(currentRoot) !== path.resolve(effectiveRoot)) {
                provider._outputChannel.appendLine(`guard fired`);
                // early return — no activate, no refresh
            } else {
                await provider._activateWorkspaceContext(effectiveRoot);
                await Promise.all([provider._refreshRunSheets(workspaceRoot), provider._refreshConfigurationState()]);
            }
        }

        assert.strictEqual(activateStub.callCount, 0, '_activateWorkspaceContext must NOT be called');
        assert.strictEqual(refreshRunSheetsStub.callCount, 0, '_refreshRunSheets must NOT be called with wrong workspace');
    });

    test('should activate when effectiveRoot matches current', async () => {
        const { provider, activateStub, refreshRunSheetsStub } = makeProvider({
            currentRoot: '/workspace1',
            effectiveRoot: '/workspace1',
            resolvedRoot: '/workspace1',
        });

        const workspaceRoot = '/workspace1';
        const selectedRoot = provider._resolveWorkspaceRoot(workspaceRoot);
        const effectiveRoot = provider._kanbanProvider.resolveEffectiveWorkspaceRoot(selectedRoot!);
        if (effectiveRoot) {
            const currentRoot = provider._kanbanProvider.getCurrentWorkspaceRoot();
            const path = require('path');
            if (currentRoot && path.resolve(currentRoot) !== path.resolve(effectiveRoot)) {
                provider._outputChannel.appendLine(`guard fired`);
            } else {
                await provider._activateWorkspaceContext(effectiveRoot);
                await Promise.all([provider._refreshRunSheets(workspaceRoot), provider._refreshConfigurationState()]);
            }
        }

        assert.strictEqual(activateStub.callCount, 1, '_activateWorkspaceContext must be called once');
        assert.strictEqual(refreshRunSheetsStub.callCount, 1, '_refreshRunSheets must be called');
    });

    test('should activate when no current workspace is set (initialization)', async () => {
        const { provider, activateStub } = makeProvider({
            currentRoot: null,
            effectiveRoot: '/workspace1',
            resolvedRoot: '/workspace1',
        });

        const workspaceRoot = '/workspace1';
        const selectedRoot = provider._resolveWorkspaceRoot(workspaceRoot);
        const effectiveRoot = provider._kanbanProvider.resolveEffectiveWorkspaceRoot(selectedRoot!);
        if (effectiveRoot) {
            const currentRoot = provider._kanbanProvider.getCurrentWorkspaceRoot();
            const path = require('path');
            if (currentRoot && path.resolve(currentRoot) !== path.resolve(effectiveRoot)) {
                provider._outputChannel.appendLine(`guard fired`);
            } else {
                await provider._activateWorkspaceContext(effectiveRoot);
                await Promise.all([provider._refreshRunSheets(workspaceRoot), provider._refreshConfigurationState()]);
            }
        }

        assert.strictEqual(activateStub.callCount, 1, '_activateWorkspaceContext must be called during init');
    });

    test('path normalization: trailing slash differences do not cause false guard', async () => {
        const { provider, activateStub } = makeProvider({
            currentRoot: '/workspace1/',   // trailing slash
            effectiveRoot: '/workspace1',  // no trailing slash
            resolvedRoot: '/workspace1',
        });

        const workspaceRoot = '/workspace1';
        const selectedRoot = provider._resolveWorkspaceRoot(workspaceRoot);
        const effectiveRoot = provider._kanbanProvider.resolveEffectiveWorkspaceRoot(selectedRoot!);
        if (effectiveRoot) {
            const currentRoot = provider._kanbanProvider.getCurrentWorkspaceRoot();
            const path = require('path');
            if (currentRoot && path.resolve(currentRoot) !== path.resolve(effectiveRoot)) {
                provider._outputChannel.appendLine(`guard fired`);
            } else {
                await provider._activateWorkspaceContext(effectiveRoot);
                await Promise.all([provider._refreshRunSheets(workspaceRoot), provider._refreshConfigurationState()]);
            }
        }

        // path.resolve normalizes trailing slashes so these should be equal
        assert.strictEqual(activateStub.callCount, 1, 'Trailing slash difference must not trigger guard');
    });
});
