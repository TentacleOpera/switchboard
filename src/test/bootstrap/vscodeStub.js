'use strict';

/**
 * Minimal `vscode` module stub for tests that run under plain mocha (no VS Code
 * host).
 *
 * Shared services import `vscode` at module scope — `workspaceUtils.ts` does —
 * so requiring them outside the extension host throws MODULE_NOT_FOUND before a
 * single assertion runs. Their *runtime* vscode access is already wrapped in
 * try/catch for the headless/browser host, so an empty workspace is the correct
 * shape: it exercises the same branch the standalone host takes.
 *
 * Preload with `mocha --require ./src/test/bootstrap/vscodeStub.js`.
 */
const Module = require('module');

/**
 * Minimal `vscode.Uri`. Constructors that only STORE a Uri (KanbanProvider takes
 * an extensionUri it never dereferences headlessly) need `Uri.file` to exist and
 * to round-trip `fsPath` / `path`; they do not need the real URI algebra. Added
 * additively — before this, `vscode.Uri` was `undefined`, so nothing can be
 * relying on its absence.
 */
class StubUri {
    constructor(fsPath) {
        this.scheme = 'file';
        this.authority = '';
        this.path = String(fsPath || '');
        this.fsPath = String(fsPath || '');
        this.query = '';
        this.fragment = '';
    }
    with(change) {
        return new StubUri((change && change.path) || this.fsPath);
    }
    toString() { return `file://${this.fsPath}`; }
    toJSON() { return { scheme: this.scheme, path: this.path, fsPath: this.fsPath }; }
}
StubUri.file = (p) => new StubUri(p);
StubUri.parse = (v) => new StubUri(String(v).replace(/^file:\/\//, ''));
StubUri.joinPath = (base, ...segs) =>
    new StubUri([base.fsPath, ...segs].join('/').replace(/\/+/g, '/'));

/**
 * Minimal `vscode.EventEmitter`. Services construct these as instance fields at
 * module/constructor time (KanbanProvider does), so the class must exist before
 * any behaviour under test runs. Fire-and-forget semantics, no disposal
 * bookkeeping beyond unsubscribing.
 */
class StubEventEmitter {
    constructor() {
        this._listeners = new Set();
        this.event = (listener) => {
            this._listeners.add(listener);
            return { dispose: () => this._listeners.delete(listener) };
        };
    }
    fire(value) {
        for (const l of [...this._listeners]) {
            try { l(value); } catch { /* a listener throwing must not break the emitter */ }
        }
    }
    dispose() { this._listeners.clear(); }
}

const stub = {
    Uri: StubUri,
    EventEmitter: StubEventEmitter,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: () => undefined }),
    },
    window: {
        showInformationMessage: () => undefined,
        showWarningMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return stub;
    }
    return originalLoad.apply(this, arguments);
};

module.exports = stub;
