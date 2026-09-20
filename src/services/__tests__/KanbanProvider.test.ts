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
            workspaceRoot
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
        setup(() => {
            sandbox.stub(fs, 'existsSync').callsFake((p: any) => p === workspaceRoot || p.toString().startsWith(workspaceRoot));
        });

        test('researcher role calls buildKanbanBatchPrompt with deep-research directive', async () => {
            const cards = makeCards(1);
            const mockDb = {
                ensureReady: sandbox.stub().resolves(true),
                getPlanBySessionId: sandbox.stub().resolves(undefined),
                getConfig: sandbox.stub().resolves(null)
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

            assert.ok(prompt.includes('PLANS TO PROCESS:'), 'Should include plan list header for custom agent');
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
                    dragDropMode: 'cli'
                },
                {
                    id: 'CUSTOM_TEST',
                    label: 'Custom Test',
                    role: 'custom_agent_devin',
                    order: 50,
                    kind: 'custom-user',
                    source: 'custom-user',
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
            { id: 'CREATED', label: 'New', order: 0, kind: 'created', source: 'built-in', dragDropMode: 'cli' },
            { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', source: 'built-in', dragDropMode: 'cli' },
            { id: 'STAGING', label: 'Staging', order: 115, kind: 'staging', source: 'built-in', dragDropMode: 'cli' },
            { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', source: 'built-in', dragDropMode: 'cli' },
            { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', source: 'built-in', dragDropMode: 'cli' },
            { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', source: 'built-in', dragDropMode: 'cli' },
            { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', source: 'built-in', dragDropMode: 'cli' },
            { id: 'ACCEPTANCE TESTED', label: 'Completion Tested', role: 'tester', order: 350, kind: 'reviewed', source: 'built-in', dragDropMode: 'cli' },
            { id: 'TICKET UPDATER', label: 'Ticket Updater', role: 'ticket_updater', order: 9000, kind: 'reviewed', source: 'built-in', dragDropMode: 'prompt' },
            { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', source: 'built-in', dragDropMode: 'cli' }
        ];

        const stubDeps = (visibleAgents: Record<string, boolean>, acceptanceTesterActive: boolean) => {
            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_buildKanbanColumns').returns(defaultColumns);
            sandbox.stub(provider as any, '_getVisibleAgents').resolves(visibleAgents);
            sandbox.stub(provider as any, '_isAcceptanceTesterActive').resolves(acceptanceTesterActive);
        };

        test('PLAN REVIEWED -> next is LEAD CODED', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('PLAN REVIEWED', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED');
        });

        // The retired RESEARCHER column sorted at order 110, immediately after
        // PLAN REVIEWED (100). The host skipped it via visibleAgents, but the
        // webview's getNextColumn skips only ROLE-LESS columns, so a card
        // advanced out of PLAN REVIEWED landed in RESEARCHER and stopped there.
        // Asserted with researcher VISIBLE: a regression that merely re-hid the
        // column would pass the negative test above while restoring the stall.
        test('PLAN REVIEWED -> next is LEAD CODED even with researcher visible', async () => {
            stubDeps({ researcher: true, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('PLAN REVIEWED', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED');
        });

        test('no RESEARCHER column exists in the shipped catalogue', () => {
            const { DEFAULT_KANBAN_COLUMNS } = require('../agentConfig');
            assert.strictEqual(
                DEFAULT_KANBAN_COLUMNS.some((c: any) => c.id === 'RESEARCHER'), false,
                'RESEARCHER is a team seat, not a pipeline stage'
            );
        });

        test('CODE REVIEWED -> next returns null when tester inactive (skips ACCEPTANCE TESTED and COMPLETED bypass)', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CODE REVIEWED', workspaceRoot);
            assert.strictEqual(next, null);
        });

        test('CODE REVIEWED -> next goes to ACCEPTANCE TESTED when tester active and design doc configured', async () => {
            stubDeps({ researcher: false, tester: true, ticket_updater: false }, true);
            const next = await (provider as any)._getNextColumnId('CODE REVIEWED', workspaceRoot);
            assert.strictEqual(next, 'ACCEPTANCE TESTED');
        });

        test('LEAD CODED -> next exits parallel lane to CODE REVIEWED', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('LEAD CODED', workspaceRoot);
            assert.strictEqual(next, 'CODE REVIEWED');
        });

        test('CODER CODED -> next exits parallel lane to CODE REVIEWED', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CODER CODED', workspaceRoot);
            assert.strictEqual(next, 'CODE REVIEWED');
        });

        test('INTERN CODED -> next exits parallel lane to CODE REVIEWED', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('INTERN CODED', workspaceRoot);
            assert.strictEqual(next, 'CODE REVIEWED');
        });

        test('RESEARCHER -> next advances to LEAD CODED when researcher invisible', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('RESEARCHER', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED');
        });

        test('PLAN REVIEWED -> next skips STAGING (no role) to LEAD CODED', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('PLAN REVIEWED', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED', 'STAGING has no dispatch role — advance must skip it');
        });

        test('RESEARCHER -> next skips STAGING to LEAD CODED', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('RESEARCHER', workspaceRoot);
            assert.strictEqual(next, 'LEAD CODED', 'STAGING has no dispatch role — advance must skip it');
        });

        test('CREATED -> next goes to PLAN REVIEWED, not STAGING', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('CREATED', workspaceRoot);
            assert.strictEqual(next, 'PLAN REVIEWED', 'CREATED must advance to PLAN REVIEWED, skipping STAGING');
        });

        test('TICKET UPDATER -> COMPLETED (the role-less skip must not close the pipeline)', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: true }, false);
            const next = await (provider as any)._getNextColumnId('TICKET UPDATER', workspaceRoot);
            assert.strictEqual(next, 'COMPLETED',
                'COMPLETED has no role but is the terminal stage — the STAGING skip must carve it out, or nothing can ever be advanced to Completed');
        });

        test('ACCEPTANCE TESTED -> COMPLETED when the ticket updater is hidden', async () => {
            stubDeps({ researcher: false, tester: true, ticket_updater: false }, true);
            const next = await (provider as any)._getNextColumnId('ACCEPTANCE TESTED', workspaceRoot);
            assert.strictEqual(next, 'COMPLETED',
                'with TICKET UPDATER hidden the walk must still reach COMPLETED, not fall off the end');
        });

        test('Last column returns null', async () => {
            stubDeps({ researcher: false, tester: false, ticket_updater: false }, false);
            const next = await (provider as any)._getNextColumnId('COMPLETED', workspaceRoot);
            assert.strictEqual(next, null);
        });

        test('Custom role column with visibleAgents false is skipped', async () => {
            const columnsWithCustom: KanbanColumnDefinition[] = [
                ...defaultColumns.slice(0, 1),
                { id: 'CUSTOM_HIDDEN', label: 'Custom Hidden', role: 'custom_agent_devin', order: 50, kind: 'custom-user', source: 'custom-user', dragDropMode: 'prompt' },
                ...defaultColumns.slice(1)
            ];
            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_buildKanbanColumns').returns(columnsWithCustom);
            sandbox.stub(provider as any, '_getVisibleAgents').resolves({ researcher: false, custom_agent_devin: false, tester: false });
            sandbox.stub(provider as any, '_isAcceptanceTesterActive').resolves(false);
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

        test('parses direct steps under "## Verification Plan" without manual subheading (Pattern 3 default-true)', () => {
            const content = `
## Verification Plan

1. Open the app
2. Check the sidebar
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Open the app', 'Check the sidebar']);
        });

        test('parses steps under "## Verificaton Plan" with typo (Pattern 3 typo-tolerant)', () => {
            const content = `
## Verificaton Plan

1. Verify typo header works
2. Confirm steps extracted
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Verify typo header works', 'Confirm steps extracted']);
        });

        test('parses steps under "## Verificaiton Steps" with typo (Pattern 3 typo-tolerant)', () => {
            const content = `
## Verificaiton Steps

- [ ] Checkbox step one
- [x] Checkbox step two
            `;
            const steps = (provider as any)._parseVerificationSteps(content);
            assert.deepStrictEqual(steps, ['Checkbox step one', 'Checkbox step two']);
        });
    });

    suite('refreshWithData', () => {
        test('filters out active ghost plans but preserves all completed plans', async () => {
            (provider as any)._currentWorkspaceRoot = workspaceRoot;
            sandbox.stub(provider as any, 'resolveEffectiveWorkspaceRoot').callsFake((r: any) => path.resolve(r));
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

            // Stub _getKanbanDb to avoid real path validation. Must include
            // getWorkspaceId/getDataVersion/getProjects/getWorktrees so the
            // O(1) no-op early-out backstop in refreshWithData can build its
            // composite key without throwing (the backstop is a no-op on the
            // first call since _lastPushKey starts as '').
            const mockDb = {
                ensureReady: sandbox.stub().resolves(true),
                getWorkspaceId: sandbox.stub().resolves('test-workspace'),
                getDataVersion: sandbox.stub().returns(0),
                getProjects: sandbox.stub().resolves([]),
                getWorktrees: sandbox.stub().resolves([]),
                getConfig: sandbox.stub().resolves(null),
                getSubtaskCountsByFeature: sandbox.stub().resolves(new Map()),
                getFeatureWorkingStates: sandbox.stub().resolves(new Map<string, { working: boolean; blocked: boolean }>())
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
            sandbox.stub(provider as any, '_getAllWorkspaceProjects').resolves({});

            await provider.refreshWithData(activeRows, completedRows, workspaceRoot);

            // Verify updateBoard message
            const updateBoardCall = postMessageStub.getCalls().find((call: any) => {
                const msg = typeof call.args[0] === 'function' ? call.args[0](null) : call.args[0];
                return msg?.type === 'updateBoard';
            });
            assert.ok(updateBoardCall, 'Should have sent updateBoard message');
            const msg = typeof updateBoardCall.args[0] === 'function' ? updateBoardCall.args[0](null) : updateBoardCall.args[0];
            const cards = msg.cards;
            
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
            sandbox.stub(provider as any, 'setCurrentWorkspaceRoot').callsFake((wsRoot: any) => {
                (provider as any)._currentWorkspaceRoot = wsRoot;
                return true;
            });
            sandbox.stub(provider as any, '_setupSessionWatcher').returns(undefined);
            sandbox.stub(provider as any, '_refreshBoard').resolves();

            // Set a project filter in workspace A
            await provider.setProjectFilter('Project A');
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

            await provider.setProjectFilter('DeletedProject');
            assert.strictEqual(provider.getProjectFilter(), 'DeletedProject');

            await (provider as any)._handleMessage({
                type: 'deleteProject',
                workspaceRoot: '/test/workspace',
                projectName: 'DeletedProject'
            });

            assert.strictEqual(provider.getProjectFilter(), KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        });
    });

    suite('project filter persistence', () => {
        test('resolveAuthoringProject restores persisted project filter from DB config', async () => {
            const testRoot = '/test/workspace';
            const mockDb = {
                getConfig: sandbox.stub().withArgs('kanban.activeProjectFilter').resolves('MyProject')
            };
            sandbox.stub(provider as any, '_getKanbanDb').returns(mockDb);

            const project = await provider.resolveAuthoringProject(testRoot);
            assert.strictEqual(project, 'MyProject');
        });

        test('invalid persisted project filter falls back to UNASSIGNED_PROJECT_FILTER on first refresh', async () => {
            const resolvedRoot = path.resolve(workspaceRoot);

            (provider as any)._projectFilter = 'NonExistentProject';
            (provider as any)._projectFilterNeedsValidation = true;
            (provider as any)._currentWorkspaceRoot = workspaceRoot;

            const postMessageStub = sandbox.stub();
            (provider as any)._panel = {
                webview: { postMessage: postMessageStub }
            };

            const mockDb = {
                ensureReady: sandbox.stub().resolves(true),
                getProjects: sandbox.stub().resolves(['RealProject']),
                getBoardFilteredByProject: sandbox.stub().resolves([]),
                getCompletedPlans: sandbox.stub().resolves([]),
                getWorktrees: sandbox.stub().resolves([]),
                lastInitError: null
            };
            sandbox.stub(provider as any, '_getKanbanDb').returns(mockDb);
            sandbox.stub(provider as any, '_resolveWorkspaceRoot').returns(resolvedRoot);
            sandbox.stub(provider as any, '_getCustomAgents').resolves([]);
            sandbox.stub(provider as any, '_getCustomKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_buildKanbanColumns').resolves([]);
            sandbox.stub(provider as any, '_readWorkspaceId').resolves('ws-id');
            sandbox.stub(provider as any, '_getAgentNames').resolves({});
            sandbox.stub(provider as any, '_getVisibleAgents').resolves({});
            sandbox.stub(provider as any, '_filterDynamicColumns').returns([]);
            sandbox.stub(provider as any, '_columnsSignature').returns('sig');
            sandbox.stub(provider as any, '_getWorkspaceItems').returns([]);
            sandbox.stub(provider as any, '_getAllWorkspaceProjects').resolves({});
            sandbox.stub(provider as any, 'getControlPlaneSelectionStatus').returns({ mode: 'none' });

            const getConfigStub = sandbox.stub(vscode.workspace, 'getConfiguration');
            getConfigStub.returns({
                get: sandbox.stub().withArgs('kanban.completedLimit', 100).returns(100)
            } as any);

            await (provider as any)._refreshBoardImpl(workspaceRoot);

            assert.strictEqual(provider.getProjectFilter(), KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
            assert.strictEqual((provider as any)._projectFilterNeedsValidation, false);
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

    // Regression coverage for the plan "A Drag onto the Collapsed Coder Column
    // Is Refused in the Browser, and the Card Bounces Back". The bug was a
    // standalone-only gate placement, but the move-vs-dispatch invariant lives
    // in the shared _advanceCards CODED_AUTO path both hosts delegate to. These
    // tests pin that invariant: a CODED_AUTO drag MOVES the card regardless of
    // the CLI-triggers setting, and DISPATCHES only when enabled (or bypassed).
    // A backward drag (CODE REVIEWED → coder column) moves but never dispatches.
    suite('_advanceCards CODED_AUTO gate placement (plan: collapsed-coder drag)', () => {
        const workspaceRoot = '/test/workspace';
        // _advanceCards looks its card up by `(planId || sessionId)` — the same key
        // the webview builds its drop ids from — so the id handed in MUST be the
        // planId when one exists. A fixture whose planId differs from the id under
        // test finds no card, and `_isColumnBefore(target, '')` then returns false,
        // silently classifying EVERY move as forward: the backward case below would
        // pass with the direction check deleted.
        const sessionId = 'plan-1';

        // Wire the minimum surface _advanceCards touches for a CODED_AUTO move.
        // Returns the executeCommand spy so each test can assert dispatch calls.
        const wireAdvance = (cardColumn: string) => {
            (provider as any)._lastCards = [{
                planId: 'plan-1',
                sessionId,
                topic: 'Test',
                planFile: 'plan_1.md',
                column: cardColumn,
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                complexity: '5',
                workspaceRoot
            }];
            sandbox.stub(provider as any, '_filterUnknownComplexitySessions').callsFake(((ids: any) => ({ filtered: ids, skippedCount: 0 })) as any);
            const groups = new Map<'lead' | 'coder' | 'intern', string[]>([['lead', []], ['coder', [sessionId]], ['intern', []]]);
            sandbox.stub(provider as any, '_partitionByComplexityRoute').resolves(groups);
            sandbox.stub(provider as any, '_getVisibleAgents').resolves({ lead: true, coder: true, intern: true });
            sandbox.stub(provider as any, 'moveCardToColumnWithReason').resolves({ ok: true, detail: '' });
            sandbox.stub(provider as any, '_collectAllMovedSessionIds').resolves([sessionId]);
            sandbox.stub(provider as any, 'postMessage');
            sandbox.stub(provider as any, '_notifySkippedUnknownComplexity');
            (provider as any)._taskViewerProvider = { recordRunSheetForColumnMove: sandbox.stub().resolves() };
            const execStub = sandbox.stub();
            sandbox.stub(provider as any, '_seams').returns({
                commands: { executeCommand: execStub },
                ui: { showErrorMessage: sandbox.stub(), showWarningMessage: sandbox.stub(), showInformationMessage: sandbox.stub() }
            });
            return execStub;
        };

        test('boardMoveCliTriggersEnabled=false: CODED_AUTO moves the card and does NOT dispatch', async () => {
            wireAdvance('CREATED');
            (provider as any)._boardMoveCliTriggersEnabled = false;

            const result = await (provider as any)._advanceCards(workspaceRoot, [sessionId], { target: 'CODED_AUTO' });

            assert.strictEqual(result.success, true, 'should succeed (move half)');
            assert.strictEqual(result.moved.length, 1, 'card should be moved');
            assert.strictEqual(result.dispatched, false, 'must not dispatch with triggers off');
            assert.ok(result.moved[0].targetColumn !== 'CODED_AUTO', 'persisted column must be a real coder column, not the synthetic CODED_AUTO string');
        });

        test('boardMoveCliTriggersEnabled=true: CODED_AUTO moves the card AND dispatches', async () => {
            const execStub = wireAdvance('CREATED');
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._advanceCards(workspaceRoot, [sessionId], { target: 'CODED_AUTO' });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.moved.length, 1);
            assert.strictEqual(result.dispatched, true, 'forward card must dispatch with triggers on');
            assert.ok(execStub.calledWith('switchboard.triggerAgentFromKanban'), 'dispatch should go through triggerAgentFromKanban');
        });

        test('bypassTriggerGate=true dispatches even when boardMoveCliTriggersEnabled=false', async () => {
            const execStub = wireAdvance('CREATED');
            (provider as any)._boardMoveCliTriggersEnabled = false;

            const result = await (provider as any)._advanceCards(workspaceRoot, [sessionId], { target: 'CODED_AUTO', bypassTriggerGate: true });

            assert.strictEqual(result.dispatched, true, 'explicit manager command must dispatch regardless of the toggle');
            assert.ok(execStub.calledWith('switchboard.triggerAgentFromKanban'));
        });

        test('backward CODE REVIEWED → coder column moves but does NOT dispatch (triggers on)', async () => {
            const execStub = wireAdvance('CODE REVIEWED');
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._advanceCards(workspaceRoot, [sessionId], { target: 'CODED_AUTO' });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.moved.length, 1, 'backward drag must still move');
            assert.strictEqual(result.dispatched, false, 'a backward move must never dispatch');
            assert.strictEqual(execStub.callCount, 0, 'no dispatch command should fire for a backward move');
        });
    });

    suite('_advanceCards specific-target + move-only arms (plan: finish-advance-cards-extraction)', () => {
        // Characterisation for the extraction: pin landing column, dispatch-or-
        // not, and delta order for every affordance BEFORE it is rerouted
        // through _advanceCards. The dispatch-or-not assertions are the ones
        // that catch the moveCardForward trap (a naive conversion starts
        // dispatching where HEAD does not).
        const card = (id: string, column: string, complexity = '5'): KanbanCard => ({
            planId: id,
            sessionId: `session-${id}`,
            topic: `Plan ${id}`,
            planFile: `plan_${id}.md`,
            column,
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            complexity,
            workspaceRoot
        });

        // Minimum surface the specific-target branch (and the move-only arms
        // that delegate to it) touches. Returns spies for dispatch, run-sheet,
        // and the posted deltas.
        const wireMove = (cards: KanbanCard[]) => {
            (provider as any)._lastCards = cards;
            (provider as any)._currentWorkspaceRoot = workspaceRoot;
            sandbox.stub(provider as any, '_resolveWorkspaceRoot').callsFake((r?: any) => r || workspaceRoot);
            sandbox.stub(provider as any, 'moveCardToColumnWithReason').resolves({ ok: true, detail: '' });
            sandbox.stub(provider as any, 'moveCardToColumn').resolves(true);
            sandbox.stub(provider as any, '_collectAllMovedSessionIds').callsFake((_r: any, sid: any) => Promise.resolve([sid]));
            const postMessage = sandbox.stub(provider as any, 'postMessage');
            const recordRunSheet = sandbox.stub().resolves();
            (provider as any)._taskViewerProvider = { recordRunSheetForColumnMove: recordRunSheet };
            const execStub = sandbox.stub().resolves(true);
            sandbox.stub(provider as any, '_seams').returns({
                commands: { executeCommand: execStub },
                ui: { showErrorMessage: sandbox.stub(), showWarningMessage: sandbox.stub(), showInformationMessage: sandbox.stub() }
            });
            return { execStub, recordRunSheet, postMessage };
        };

        const dispatchedWithTrigger = (execStub: sinon.SinonStub) =>
            execStub.getCalls().some(c => /trigger(Batch)?AgentFromKanban/.test(String(c.args[0])));

        test('specific target: forward move dispatches with triggers on', async () => {
            const { execStub } = wireMove([card('p1', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { target: 'CODER CODED' });

            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.moved, [{ id: 'p1', targetColumn: 'CODER CODED' }]);
            assert.strictEqual(result.dispatched, true);
            assert.ok(execStub.calledWith('switchboard.triggerAgentFromKanban', 'coder', 'p1'));
        });

        test('dispatch:false moves the card and NEVER dispatches (the moveCardForward trap)', async () => {
            const { execStub } = wireMove([card('p1', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { target: 'CODER CODED', dispatch: false });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.moved.length, 1);
            assert.strictEqual(result.dispatched, false);
            assert.ok(!dispatchedWithTrigger(execStub), 'dispatch:false must not fire a trigger command even with triggers on');
        });

        test('specific target: backward move records backward and does not dispatch', async () => {
            const { execStub, recordRunSheet } = wireMove([card('p1', 'CODE REVIEWED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { target: 'CODER CODED' });

            assert.strictEqual(result.moved.length, 1, 'backward card still moves');
            assert.strictEqual(result.dispatched, false, 'backward card must not dispatch');
            assert.ok(!dispatchedWithTrigger(execStub));
            assert.ok(recordRunSheet.calledWith('p1', 'CODER CODED', 'backward', workspaceRoot),
                'run sheet must record direction: backward');
        });

        // Direction comes from DEFAULT_KANBAN_COLUMNS' `order`, not a second
        // hand-kept list. These two pairs are exactly where the hand-kept list
        // disagreed with the real order; both were unreachable while only the
        // CODED_AUTO branch classified, and both became live when the
        // specific-target branch got its first caller.
        test('direction ranks TICKET UPDATER before COMPLETED (9000 < 9999), so the move back is backward', async () => {
            const { execStub, recordRunSheet } = wireMove([card('p1', 'COMPLETED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { target: 'TICKET UPDATER' });

            assert.strictEqual(result.moved.length, 1, 'backward card still moves');
            assert.strictEqual(result.dispatched, false,
                'COMPLETED → TICKET UPDATER is backward; ranking it forward dispatches a ticket updater on every drag back');
            assert.ok(!dispatchedWithTrigger(execStub));
            assert.ok(recordRunSheet.calledWith('p1', 'TICKET UPDATER', 'backward', workspaceRoot));
        });

        test('direction ranks PLAN REVIEWED before RESEARCHER (100 < 110), matching _getNextColumnId', async () => {
            const { recordRunSheet } = wireMove([card('p1', 'PLAN REVIEWED')]);
            (provider as any)._boardMoveCliTriggersEnabled = false;

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { target: 'RESEARCHER' });

            assert.strictEqual(result.moved.length, 1);
            assert.ok(recordRunSheet.calledWith('p1', 'RESEARCHER', 'forward', workspaceRoot),
                'PLAN REVIEWED → RESEARCHER is the advance _getNextColumnId makes; the run sheet must not call it backward');
        });

        test('target undefined resolves the next pipeline stage from sourceColumn', async () => {
            const { execStub } = wireMove([card('p1', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;
            sandbox.stub(provider as any, '_getNextColumnId').resolves('PLAN REVIEWED');

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { sourceColumn: 'CREATED' });

            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.moved, [{ id: 'p1', targetColumn: 'PLAN REVIEWED' }]);
            // PLAN REVIEWED maps to the planner role — dispatch uses it.
            assert.ok(execStub.calledWith('switchboard.triggerAgentFromKanban', 'planner', 'p1'));
        });

        test('target undefined with no next stage fails honestly', async () => {
            wireMove([card('p1', 'COMPLETED')]);
            sandbox.stub(provider as any, '_getNextColumnId').resolves(null);

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { sourceColumn: 'COMPLETED' });

            assert.strictEqual(result.success, false);
            assert.match(result.error, /No next column after 'COMPLETED'/);
        });

        test('dispatchRole option is honoured over _columnToRole (custom column)', async () => {
            const { execStub } = wireMove([card('p1', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            // 'QA LANE' has no _columnToRole mapping; the caller-resolved
            // spec.role must reach the trigger call.
            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1'], { target: 'QA LANE', dispatchRole: 'reviewer' });

            assert.strictEqual(result.dispatched, true);
            assert.ok(execStub.calledWith('switchboard.triggerAgentFromKanban', 'reviewer', 'p1'));
        });

        test('specific target: partial failure moves the rest and reports only the failed card', async () => {
            const { postMessage } = wireMove([card('p1', 'CREATED'), card('p2', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = false;
            (provider as any).moveCardToColumnWithReason.restore?.();
            sandbox.stub(provider as any, 'moveCardToColumnWithReason')
                .callsFake((_r: any, sid: any) => Promise.resolve(
                    sid === 'p2' ? { ok: false, reason: 'error', detail: 'db write failed' } : { ok: true, detail: '' }
                ));

            const result = await (provider as any)._advanceCards(workspaceRoot, ['p1', 'p2'], { target: 'CODER CODED', dispatch: false });

            assert.deepStrictEqual(result.moved, [{ id: 'p1', targetColumn: 'CODER CODED' }]);
            assert.deepStrictEqual(result.failures, [{ id: 'p2', sourceColumn: 'CREATED', reason: 'db write failed' }]);
            const failedPost = postMessage.getCalls().find(c => c.args[0]?.type === 'moveCardsFailed');
            assert.ok(failedPost, 'moveCardsFailed must be posted');
            assert.deepStrictEqual(failedPost.args[0].failures, [{ id: 'p2', sourceColumn: 'CREATED', reason: 'db write failed' }]);
        });

        test('moveCardForward arm: moves and does NOT dispatch even with triggers on', async () => {
            const { execStub, postMessage } = wireMove([card('p1', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._handleMessage({
                type: 'moveCardForward', sessionIds: ['p1'], targetColumn: 'CODER CODED', workspaceRoot
            });

            assert.strictEqual(result.success, true);
            assert.ok(!dispatchedWithTrigger(execStub), 'moveCardForward is move-only — it must never fire a trigger command');
            assert.ok(postMessage.getCalls().some(c => c.args[0]?.type === 'moveCards'), 'moveCards delta expected');
        });

        test('moveCardBackwards arm: moves and does NOT dispatch', async () => {
            const { execStub } = wireMove([card('p1', 'CODE REVIEWED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;

            const result = await (provider as any)._handleMessage({
                type: 'moveCardBackwards', sessionIds: ['p1'], targetColumn: 'CODER CODED', workspaceRoot
            });

            assert.strictEqual(result.success, true);
            assert.ok(!dispatchedWithTrigger(execStub));
        });

        test('triggerBatchAction arm: bypassTriggerGate dispatches with triggers off', async () => {
            const { execStub } = wireMove([card('p1', 'PLAN REVIEWED'), card('p2', 'PLAN REVIEWED')]);
            (provider as any)._boardMoveCliTriggersEnabled = false;
            // Feature-refusal pre-scan reads the db; give it an empty one.
            sandbox.stub(provider as any, '_getKanbanDb').returns({
                ensureReady: sandbox.stub().resolves(true),
                getPlanByPlanId: sandbox.stub().resolves(undefined),
                getPlanBySessionId: sandbox.stub().resolves(undefined)
            });
            sandbox.stub(provider as any, '_resolveKanbanDispatchSpec').resolves(null);
            sandbox.stub(provider as any, '_scheduleBoardRefresh');

            const result = await (provider as any)._handleMessage({
                type: 'triggerBatchAction', sessionIds: ['p1', 'p2'], targetColumn: 'CODER CODED',
                workspaceRoot, bypassTriggerGate: true
            });

            assert.strictEqual(result.success, true);
            assert.ok(dispatchedWithTrigger(execStub), 'explicit bypass must dispatch even with triggers off');
        });

        test('moveSelected arm (PLAN REVIEWED): routes through _advanceCards CODED_AUTO', async () => {
            wireMove([card('p1', 'PLAN REVIEWED'), card('p2', 'PLAN REVIEWED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;
            sandbox.stub(provider as any, '_filterUnknownComplexitySessions').callsFake((ids: any) => ({ filtered: ids, skippedCount: 0 }));
            const advanceSpy = sandbox.spy(provider as any, '_advanceCards');
            sandbox.stub(provider as any, '_partitionByComplexityRoute').resolves(
                new Map([['lead', []], ['coder', ['p1', 'p2']], ['intern', []]])
            );
            sandbox.stub(provider as any, '_getVisibleAgents').resolves({ lead: true, coder: true, intern: true });

            const result = await (provider as any)._handleMessage({
                type: 'moveSelected', sessionIds: ['p1', 'p2'], column: 'PLAN REVIEWED', workspaceRoot
            });

            assert.strictEqual(result.success, true);
            assert.ok(advanceSpy.called, 'moveSelected complexity-route branch must delegate to _advanceCards');
            const callArgs = advanceSpy.firstCall.args[2] as any;
            assert.strictEqual(callArgs.target, 'CODED_AUTO');
        });

        test('moveAll arm (general column): routes through _advanceCards and dispatches with triggers on', async () => {
            const { execStub } = wireMove([card('p1', 'CREATED'), card('p2', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = true;
            const advanceSpy = sandbox.spy(provider as any, '_advanceCards');
            // LEAD CODED keeps this out of the planner-distribution path, which
            // owns its own fan-out and is allowlisted separately.
            sandbox.stub(provider as any, '_getNextColumnId').resolves('LEAD CODED');
            sandbox.stub(provider as any, '_resolveKanbanDispatchSpec').resolves(null);

            const result = await (provider as any)._handleMessage({
                type: 'moveAll', column: 'CREATED', workspaceRoot
            });

            assert.strictEqual(result.success, true);
            assert.ok(advanceSpy.called, 'moveAll general branch must delegate to _advanceCards');
            assert.ok(dispatchedWithTrigger(execStub), 'advance-all onto a coded column dispatches with triggers on');
        });

        test('CLI triggers off: every move affordance moves without dispatching', async () => {
            const { execStub, postMessage } = wireMove([card('p1', 'CREATED'), card('p2', 'CREATED')]);
            (provider as any)._boardMoveCliTriggersEnabled = false;
            sandbox.stub(provider as any, '_getNextColumnId').resolves('LEAD CODED');
            sandbox.stub(provider as any, '_resolveKanbanDispatchSpec').resolves(null);
            sandbox.stub(provider as any, '_getKanbanDb').returns({
                ensureReady: sandbox.stub().resolves(true),
                getPlanByPlanId: sandbox.stub().resolves(undefined),
                getPlanBySessionId: sandbox.stub().resolves(undefined)
            });
            sandbox.stub(provider as any, '_scheduleBoardRefresh');

            const fwd = await (provider as any)._handleMessage({
                type: 'moveCardForward', sessionIds: ['p1'], targetColumn: 'CODER CODED', workspaceRoot
            });
            const batch = await (provider as any)._handleMessage({
                type: 'triggerBatchAction', sessionIds: ['p1', 'p2'], targetColumn: 'CODER CODED', workspaceRoot
            });

            assert.ok(!dispatchedWithTrigger(execStub), 'no affordance may dispatch with triggers off');
            assert.strictEqual(fwd.success, true);
            // Reconciled gate: the batch arm moves the cards rather than
            // refusing the drop outright.
            assert.strictEqual(batch.success, true);
            assert.ok(postMessage.getCalls().some(c => c.args[0]?.type === 'moveCards'),
                'cards must still move with triggers off');
        });
    });
});

