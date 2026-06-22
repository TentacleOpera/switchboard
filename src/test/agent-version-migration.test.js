'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

function installVsCodeMock() {
    const originalLoad = Module._load;
    const mock = {
        window: {
            showErrorMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            withProgress: async (_options, task) => task({ report() {} })
        },
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({
                get: (_key, fallback) => fallback,
                update: async () => undefined
            })
        },
        commands: {
            executeCommand: async () => true
        },
        Uri: {
            file(value) {
                const resolved = path.resolve(value);
                return {
                    fsPath: resolved,
                    path: resolved,
                    toString() { return resolved; }
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
        mock,
        restore() { Module._load = originalLoad; }
    };
}

async function run() {
    const vscodeMock = installVsCodeMock();
    const { ControlPlaneMigrationService } = require(path.join(process.cwd(), 'out', 'services', 'ControlPlaneMigrationService.js'));

    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-agent-version-'));

    try {
        // ── Test 1: _copyDirectoryRecursive with overwriteWorkflows overwrites workflow files only ──
        {
            const sourceDir = path.join(tempRoot, 'source-1');
            const targetDir = path.join(tempRoot, 'target-1');

            // Create source: workflows/test.md and personas/coder.md
            await fs.promises.mkdir(path.join(sourceDir, 'workflows'), { recursive: true });
            await fs.promises.mkdir(path.join(sourceDir, 'personas'), { recursive: true });
            await fs.promises.writeFile(path.join(sourceDir, 'workflows', 'test.md'), '# new workflow content', 'utf8');
            await fs.promises.writeFile(path.join(sourceDir, 'personas', 'coder.md'), '# new persona content', 'utf8');

            // Create target: old versions of both files
            await fs.promises.mkdir(path.join(targetDir, 'workflows'), { recursive: true });
            await fs.promises.mkdir(path.join(targetDir, 'personas'), { recursive: true });
            await fs.promises.writeFile(path.join(targetDir, 'workflows', 'test.md'), '# OLD workflow content', 'utf8');
            await fs.promises.writeFile(path.join(targetDir, 'personas', 'coder.md'), '# OLD persona content', 'utf8');

            // Copy with overwriteWorkflows: true, overwrite: false
            await ControlPlaneMigrationService._copyDirectoryRecursive(
                sourceDir, targetDir,
                { overwrite: false, overwriteWorkflows: true }
            );

            const workflowContent = await fs.promises.readFile(path.join(targetDir, 'workflows', 'test.md'), 'utf8');
            const personaContent = await fs.promises.readFile(path.join(targetDir, 'personas', 'coder.md'), 'utf8');

            assert.strictEqual(workflowContent, '# new workflow content',
                'Workflow file should be overwritten when overwriteWorkflows is true');
            assert.strictEqual(personaContent, '# OLD persona content',
                'Non-workflow file should NOT be overwritten when overwrite is false');
        }

        // ── Test 2: _copyDirectoryRecursive without overwriteWorkflows preserves workflow files ──
        {
            const sourceDir = path.join(tempRoot, 'source-2');
            const targetDir = path.join(tempRoot, 'target-2');

            await fs.promises.mkdir(path.join(sourceDir, 'workflows'), { recursive: true });
            await fs.promises.writeFile(path.join(sourceDir, 'workflows', 'test.md'), '# new workflow', 'utf8');

            await fs.promises.mkdir(path.join(targetDir, 'workflows'), { recursive: true });
            await fs.promises.writeFile(path.join(targetDir, 'workflows', 'test.md'), '# OLD workflow', 'utf8');

            await ControlPlaneMigrationService._copyDirectoryRecursive(
                sourceDir, targetDir,
                { overwrite: false }
            );

            const content = await fs.promises.readFile(path.join(targetDir, 'workflows', 'test.md'), 'utf8');
            assert.strictEqual(content, '# OLD workflow',
                'Workflow file should NOT be overwritten when overwriteWorkflows is false/undefined');
        }

        // ── Test 3: _copyDirectoryRecursive copies new files even without overwrite ──
        {
            const sourceDir = path.join(tempRoot, 'source-3');
            const targetDir = path.join(tempRoot, 'target-3');

            await fs.promises.mkdir(path.join(sourceDir, 'workflows'), { recursive: true });
            await fs.promises.writeFile(path.join(sourceDir, 'workflows', 'new-workflow.md'), '# brand new', 'utf8');

            await fs.promises.mkdir(targetDir, { recursive: true });

            await ControlPlaneMigrationService._copyDirectoryRecursive(
                sourceDir, targetDir,
                { overwrite: false }
            );

            const content = await fs.promises.readFile(path.join(targetDir, 'workflows', 'new-workflow.md'), 'utf8');
            assert.strictEqual(content, '# brand new',
                'New files should be copied even when overwrite is false');
        }

        // ── Test 4: _shouldRefreshAgentVersion returns true on version mismatch ──
        {
            const rootDir = path.join(tempRoot, 'version-test-4');
            await fs.promises.mkdir(path.join(rootDir, '.switchboard'), { recursive: true });
            // Use a version that definitely differs from the current extension version
            await fs.promises.writeFile(
                path.join(rootDir, '.switchboard', '.agent_version.json'),
                JSON.stringify({ version: '0.0.1-old', lastUpdated: '2020-01-01T00:00:00.000Z' }),
                'utf8'
            );

            const result = ControlPlaneMigrationService._shouldRefreshAgentVersion(rootDir, process.cwd());
            assert.strictEqual(result, true,
                'Should refresh when extension version differs from stored version');
        }

        // ── Test 5: _shouldRefreshAgentVersion returns false when versions match ──
        {
            const rootDir = path.join(tempRoot, 'version-test-5');
            await fs.promises.mkdir(path.join(rootDir, '.switchboard'), { recursive: true });

            // Read current extension version to write matching version
            const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
            await fs.promises.writeFile(
                path.join(rootDir, '.switchboard', '.agent_version.json'),
                JSON.stringify({ version: packageJson.version, lastUpdated: new Date().toISOString() }),
                'utf8'
            );

            const result = ControlPlaneMigrationService._shouldRefreshAgentVersion(rootDir, process.cwd());
            assert.strictEqual(result, false,
                'Should NOT refresh when extension version matches stored version');
        }

        // ── Test 6: _shouldRefreshAgentVersion returns true when no version file exists (fresh install) ──
        {
            const rootDir = path.join(tempRoot, 'version-test-6');
            await fs.promises.mkdir(path.join(rootDir, '.switchboard'), { recursive: true });
            // No .agent_version.json written

            const result = ControlPlaneMigrationService._shouldRefreshAgentVersion(rootDir, process.cwd());
            assert.strictEqual(result, true,
                'Should refresh on fresh install (no version file)');
        }

        // ── Test 7: _shouldRefreshAgentVersion returns false when extensionPath is undefined ──
        {
            const rootDir = path.join(tempRoot, 'version-test-7');
            await fs.promises.mkdir(path.join(rootDir, '.switchboard'), { recursive: true });

            const result = ControlPlaneMigrationService._shouldRefreshAgentVersion(rootDir, undefined);
            assert.strictEqual(result, false,
                'Should NOT refresh when extensionPath is undefined');
        }

        // ── Test 8: _setAgentVersion / _getLastAgentVersion round-trip ──
        {
            const rootDir = path.join(tempRoot, 'version-test-8');
            await fs.promises.mkdir(path.join(rootDir, '.switchboard'), { recursive: true });

            ControlPlaneMigrationService._setAgentVersion(rootDir, '1.6.0');
            const readBack = ControlPlaneMigrationService._getLastAgentVersion(rootDir);
            assert.strictEqual(readBack, '1.6.0',
                'Version round-trip: set then get should return same version');
        }

        // ── Test 9: _bootstrapControlPlaneLayout writes version file and overwrites workflows ──
        {
            const parentDir = path.join(tempRoot, 'bootstrap-9');
            const extPath = process.cwd(); // Use current project as extension path

            // Create old workflow file in target
            await fs.promises.mkdir(path.join(parentDir, '.agents', 'workflows'), { recursive: true });
            await fs.promises.writeFile(
                path.join(parentDir, '.agents', 'workflows', 'stale-workflow.md'),
                '# STALE workflow with deleted MCP tool reference',
                'utf8'
            );
            // Create old persona file in target
            await fs.promises.mkdir(path.join(parentDir, '.agents', 'personas'), { recursive: true });
            await fs.promises.writeFile(
                path.join(parentDir, '.agents', 'personas', 'custom-persona.md'),
                '# My custom persona',
                'utf8'
            );
            // Write old version file
            await fs.promises.mkdir(path.join(parentDir, '.switchboard'), { recursive: true });
            await fs.promises.writeFile(
                path.join(parentDir, '.switchboard', '.agent_version.json'),
                JSON.stringify({ version: '0.0.1', lastUpdated: '2020-01-01T00:00:00.000Z' }),
                'utf8'
            );

            await ControlPlaneMigrationService._bootstrapControlPlaneLayout(parentDir, extPath);

            // Verify version file was updated
            const versionData = JSON.parse(
                await fs.promises.readFile(path.join(parentDir, '.switchboard', '.agent_version.json'), 'utf8')
            );
            const packageJson = JSON.parse(fs.readFileSync(path.join(extPath, 'package.json'), 'utf8'));
            assert.strictEqual(versionData.version, packageJson.version,
                'Version file should be updated to current extension version after bootstrap');

            // Workflow files from bundled .agents/workflows/ should be overwritten
            // (if bundled workflows exist — they may not in test env, so check conditionally)
            const bundledWorkflowsDir = path.join(extPath, '.agents', 'workflows');
            if (fs.existsSync(bundledWorkflowsDir)) {
                const bundledFiles = await fs.promises.readdir(bundledWorkflowsDir);
                for (const file of bundledFiles) {
                    if (file.endsWith('.md')) {
                        const targetFile = path.join(parentDir, '.agents', 'workflows', file);
                        assert.ok(fs.existsSync(targetFile),
                            `Bundled workflow ${file} should exist after bootstrap`);
                    }
                }
            }

            // Custom persona should NOT be overwritten
            const personaContent = await fs.promises.readFile(
                path.join(parentDir, '.agents', 'personas', 'custom-persona.md'), 'utf8'
            );
            assert.strictEqual(personaContent, '# My custom persona',
                'Custom persona file should NOT be overwritten by bootstrap');
        }

        // ── Test 10: Nested workflow files are also overwritten ──
        {
            const sourceDir = path.join(tempRoot, 'source-10');
            const targetDir = path.join(tempRoot, 'target-10');

            // Create nested workflow: workflows/sub/nested.md
            await fs.promises.mkdir(path.join(sourceDir, 'workflows', 'sub'), { recursive: true });
            await fs.promises.writeFile(path.join(sourceDir, 'workflows', 'sub', 'nested.md'), '# new nested', 'utf8');

            await fs.promises.mkdir(path.join(targetDir, 'workflows', 'sub'), { recursive: true });
            await fs.promises.writeFile(path.join(targetDir, 'workflows', 'sub', 'nested.md'), '# OLD nested', 'utf8');

            await ControlPlaneMigrationService._copyDirectoryRecursive(
                sourceDir, targetDir,
                { overwrite: false, overwriteWorkflows: true }
            );

            const content = await fs.promises.readFile(path.join(targetDir, 'workflows', 'sub', 'nested.md'), 'utf8');
            assert.strictEqual(content, '# new nested',
                'Nested workflow files should also be overwritten');
        }

        // ── Test 11: Non-.md files in workflows/ are NOT overwritten ──
        {
            const sourceDir = path.join(tempRoot, 'source-11');
            const targetDir = path.join(tempRoot, 'target-11');

            await fs.promises.mkdir(path.join(sourceDir, 'workflows'), { recursive: true });
            await fs.promises.writeFile(path.join(sourceDir, 'workflows', 'config.json'), '{"new": true}', 'utf8');
            await fs.promises.writeFile(path.join(sourceDir, 'workflows', 'readme.md'), '# new readme', 'utf8');

            await fs.promises.mkdir(path.join(targetDir, 'workflows'), { recursive: true });
            await fs.promises.writeFile(path.join(targetDir, 'workflows', 'config.json'), '{"old": true}', 'utf8');
            await fs.promises.writeFile(path.join(targetDir, 'workflows', 'readme.md'), '# OLD readme', 'utf8');

            await ControlPlaneMigrationService._copyDirectoryRecursive(
                sourceDir, targetDir,
                { overwrite: false, overwriteWorkflows: true }
            );

            const jsonContent = await fs.promises.readFile(path.join(targetDir, 'workflows', 'config.json'), 'utf8');
            const mdContent = await fs.promises.readFile(path.join(targetDir, 'workflows', 'readme.md'), 'utf8');

            assert.strictEqual(jsonContent, '{"old": true}',
                'Non-.md files in workflows/ should NOT be overwritten (only .md workflow files)');
            assert.strictEqual(mdContent, '# new readme',
                '.md files in workflows/ SHOULD be overwritten');
        }

    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
        vscodeMock.restore();
    }

    console.log('agent version migration test passed');
}

run().catch((error) => {
    console.error('agent version migration test failed:', error);
    process.exit(1);
});
