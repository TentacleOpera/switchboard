import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KanbanProvider } from '../services/KanbanProvider';

suite('Kanban complexity parsing', () => {
    test('treats Band B heading label with None as Low complexity', async () => {
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
});
