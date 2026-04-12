import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KanbanProvider } from '../services/KanbanProvider';

suite('Kanban complexity parsing', () => {
    test('treats Complex heading with None as Low complexity (backward compat: Band B format)', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-'));
        const planPath = path.join(tempDir, 'plan.md');
        const provider = new KanbanProvider(
            vscode.Uri.file(tempDir),
            {
                workspaceState: {
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
            assert.strictEqual(complexity, 'Low');
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
            assert.strictEqual(complexity, 'Low');
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
            assert.strictEqual(complexity, 'High');
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
});
