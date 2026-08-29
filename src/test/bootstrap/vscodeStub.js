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

const stub = {
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
