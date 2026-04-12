'use strict';

const Module = require('module');

function installVsCodeMock() {
    const originalLoad = Module._load;
    const state = {
        inputBoxCalls: [],
        inputBoxResponses: [],
        quickPickCalls: [],
        quickPickResponses: [],
        informationMessageCalls: [],
        informationMessageResponses: [],
        warningMessageCalls: [],
        warningMessageResponses: [],
        errorMessageCalls: [],
        errorMessageResponses: [],
        openExternalCalls: []
    };

    async function nextResponse(queue, ...args) {
        if (queue.length === 0) {
            return undefined;
        }
        const next = queue.shift();
        return typeof next === 'function' ? await next(...args) : next;
    }

    const mock = {
        window: {
            showInputBox: async (options) => {
                state.inputBoxCalls.push(options);
                return await nextResponse(state.inputBoxResponses, options);
            },
            showQuickPick: async (items, options) => {
                state.quickPickCalls.push({ items, options });
                return await nextResponse(state.quickPickResponses, items, options);
            },
            showInformationMessage: async (message, ...actions) => {
                state.informationMessageCalls.push({ message, actions });
                return await nextResponse(state.informationMessageResponses, message, actions);
            },
            showWarningMessage: async (message, ...actions) => {
                state.warningMessageCalls.push({ message, actions });
                return await nextResponse(state.warningMessageResponses, message, actions);
            },
            showErrorMessage: async (message, ...actions) => {
                state.errorMessageCalls.push({ message, actions });
                return await nextResponse(state.errorMessageResponses, message, actions);
            }
        },
        env: {
            appName: 'VS Code',
            openExternal: async (uri) => {
                state.openExternalCalls.push(uri);
                return true;
            }
        },
        Uri: {
            parse(value) {
                return {
                    fsPath: value,
                    path: value,
                    toString() {
                        return value;
                    }
                };
            }
        }
    };

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return mock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    return {
        state,
        mock,
        restore() {
            Module._load = originalLoad;
        }
    };
}

module.exports = { installVsCodeMock };
