import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KanbanProvider } from '../services/KanbanProvider';
import { resolveRoleWithDegradation } from '../services/complexityScale';

suite('Kanban complexity parsing', () => {
    test('treats Complex heading with None as Low complexity (backward compat: Band B format)', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '',
                '## Complexity Audit',
                '',
                '### Band A (Routine)',
                '- All changes are text/element deletions in a single file.',
                '',
                '### Band B (Complex/Risky)',
                '- None.',
                '',
                '## Goal',
                '- Clarify expected outcome and scope.'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, '3');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('treats plan as Low complexity even if "Complex" is mentioned in Routine text', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '',
                '## Complexity Audit',
                '',
                '### Routine',
                '- Update terminology instead of "Complex" or "Routine".',
                '',
                '### Complex / Risky',
                '- None',
                '',
                '## Goal',
                '- Verify false positives.'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, '3');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('treats substantive Complex tasks as High complexity', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '',
                '## Complexity Audit',
                '',
                '### Routine',
                '- Update one small label.',
                '',
                '### Complex / Risky',
                '- Rework cross-module routing and database migration sequencing.',
                '',
                '## Goal',
                '- Confirm high-complexity plans still route correctly.'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, '8');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('_columnToRole maps INTERN CODED to intern', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            assert.strictEqual(provider['_columnToRole']('INTERN CODED'), 'intern');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('_columnToRole maps ACCEPTANCE TESTED to tester', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            assert.strictEqual(provider['_columnToRole']('ACCEPTANCE TESTED'), 'tester');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('treats plan with no blank lines after headings correctly as 3', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '## Complexity Audit',
                '### Routine',
                '- Simple localized change.',
                '### Complex / Risky',
                '- None'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, '3');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('treats plan with plain text under subsections correctly as 3', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '## Complexity Audit',
                '### Routine',
                'Just some minor terminology update without bullets.',
                '### Complex / Risky',
                'None'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, '3');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('treats plan with mixed bullets correctly as 3', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '## Complexity Audit',
                '### Routine',
                '* Bullet with asterisk',
                '+ Bullet with plus',
                '### Complex / Risky',
                '- None'
            ].join('\n'), 'utf8');

            const complexity = await provider.getComplexityFromPlan(tempDir, planPath);
            assert.strictEqual(complexity, '3');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('sync complexity from plan file to DB during _advanceSessionsInColumn', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-ts-'));
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        // Stub _getWorkspaceRoots to make tempDir a valid workspace root for the test
        (provider as any)._getWorkspaceRoots = () => [tempDir];

        try {
            const db = (provider as any)._getKanbanDb(tempDir);
            await db.createIfMissing();
            await db.ensureReady();
            await db.setWorkspaceId('test-ws');

            const sessionId = 'test-sync-complexity-session';
            const planPath = path.join(tempDir, 'test-plan.md');

            // 1. Create a run sheet in log (this also populates the plan in DB)
            const log = (provider as any)._getSessionLog(tempDir);
            await log.createRunSheet(sessionId, {
                sessionId,
                planFile: planPath,
                topic: 'Test Sync Plan',
                complexity: 'Unknown',
                events: []
            });

            // Write a high complexity plan file to the temp path
            await fs.promises.writeFile(planPath, [
                '# Test Plan',
                '## Complexity Audit',
                '### Routine',
                '- Done',
                '### Complex / Risky',
                '- Rework database migration sequence'
            ].join('\n'), 'utf8');

            // Before advancement, complexity in DB should be Unknown
            let plan = await db.getPlanBySessionId(sessionId);
            assert.ok(plan, 'Plan should exist in DB');
            assert.strictEqual(plan.complexity, 'Unknown');

            // 2. Advance the session from CREATED -> PLAN REVIEWED
            // This should trigger the complexity sync to DB
            const advanced = await (provider as any)._advanceSessionsInColumn([sessionId], 'CREATED', 'improve-plan', tempDir);
            // _advanceSessionsInColumn now returns {sessionId, targetColumn} pairs.
            assert.deepStrictEqual(advanced.map((p: any) => p.sessionId), [sessionId]);

            // After advancement, the DB complexity should have synced to '8'
            plan = await db.getPlanBySessionId(sessionId);
            assert.ok(plan, 'Plan should exist in DB after advancement');
            assert.strictEqual(plan.complexity, '8', 'Complexity should have been updated to 8 in the database');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('does NOT overwrite valid complexity in DB with "Unknown" if the file is unparseable or missing', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-ts-'));
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        // Stub _getWorkspaceRoots to make tempDir a valid workspace root for the test
        (provider as any)._getWorkspaceRoots = () => [tempDir];

        try {
            const db = (provider as any)._getKanbanDb(tempDir);
            await db.createIfMissing();
            await db.ensureReady();
            await db.setWorkspaceId('test-ws');

            const sessionId = 'test-no-overwrite-session';
            const planPath = path.join(tempDir, 'test-plan-missing.md');

            // 1. Create a run sheet in log (this also populates the plan in DB with complexity = '5')
            const log = (provider as any)._getSessionLog(tempDir);
            await log.createRunSheet(sessionId, {
                sessionId,
                planFile: planPath,
                topic: 'Test Sync Plan',
                complexity: '5',
                events: []
            });

            // Verify initial complexity is 5
            let plan = await db.getPlanBySessionId(sessionId);
            assert.ok(plan, 'Plan should exist in DB');
            assert.strictEqual(plan.complexity, '5');

            // 2. Advance the session. Plan file is missing, so getComplexityFromPlan will return 'Unknown'
            const advanced = await (provider as any)._advanceSessionsInColumn([sessionId], 'CREATED', 'improve-plan', tempDir);
            // _advanceSessionsInColumn now returns {sessionId, targetColumn} pairs.
            assert.deepStrictEqual(advanced.map((p: any) => p.sessionId), [sessionId]);

            // The DB complexity should STILL be 5 (not overwritten with Unknown)
            plan = await db.getPlanBySessionId(sessionId);
            assert.ok(plan, 'Plan should exist in DB after advancement');
            assert.strictEqual(plan.complexity, '5', 'Complexity should NOT have been overwritten with Unknown');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('resolveRoleWithDegradation handles all combinations and search order', () => {
        // Preferred role present in pool
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['intern', 'coder', 'lead'])), 'intern');
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['intern', 'coder', 'lead'])), 'coder');
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['intern', 'coder', 'lead'])), 'lead');

        // Empty pool
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set()), null);
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set()), null);
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set()), null);

        // Preferred=intern degradation (upward ladder: intern -> coder -> lead)
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['coder'])), 'coder');
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['lead'])), 'lead');
        assert.strictEqual(resolveRoleWithDegradation('intern', new Set(['coder', 'lead'])), 'coder');

        // Preferred=coder degradation (upward first to lead, then downward to intern)
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['lead'])), 'lead');
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['intern'])), 'intern');
        assert.strictEqual(resolveRoleWithDegradation('coder', new Set(['lead', 'intern'])), 'lead');

        // Preferred=lead degradation (downward ladder: lead -> coder -> intern)
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['coder'])), 'coder');
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['intern'])), 'intern');
        assert.strictEqual(resolveRoleWithDegradation('lead', new Set(['coder', 'intern'])), 'coder');
    });

    test('resolveAutoDispatchColumn degrades to live coding role pool', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                },
                globalState: {
                    get: (_key: string, defaultValue?: any) => defaultValue
                }
            } as unknown as vscode.ExtensionContext
        );

        try {
            (provider as any)._dynamicComplexityRoutingEnabled = true;
            (provider as any)._getWorkspaceRoots = () => [tempDir];
            (provider as any)._getVisibleAgents = async () => ({ lead: true, coder: true, intern: true });

            // Case 1: Coder only live pool -> complexity 3 (preferred intern) degrades to coder
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['coder', 'coder-1']])
            };
            let res = await provider.resolveAutoDispatchColumn(tempDir, '3');
            assert.strictEqual(res.targetColumn, 'CODER CODED');
            assert.ok(res.reason.includes('degraded intern→coder'));

            // Case 2: Lead only live pool -> complexity 3 (preferred intern) degrades to lead
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['lead', 'lead-1']])
            };
            res = await provider.resolveAutoDispatchColumn(tempDir, '3');
            assert.strictEqual(res.targetColumn, 'LEAD CODED');
            assert.ok(res.reason.includes('degraded intern→lead'));

            // Case 3: Intern only live pool -> complexity 8 (preferred lead) degrades to intern
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['intern', 'intern-1']])
            };
            res = await provider.resolveAutoDispatchColumn(tempDir, '8');
            assert.strictEqual(res.targetColumn, 'INTERN CODED');
            assert.ok(res.reason.includes('degraded lead→intern'));
            // Case 4: Unknown complexity with coder only live pool -> degrades to coder
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['coder', 'coder-1']])
            };
            res = await provider.resolveAutoDispatchColumn(tempDir, 'Unknown');
            assert.strictEqual(res.targetColumn, 'CODER CODED');
            assert.ok(res.reason.includes('degraded lead→coder'));

            // Case 5: All live roles hidden -> honestly throws KanbanDispatchError
            (provider as any)._getVisibleAgents = async () => ({ lead: true, coder: true, intern: false });
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['intern', 'intern-1']])
            };
            await assert.rejects(
                async () => provider.resolveAutoDispatchColumn(tempDir, '3'),
                (err: any) => err.name === 'KanbanDispatchError'
            );

            // Case 6: Live roles ineligible due to pair mode -> honestly throws KanbanDispatchError
            (provider as any)._getVisibleAgents = async () => ({ lead: true, coder: true, intern: true });
            (provider as any)._autobanState = { pairProgrammingMode: 'cli-ide' };
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['intern', 'intern-1']])
            };
            await assert.rejects(
                async () => provider.resolveAutoDispatchColumn(tempDir, '3'),
                (err: any) => err.name === 'KanbanDispatchError'
            );
            // Case 7: resolveRoutedRole degrades across live pool
            (provider as any)._autobanState = { pairProgrammingMode: 'off' };
            (provider as any)._taskViewerProvider = {
                getAliveCodingRolesWithTerminals: () => new Map([['coder', 'coder-1']])
            };
            assert.strictEqual(provider.resolveRoutedRole(8), 'coder', 'lead preferred degrades to coder with coder-only pool');
            assert.strictEqual(provider.resolveRoutedRole(3), 'coder', 'intern preferred degrades to coder with coder-only pool');
        } finally {
            provider.dispose();
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });
});

