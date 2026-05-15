import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KanbanProvider, KanbanCard } from '../KanbanProvider';
import { KanbanColumnDefinition } from '../agentConfig';

suite('KanbanProvider', () => {
    let sandbox: sinon.SinonSandbox;
    let provider: KanbanProvider;
    let mockContext: any;

    const workspaceRoot = '/test/workspace';
    const makeCards = (count: number): KanbanCard[] =>
        Array.from({ length: count }, (_, i) => ({
            planId: `plan-${i + 1}`,
            sessionId: `session-${i + 1}`,
            topic: `Test Plan ${i + 1}`,
            planFile: `plan_${i + 1}.md`,
            column: 'TEST_COLUMN',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            complexity: 'medium',
            workspaceRoot,
            dependencies: [],
            hasBlockingDependencies: false
        }));

    setup(() => {
        sandbox = sinon.createSandbox();
        mockContext = {
            extensionUri: vscode.Uri.file('/test'),
            workspaceState: {
                get: sandbox.stub().callsFake((_key: string, def: any) => def),
                update: sandbox.stub().resolves()
            },
            globalState: {
                get: sandbox.stub().callsFake((_key: string, def: any) => def),
                update: sandbox.stub().resolves()
            },
            secrets: {
                get: sandbox.stub().resolves(''),
                store: sandbox.stub().resolves(),
                delete: sandbox.stub().resolves()
            }
        };
        provider = new KanbanProvider(vscode.Uri.file('/test'), mockContext);
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('_generatePromptForDestinationRole', () => {
        test('researcher role calls buildKanbanBatchPrompt with deep-research directive', async () => {
            const cards = makeCards(1);
            const mockDb = {
                ensureReady: sandbox.stub().resolves(true),
                getPlanBySessionId: sandbox.stub().resolves(undefined)
            };
            sandbox.stub(provider as any, '_getKanbanDb').returns(mockDb);
            sandbox.stub(provider as any, '_getDefaultPromptOverrides').resolves({});
            sandbox.stub(provider as any, '_getPromptsConfig').resolves({
                gitProhibitionByRole: { researcher: true },
                switchboardSafeguardsByRole: { researcher: true }
            });

            const prompt = await (provider as any)._generatePromptForDestinationRole(
                cards, 'researcher', workspaceRoot, 'Test Column'
            );

            assert.ok(prompt.includes('DEEP RESEARCH MODE'), 'Should include deep-research directive');
            assert.ok(prompt.includes('You are a Researcher Agent'), 'Should identify as researcher');
            assert.ok(!prompt.includes('Please execute'), 'Should NOT be an execution prompt');
        });

        test('custom_agent_devin returns generic plan-file-link prompt without crashing', async () => {
            const cards = makeCards(2);
            const mockDb = {
                ensureReady: sandbox.stub().resolves(true),
                getPlanBySessionId: sandbox.stub().resolves(undefined)
            };
            sandbox.stub(provider as any, '_getKanbanDb').returns(mockDb);

            const prompt = await (provider as any)._generatePromptForDestinationRole(
                cards, 'custom_agent_devin', workspaceRoot, 'Test Column'
            );

            assert.ok(prompt.includes('Please process the following plans.'), 'Should have generic intro');
            assert.ok(prompt.includes('PLANS TO PROCESS:'), 'Should include plan list header');
            assert.ok(!prompt.includes('Please execute'), 'Should NOT be an execution prompt');
            assert.ok(!prompt.includes('Unknown role'), 'Should NOT throw unknown role error');
        });
    });

    suite('_generatePromptForColumn', () => {
        test('routes custom-user column with role through _generatePromptForDestinationRole correctly', async () => {
            const cards = makeCards(1);
            const customColumns: KanbanColumnDefinition[] = [
                {
                    id: 'CREATED',
                    label: 'New',
                    order: 0,
                    kind: 'created',
                    source: 'built-in',
                    autobanEnabled: true,
                    dragDropMode: 'cli'
                },
                {
                    id: 'CUSTOM_TEST',
                    label: 'Custom Test',
                    role: 'custom_agent_devin',
                    order: 50,
                    kind: 'custom-user',
                    source: 'custom-user',
                    autobanEnabled: false,
                    dragDropMode: 'prompt'
                }
            ];

            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_buildKanbanColumns').returns(customColumns);

            const destinationRoleStub = sandbox.stub(provider as any, '_generatePromptForDestinationRole').resolves('mock-prompt');

            await (provider as any)._generatePromptForColumn(cards, 'CUSTOM_TEST', workspaceRoot);

            assert.strictEqual(destinationRoleStub.callCount, 1, 'Should route through _generatePromptForDestinationRole');
            const [actualCards, actualRole, actualWorkspaceRoot, actualSourceColumnLabel] = destinationRoleStub.firstCall.args;
            assert.strictEqual(actualRole, 'custom_agent_devin', 'Should resolve role from custom-user column definition');
            assert.strictEqual(actualWorkspaceRoot, workspaceRoot);
            assert.strictEqual(actualSourceColumnLabel, 'Custom Test', 'Should use custom column label');
            assert.deepStrictEqual(actualCards, cards);
        });
    });

    suite('_getNextColumnId', () => {
        const defaultColumns: KanbanColumnDefinition[] = [
            { id: 'CREATED', label: 'New', order: 0, kind: 'created', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
            { id: 'RESEARCHER', label: 'Researcher', role: 'researcher', order: 90, kind: 'review', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
            { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
            { id: 'SPLITTER', label: 'Splitter', role: 'splitter', order: 110, kind: 'review', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
            { id: 'CONTEXT GATHERER', label: 'Context Gatherer', role: 'gatherer', order: 150, kind: 'gather', source: 'built-in', autobanEnabled: false, dragDropMode: 'disabled', hideWhenNoAgent: true },
            { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
            { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
            { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
            { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli' },
            { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', order: 350, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli', hideWhenNoAgent: true },
            { id: 'TICKET UPDATER', label: 'Ticket Updater', role: 'ticket_updater', order: 9000, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
            { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli' }
        ];

        const stubDeps = (visibleAgents: Record<string, boolean>, designDocConfigured: boolean) => {
            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_buildKanbanColumns').returns(defaultColumns);
            sandbox.stub(provider as any, '_getVisibleAgents').resolves(visibleAgents);
            sandbox.stub(provider as any, '_isAcceptanceTesterDesignDocConfigured').returns(designDocConfigured);
        };

        test('CREATED -> next skips hidden RESEARCHER when researcher not visible', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CREATED', workspaceRoot);
            assert.strictEqual(next, 'PLAN REVIEWED');
        });

        test('PLAN REVIEWED -> next skips SPLITTER and CONTEXT GATHERER when invisible', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('PLAN REVIEWED', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED');
        });

        test('CODE REVIEWED -> next returns null when tester inactive (skips ACCEPTANCE TESTED and COMPLETED bypass)', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CODE REVIEWED', workspaceRoot);
            assert.strictEqual(next, null);
        });

        test('CODE REVIEWED -> next goes to ACCEPTANCE TESTED when tester active and design doc configured', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: true, ticket_updater: false }, true);
            const next = await (provider as any)._getNextColumnId('CODE REVIEWED', workspaceRoot);
            assert.strictEqual(next, 'ACCEPTANCE TESTED');
        });

        test('LEAD CODED -> next exits parallel lane to CODE REVIEWED', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('LEAD CODED', workspaceRoot);
            assert.strictEqual(next, 'CODE REVIEWED');
        });

        test('CODER CODED -> next exits parallel lane to CODE REVIEWED', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CODER CODED', workspaceRoot);
            assert.strictEqual(next, 'CODE REVIEWED');
        });

        test('INTERN CODED -> next exits parallel lane to CODE REVIEWED', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('INTERN CODED', workspaceRoot);
            assert.strictEqual(next, 'CODE REVIEWED');
        });

        test('Recovery: RESEARCHER -> next advances to PLAN REVIEWED even when researcher invisible', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('RESEARCHER', workspaceRoot);
            assert.strictEqual(next, 'PLAN REVIEWED');
        });

        test('Recovery: CONTEXT GATHERER -> next advances to LEAD CODED even when gatherer invisible', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CONTEXT GATHERER', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED');
        });

        test('Last column returns null', async () => {
            stubDeps({ researcher: false, splitter: false, gatherer: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('COMPLETED', workspaceRoot);
            assert.strictEqual(next, null);
        });

        test('Custom hideWhenNoAgent column with visibleAgents false is skipped', async () => {
            const columnsWithCustom: KanbanColumnDefinition[] = [
                ...defaultColumns.slice(0, 1),
                { id: 'CUSTOM_HIDDEN', label: 'Custom Hidden', role: 'custom_agent_devin', order: 50, kind: 'custom-user', source: 'custom-user', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
                ...defaultColumns.slice(1)
            ];
            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_buildKanbanColumns').returns(columnsWithCustom);
            sandbox.stub(provider as any, '_getVisibleAgents').resolves({ researcher: false, custom_agent_devin: false, tester: false });
            sandbox.stub(provider as any, '_isAcceptanceTesterDesignDocConfigured').returns(false);
            const next = await (provider as any)._getNextColumnId('CREATED', workspaceRoot);
            assert.strictEqual(next, 'PLAN REVIEWED');
        });
    });

    suite('_parseVerificationSteps', () => {
        test('parses "Manual Verification" section', () => {
            const content = `
### Manual Verification
1. Step one
2. Step two
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Step one', 'Step two']);
        });

        test('parses "Manual Testing" section', () => {
            const content = `
### Manual Testing
1. Test first
2. Test second
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Test first', 'Test second']);
        });

        test('returns empty array when section is missing', () => {
            const content = `
### Something Else
1. Not a step
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, []);
        });

        test('returns empty array when section is present but empty', () => {
            const content = `
### Manual Testing

### Next Section
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, []);
        });
    });

    suite('refreshWithData', () => {
        test('filters out ghost plans whose files do not exist', async () => {
            const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
            const activeRows: any[] = [
                { planId: 'active-1', sessionId: 's1', planFile: 'exists.md', kanbanColumn: 'CREATED' },
                { planId: 'active-2', sessionId: 's2', planFile: 'missing.md', kanbanColumn: 'CREATED' }
            ];
            const completedRows: any[] = [
                { planId: 'comp-1', sessionId: 's3', planFile: 'exists-comp.md' },
                { planId: 'comp-2', sessionId: 's4', planFile: 'missing-comp.md' }
            ];

            const existsStub = sandbox.stub(fs, 'existsSync');
            existsStub.withArgs(path.resolve(resolvedWorkspaceRoot, 'exists.md')).returns(true);
            existsStub.withArgs(path.resolve(resolvedWorkspaceRoot, 'missing.md')).returns(false);
            existsStub.withArgs(path.resolve(resolvedWorkspaceRoot, 'exists-comp.md')).returns(true);
            existsStub.withArgs(path.resolve(resolvedWorkspaceRoot, 'missing-comp.md')).returns(false);

            // Stub _getKanbanDb to avoid real path validation
            const mockDb = {
                ensureReady: sandbox.stub().resolves(true)
            };
            sandbox.stub(provider as any, '_getKanbanDb').returns(mockDb);

            // Mock panel and webview
            const postMessageStub = sandbox.stub();
            (provider as any)._panel = {
                webview: {
                    postMessage: postMessageStub
                }
            };

            // Mock other dependencies
            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_getVisibleAgents').resolves({});
            sandbox.stub(provider as any, '_getWorkspaceItems').returns([]);

            await provider.refreshWithData(activeRows, completedRows, workspaceRoot);

            // Verify updateBoard message
            const updateBoardCall = postMessageStub.getCalls().find((call: any) => call.args[0].type === 'updateBoard');
            assert.ok(updateBoardCall, 'Should have sent updateBoard message');
            const cards = updateBoardCall.args[0].cards;
            
            assert.strictEqual(cards.length, 2, 'Should only have 2 cards after filtering');
            assert.ok(cards.find((c: any) => c.planId === 'active-1'), 'Should contain active-1');
            assert.ok(cards.find((c: any) => c.planId === 'comp-1'), 'Should contain comp-1');
            assert.ok(!cards.find((c: any) => c.planId === 'active-2'), 'Should NOT contain active-2');
            assert.ok(!cards.find((c: any) => c.planId === 'missing-comp'), 'Should NOT contain missing-comp');
        });
    });
});
