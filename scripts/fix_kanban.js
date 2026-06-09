const fs = require('fs');
const file = '/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts';
let code = fs.readFileSync(file, 'utf8');

// Use regex to find `this._panel?.webview.postMessage({ type: 'moveCards'...` 
// and move it up, before `if (this._cliTriggersEnabled)` or `await vscode.commands.executeCommand('switchboard.kanbanForwardMove'...`

const regex = /(?:[ \t]*if \(this\._cliTriggersEnabled\) \{[\s\S]*?\} else \{\s*await vscode\.commands\.executeCommand\('switchboard\.kanbanForwardMove'[^;]*;\s*\}|([ \t]*)await vscode\.commands\.executeCommand\('switchboard\.kanbanForwardMove'[^;]*;)([\s\S]*?)(\1this\._panel\?\.webview\.postMessage\(\{\s*type:\s*'moveCards'[^;]*;\n)/g;

let changedCount = 0;
// Actually the patterns are quite specific. It's better to just do string replacements.

const replacements = [
    {
        find: `                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });`,
        replace: `                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }`
    },
    {
        find: `                        if (dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled) {
                            const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                            const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, msg.sessionIds, {
                                targetColumn: nextCol,
                                dragDropMode: dispatchSpec.dragDropMode,
                                additionalInstructions: dispatchSpec.triggerPrompt,
                                instruction,
                                workspaceRoot: workspaceRoot || undefined
                            });
                            if (dispatched && dispatchSpec.role === 'lead') {
                                const leadCards = this._lastCards.filter(card =>
                                    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                                ).filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                                if (leadCards.length > 0) {
                                    await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                                }
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });`,
        replace: `                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                        if (dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled) {
                            const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                            const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, msg.sessionIds, {
                                targetColumn: nextCol,
                                dragDropMode: dispatchSpec.dragDropMode,
                                additionalInstructions: dispatchSpec.triggerPrompt,
                                instruction,
                                workspaceRoot: workspaceRoot || undefined
                            });
                            if (dispatched && dispatchSpec.role === 'lead') {
                                const leadCards = this._lastCards.filter(card =>
                                    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                                ).filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                                if (leadCards.length > 0) {
                                    await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                                }
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }`
    },
    {
        find: `                        if (this._cliTriggersEnabled) {
                            const role = this._columnToRole(nextCol);
                            if (role) {
                                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                                if (msg.sessionIds.length === 1) {
                                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, msg.sessionIds[0], instruction, workspaceRoot);
                                } else {
                                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, msg.sessionIds, instruction, workspaceRoot);
                                }
                            } else {
                                console.log(\`[Kanban] Column '\${nextCol}' has no role mapping, using visual move only\`);
                                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });`,
        replace: `                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                        if (this._cliTriggersEnabled) {
                            const role = this._columnToRole(nextCol);
                            if (role) {
                                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                                if (msg.sessionIds.length === 1) {
                                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, msg.sessionIds[0], instruction, workspaceRoot);
                                } else {
                                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, msg.sessionIds, instruction, workspaceRoot);
                                }
                            } else {
                                console.log(\`[Kanban] Column '\${nextCol}' has no role mapping, using visual move only\`);
                                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }`
    },
    {
        find: `                        if (dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled) {
                            const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                            const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, sessionIds, {
                                targetColumn: nextCol,
                                dragDropMode: dispatchSpec.dragDropMode,
                                additionalInstructions: dispatchSpec.triggerPrompt,
                                instruction,
                                workspaceRoot: workspaceRoot || undefined
                            });
                            if (dispatched && dispatchSpec.role === 'lead') {
                                const leadCards = sourceCards
                                    .filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                                if (leadCards.length > 0) {
                                    await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                                }
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });`,
        replace: `                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                        if (dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled) {
                            const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                            const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, sessionIds, {
                                targetColumn: nextCol,
                                dragDropMode: dispatchSpec.dragDropMode,
                                additionalInstructions: dispatchSpec.triggerPrompt,
                                instruction,
                                workspaceRoot: workspaceRoot || undefined
                            });
                            if (dispatched && dispatchSpec.role === 'lead') {
                                const leadCards = sourceCards
                                    .filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                                if (leadCards.length > 0) {
                                    await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                                }
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }`
    },
    {
        find: `                        if (this._cliTriggersEnabled) {
                            const role = this._columnToRole(nextCol);
                            if (role) {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                            } else {
                                console.log(\`[Kanban] Column '\${nextCol}' has no role mapping, using visual move only\`);
                                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });`,
        replace: `                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                        if (this._cliTriggersEnabled) {
                            const role = this._columnToRole(nextCol);
                            if (role) {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                            } else {
                                console.log(\`[Kanban] Column '\${nextCol}' has no role mapping, using visual move only\`);
                                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }`
    },
    {
        find: `                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });`,
        replace: `                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);`
    },
    {
        find: `                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });`,
        replace: `                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);`
    },
    {
        find: `                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });`,
        replace: `                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);`
    },
    {
        find: `                    vscode.window.showInformationMessage(\`Copied prompt for \${sourceCards.length} plans and advanced to \${nextCol}.\`);
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });`,
        replace: `                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                    vscode.window.showInformationMessage(\`Copied prompt for \${sourceCards.length} plans and advanced to \${nextCol}.\`);`
    },
    {
        find: `                    vscode.window.showInformationMessage(\`Copied prompt for \${sourceCards.length} plans and advanced to \${nextCol}.\`);
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });`,
        replace: `                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                    vscode.window.showInformationMessage(\`Copied prompt for \${sourceCards.length} plans and advanced to \${nextCol}.\`);`
    }
];

replacements.forEach((r) => {
    // Replace all globally
    let prev = '';
    while (prev !== code) {
        prev = code;
        code = code.replace(r.find, r.replace);
        if (prev !== code) changedCount++;
    }
});

fs.writeFileSync(file, code);
console.log('Replaced ' + changedCount + ' occurrences');
