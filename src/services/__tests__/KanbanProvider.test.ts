import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KanbanProvider, KanbanCard } from '../KanbanProvider';
import { KanbanColumnDefinition } from '../agentConfig';
import { KanbanDatabase } from '../KanbanDatabase';

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
            { id: 'CONTEXT GATHERER', label: 'Context Gatherer', role: 'gatherer', order: 50, kind: 'review', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
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

        test('parses "Manual Verification Steps" section (Pattern 1 with Steps suffix)', () => {
            const content = `
### Manual Verification Steps
1. Verify steps suffix works
2. Another step
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Verify steps suffix works', 'Another step']);
        });

        test('parses "Manual Checklist" section with checkboxes (Pattern 1 with Checklist and checkboxes)', () => {
            const content = `
### Manual Checklist
- [ ] First checklist item
- [x] Second checklist item
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['First checklist item', 'Second checklist item']);
        });

        test('parses "## Verification Plan" with manual-specific subheading and blank lines (Pattern 3)', () => {
            const content = `
## Verification Plan

### Automated Tests
- No automated tests.

Manual verification steps:

1. Click button
2. Verify animation plays
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Click button', 'Verify animation plays']);
        });

        test('ignores non-manual sections in "## Verification Plan" (Pattern 3)', () => {
            const content = `
## Verification Plan

### Automated Tests
1. This is automated
2. Also automated

### Manual Verification
1. This is manual
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            // Since "### Manual Verification" matches Pattern 1, it will be parsed by Pattern 1,
            // and Pattern 3 won't run due to the dedup guard.
            assert.deepStrictEqual(steps, ['This is manual']);
        });

        test('applies dedup guard and does not duplicate steps (Pattern 1 vs Pattern 3)', () => {
            const content = `
## Verification Plan

### Manual Verification Steps
1. Perform action

## Another Section
Manual verification steps:
1. Perform action again
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            // Pattern 1 parses 'Perform action'. Pattern 3 is skipped because steps.length > 0.
            assert.deepStrictEqual(steps, ['Perform action']);
        });

        test('parses "Manual Testing Steps" section (Pattern 1 with Testing + Steps suffix)', () => {
            const content = `
### Manual Testing Steps
1. Run the test suite
2. Verify no regressions
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Run the test suite', 'Verify no regressions']);
        });

        test('returns empty for "## Verification Plan" with no manual subheading (Pattern 3)', () => {
            const content = `
## Verification Plan

### Automated Tests
1. Run unit tests
2. Check integration tests
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, []);
        });

        test('parses "Manual verification:" without "step/steps" under "## Verification Plan" (Pattern 3)', () => {
            const content = `
## Verification Plan

### Automated Tests
- No automated tests exist. Manual verification:
  1. Open the sidebar
  2. Verify status appears
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Open the sidebar', 'Verify status appears']);
        });

        test('parses checkbox items under "Manual verification steps:" in "## Verification Plan" (Pattern 3)', () => {
            const content = `
## Verification Plan

### Automated Tests
- No automated tests exist. Manual verification steps:
  - [ ] Toggle on/off still works
  - [x] Setting value persists
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Toggle on/off still works', 'Setting value persists']);
        });
    });

    suite('refreshWithData', () => {
        test('filters out active ghost plans but preserves all completed plans', async () => {
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
            
            assert.strictEqual(cards.length, 3, 'Should have 3 cards (active-1, comp-1, and comp-2)');
            assert.ok(cards.find((c: any) => c.planId === 'active-1'), 'Should contain active-1');
            assert.ok(cards.find((c: any) => c.planId === 'comp-1'), 'Should contain comp-1');
            assert.ok(cards.find((c: any) => c.planId === 'comp-2'), 'Should contain comp-2 (even though file does not exist)');
            assert.ok(!cards.find((c: any) => c.planId === 'active-2'), 'Should NOT contain active-2');
        });
    });

    suite('_getWorkspaceItems', () => {
        let getConfigurationStub: sinon.SinonStub;
        let getWorkspaceRootsStub: sinon.SinonStub;

        setup(() => {
            getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getWorkspaceRootsStub = sandbox.stub(provider as any, '_getWorkspaceRoots');
        });
    });

    suite('selectWorkspace filter reset', () => {
        test('clears projectFilter when switching workspaces via handleMessage', async () => {
            const provider = new KanbanProvider(vscode.Uri.file('/test'), mockContext);
            sandbox.stub(provider as any, 'setCurrentWorkspaceRoot').returns(true);
            sandbox.stub(provider as any, '_setupSessionWatcher').returns(undefined);
            sandbox.stub(provider as any, '_refreshBoard').resolves();

            // Set a project filter in workspace A
            provider.setProjectFilter('Project A');
            assert.strictEqual(provider.getProjectFilter(), 'Project A');

            // Simulate workspace switch message
            await (provider as any)._handleMessage({
                type: 'selectWorkspace',
                workspaceRoot: '/path/to/workspaceB'
            });

            // Verify filter is cleared to unassigned sentinel
            assert.strictEqual(provider.getProjectFilter(), KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        });

        test('setProjectFilter handler falls back to UNASSIGNED_PROJECT_FILTER when project is null', async () => {
            const provider = new KanbanProvider(vscode.Uri.file('/test'), mockContext);
            (provider as any)._currentWorkspaceRoot = '/test/workspace';
            sandbox.stub(provider as any, '_refreshBoard').resolves();

            await (provider as any)._handleMessage({
                type: 'setProjectFilter',
                project: null
            });

            assert.strictEqual(provider.getProjectFilter(), KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        });

        test('deleteProject handler resets filter to UNASSIGNED_PROJECT_FILTER when active project is deleted', async () => {
            const provider = new KanbanProvider(vscode.Uri.file('/test'), mockContext);
            (provider as any)._currentWorkspaceRoot = '/test/workspace';
            sandbox.stub(provider as any, '_readWorkspaceId').resolves('ws-id');
            const mockDb = {
                deleteProject: sandbox.stub().resolves(),
            };
            sandbox.stub(provider as any, '_getKanbanDb').returns(mockDb);
            sandbox.stub(provider as any, '_refreshBoard').resolves();

            provider.setProjectFilter('DeletedProject');
            assert.strictEqual(provider.getProjectFilter(), 'DeletedProject');

            await (provider as any)._handleMessage({
                type: 'deleteProject',
                workspaceRoot: '/test/workspace',
                projectName: 'DeletedProject'
            });

            assert.strictEqual(provider.getProjectFilter(), KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        });
    });

    suite('resolveWorkspaceRoot auto-switch bug', () => {
        test('should not auto-switch currentWorkspaceRoot when resolving a different workspace', () => {
            const allowedRoots = new Set(['/workspace1', '/workspace2']);
            sandbox.stub(provider as any, '_getAllowedRoots').returns(allowedRoots);

            (provider as any)._currentWorkspaceRoot = '/workspace1';

            const resolved = (provider as any)._resolveWorkspaceRoot('/workspace2');

            assert.strictEqual(resolved, '/workspace2');
            assert.strictEqual((provider as any)._currentWorkspaceRoot, '/workspace1');
        });

        test('should still resolve current workspace when no argument passed', () => {
            const allowedRoots = new Set(['/workspace1']);
            sandbox.stub(provider as any, '_getAllowedRoots').returns(allowedRoots);
            (provider as any)._currentWorkspaceRoot = '/workspace1';

            const resolved = (provider as any)._resolveWorkspaceRoot();

            assert.strictEqual(resolved, '/workspace1');
            assert.strictEqual((provider as any)._currentWorkspaceRoot, '/workspace1');
        });

        test('should auto-select first workspace when none is set and autoSelect is true', () => {
            const allowedRoots = new Set(['/workspace1', '/workspace2']);
            sandbox.stub(provider as any, '_getAllowedRoots').returns(allowedRoots);
            sandbox.stub(provider as any, '_getWorkspaceRoots').returns(['/workspace1', '/workspace2']);
            (provider as any)._currentWorkspaceRoot = null;

            const getConfigStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigStub.returns({
                get: sandbox.stub().withArgs('autoSelectFirstWorkspace', true).returns(true)
            } as any);

            const resolved = (provider as any)._resolveWorkspaceRoot();

            assert.strictEqual(resolved, '/workspace1');
            assert.strictEqual((provider as any)._currentWorkspaceRoot, '/workspace1');
        });
    });
});

