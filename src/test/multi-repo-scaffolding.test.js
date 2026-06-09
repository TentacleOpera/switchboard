'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const sinon = require('sinon');

const DELETE_SUB_REPO_DB_ACTION = 'Delete sub-repo DB (Recommended)';
const KEEP_SUB_REPO_DB_ACTION = 'Keep DB and proceed';
const REOPEN_ACTION = 'Reopen in Control Plane';

function installVsCodeMock() {
    const originalLoad = Module._load;
    const mock = {
        window: {
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined
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
                    toString() {
                        return resolved;
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
        mock,
        restore() {
            Module._load = originalLoad;
        }
    };
}

function ensureCleanDir(targetDir) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
}

function createRepoFiles(targetDir, options = {}) {
    fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'README.md'), '# cloned\n', 'utf8');
    if (options.withDb) {
        const switchboardDir = path.join(targetDir, '.switchboard');
        fs.mkdirSync(switchboardDir, { recursive: true });
        fs.writeFileSync(path.join(switchboardDir, 'kanban.db'), 'db', 'utf8');
        fs.writeFileSync(path.join(switchboardDir, 'kanban.db-wal'), 'wal', 'utf8');
        fs.writeFileSync(path.join(switchboardDir, 'kanban.db-shm'), 'shm', 'utf8');
    }
}

async function cleanupWorkspace(KanbanDatabase, workspaceRoot) {
    await KanbanDatabase.invalidateWorkspace(workspaceRoot);
    await fs.promises.rm(path.dirname(workspaceRoot), { recursive: true, force: true });
}

async function testSuccessCase(MultiRepoScaffoldingService, KanbanDatabase, childProcess, mock) {
    const caseDir = path.join(process.cwd(), 'tmp', 'multi-repo-scaffolding-tests', 'success');
    const parentDir = path.join(caseDir, 'GitHub');
    const existingRepoDir = path.join(parentDir, 'service-b');
    const existingSwitchboardDir = path.join(existingRepoDir, '.switchboard');
    const existingDbPath = path.join(existingSwitchboardDir, 'kanban.db');
    const existingWalPath = path.join(existingSwitchboardDir, 'kanban.db-wal');
    const existingShmPath = path.join(existingSwitchboardDir, 'kanban.db-shm');
    ensureCleanDir(caseDir);

    fs.mkdirSync(existingSwitchboardDir, { recursive: true });
    fs.writeFileSync(path.join(existingRepoDir, 'README.md'), 'existing repo\n', 'utf8');
    fs.writeFileSync(existingDbPath, 'db', 'utf8');
    fs.writeFileSync(existingWalPath, 'wal', 'utf8');
    fs.writeFileSync(existingShmPath, 'shm', 'utf8');

    const pat = 'success-PAT-123!@#';
    const execStub = sinon.stub(childProcess, 'execFileSync').callsFake((_command, args) => {
        createRepoFiles(args[3]);
        return Buffer.from('');
    });
    const warningStub = sinon.stub(mock.window, 'showWarningMessage').resolves(DELETE_SUB_REPO_DB_ACTION);
    const informationStub = sinon.stub(mock.window, 'showInformationMessage').resolves(REOPEN_ACTION);
    const executeStub = sinon.stub(mock.commands, 'executeCommand').resolves(true);

    try {
        const result = await MultiRepoScaffoldingService.scaffold({
            parentDir,
            workspaceName: 'control-plane.code-workspace',
            repoUrls: [
                'https://github.com/example/service-a.git',
                'https://github.com/example/service-b.git'
            ],
            pat
        });

        assert.strictEqual(result.success, true, `Expected scaffold() to succeed: ${result.error || 'unknown error'}`);
        assert.ok(result.workspaceFilePath, 'Expected scaffold() to generate a workspace file.');
        assert.strictEqual(execStub.callCount, 1, 'Expected only missing repositories to be cloned.');
        assert.deepStrictEqual(execStub.firstCall.args[1].slice(0, 2), ['clone', '--'], 'Expected git clone -- to be used.');
        assert.strictEqual(execStub.firstCall.args[1][3], path.join(parentDir, 'service-a'), 'Expected git clone to target the derived folder.');
        assert.ok(String(execStub.firstCall.args[1][2]).includes('oauth2:'), 'Expected the clone URL to include injected PAT credentials.');
        assert.strictEqual(warningStub.callCount, 1, 'Expected exactly one cleanup prompt for the skipped repository DB.');

        const serializedResult = JSON.stringify(result);
        assert.ok(!serializedResult.includes(pat), 'Expected scaffold result JSON to exclude the PAT.');

        const workspaceJson = JSON.parse(await fs.promises.readFile(result.workspaceFilePath, 'utf8'));
        assert.strictEqual(workspaceJson.folders[0].path, '.', 'Expected the Control Plane parent folder to remain the first workspace root.');
        assert.match(workspaceJson.folders[0].name, /Control Plane/, 'Expected the parent root label to mention Control Plane.');
        assert.deepStrictEqual(
            workspaceJson.folders.slice(1).map((entry) => entry.path),
            ['service-a', 'service-b'],
            'Expected the workspace file to include cloned and intentionally skipped repo folders in order.'
        );
        assert.deepStrictEqual(
            Object.keys(workspaceJson.settings['files.exclude']).sort(),
            ['service-a/**', 'service-b/**'],
            'Expected files.exclude keys to match each included repo folder name.'
        );

        const skippedRepo = result.repos.find((repo) => repo.dir === 'service-b');
        assert.ok(skippedRepo, 'Expected service-b to appear in the scaffold result.');
        assert.strictEqual(skippedRepo.status, 'skipped', 'Expected existing non-empty directories to be reported as skipped.');
        assert.strictEqual(skippedRepo.cleanupAction, 'deleted', 'Expected approved DB cleanup to be recorded.');
        assert.ok(!fs.existsSync(existingDbPath), 'Expected approved cleanup to delete kanban.db.');
        assert.ok(!fs.existsSync(existingWalPath), 'Expected approved cleanup to delete kanban.db-wal.');
        assert.ok(!fs.existsSync(existingShmPath), 'Expected approved cleanup to delete kanban.db-shm.');

        assert.strictEqual(informationStub.callCount, 1, 'Expected scaffold() to offer reopening the generated workspace.');
        assert.strictEqual(executeStub.callCount, 1, 'Expected selecting the reopen action to call vscode.openFolder.');
        assert.strictEqual(executeStub.firstCall.args[0], 'vscode.openFolder', 'Expected vscode.openFolder to be used for the reopen action.');
        assert.strictEqual(executeStub.firstCall.args[1].fsPath, result.workspaceFilePath, 'Expected reopen to target the generated workspace file.');
    } finally {
        sinon.restore();
        await cleanupWorkspace(KanbanDatabase, parentDir);
    }
}

async function testSanitizedFailureCase(MultiRepoScaffoldingService, KanbanDatabase, childProcess, mock) {
    const caseDir = path.join(process.cwd(), 'tmp', 'multi-repo-scaffolding-tests', 'sanitized-failure');
    const parentDir = path.join(caseDir, 'GitHub');
    ensureCleanDir(caseDir);

    const repoUrl = 'https://github.com/example/failure.git';
    const pat = 'failure PAT !@#';
    const encodedPat = encodeURIComponent(pat);
    const authenticatedUrl = new URL(repoUrl);
    authenticatedUrl.username = 'oauth2';
    authenticatedUrl.password = pat;

    sinon.stub(mock.window, 'showInformationMessage').resolves(undefined);
    sinon.stub(childProcess, 'execFileSync').callsFake(() => {
        const error = new Error(`fatal: ${pat} ${encodedPat} ${authenticatedUrl.toString()}`);
        error.stderr = Buffer.from(`stderr: ${pat} ${encodedPat} ${authenticatedUrl.toString()}`);
        throw error;
    });

    try {
        const result = await MultiRepoScaffoldingService.scaffold({
            parentDir,
            workspaceName: 'failure',
            repoUrls: [repoUrl],
            pat
        });

        assert.strictEqual(result.success, false, 'Expected scaffold() to fail when every clone fails.');
        assert.strictEqual(result.repos.length, 1, 'Expected the failed repository to still be reported.');
        assert.strictEqual(result.repos[0].status, 'failed', 'Expected the clone failure to be recorded per repo.');

        const serializedResult = JSON.stringify(result);
        assert.ok(!serializedResult.includes(pat), 'Expected raw PAT to be scrubbed from scaffold failures.');
        assert.ok(!serializedResult.includes(encodedPat), 'Expected URL-encoded PAT to be scrubbed from scaffold failures.');
        assert.ok(!serializedResult.includes(authenticatedUrl.toString()), 'Expected authenticated clone URLs to be scrubbed from scaffold failures.');
        assert.match(result.repos[0].error, /\*\*\*/, 'Expected sanitized clone errors to replace credentials with ***.');
        assert.ok(!result.workspaceFilePath, 'Expected total failure to skip workspace file generation.');
    } finally {
        sinon.restore();
        await cleanupWorkspace(KanbanDatabase, parentDir);
    }
}

async function testConcurrentGuard(MultiRepoScaffoldingService, KanbanDatabase, childProcess, mock) {
    const caseDir = path.join(process.cwd(), 'tmp', 'multi-repo-scaffolding-tests', 'concurrency');
    const parentDir = path.join(caseDir, 'GitHub');
    ensureCleanDir(caseDir);

    sinon.stub(childProcess, 'execFileSync').callsFake((_command, args) => {
        createRepoFiles(args[3]);
        return Buffer.from('');
    });
    sinon.stub(mock.window, 'showInformationMessage').callsFake(
        () => new Promise((resolve) => setTimeout(() => resolve(undefined), 25))
    );

    try {
        const firstPromise = MultiRepoScaffoldingService.scaffold({
            parentDir,
            workspaceName: 'concurrency',
            repoUrls: ['https://github.com/example/service-a.git'],
            pat: 'pat-concurrency'
        });
        const secondResult = await MultiRepoScaffoldingService.scaffold({
            parentDir: path.join(caseDir, 'OtherParent'),
            workspaceName: 'other',
            repoUrls: ['https://github.com/example/service-b.git'],
            pat: 'pat-concurrency'
        });
        const firstResult = await firstPromise;

        assert.strictEqual(secondResult.success, false, 'Expected a concurrent scaffold request to be rejected.');
        assert.match(secondResult.error || '', /already in progress/i, 'Expected the concurrent rejection to explain the in-flight guard.');
        assert.strictEqual(firstResult.success, true, `Expected the first scaffold request to complete successfully: ${firstResult.error || 'unknown error'}`);
        assert.strictEqual(childProcess.execFileSync.callCount, 1, 'Expected the second scaffold attempt not to launch another git clone.');
    } finally {
        sinon.restore();
        await cleanupWorkspace(KanbanDatabase, parentDir);
    }
}

async function testValidationFailures(MultiRepoScaffoldingService, childProcess) {
    const caseDir = path.join(process.cwd(), 'tmp', 'multi-repo-scaffolding-tests', 'validation');
    ensureCleanDir(caseDir);

    const execStub = sinon.stub(childProcess, 'execFileSync');
    try {
        const sshResult = await MultiRepoScaffoldingService.scaffold({
            parentDir: path.join(caseDir, 'GitHub'),
            workspaceName: 'ssh-invalid',
            repoUrls: ['git@github.com:example/service-a.git'],
            pat: 'pat-validation'
        });
        assert.strictEqual(sshResult.success, false, 'Expected non-HTTPS URLs to be rejected before cloning.');
        assert.match(sshResult.error || '', /HTTPS/i, 'Expected the validation error to mention HTTPS clone URLs.');

        const collisionResult = await MultiRepoScaffoldingService.scaffold({
            parentDir: path.join(caseDir, 'GitHub'),
            workspaceName: 'collision-invalid',
            repoUrls: [
                'https://github.com/example/api.git',
                'https://github.com/example-other/api.git'
            ],
            pat: 'pat-validation'
        });
        assert.strictEqual(collisionResult.success, false, 'Expected basename collisions to be rejected before cloning.');
        assert.match(collisionResult.error || '', /same folder/i, 'Expected the collision error to mention duplicate target folders.');
        assert.strictEqual(execStub.callCount, 0, 'Expected validation failures to stop before any git clone starts.');
    } finally {
        sinon.restore();
        await fs.promises.rm(caseDir, { recursive: true, force: true });
    }
}

async function testKeepExistingDbCase(MultiRepoScaffoldingService, KanbanDatabase, childProcess, mock) {
    const caseDir = path.join(process.cwd(), 'tmp', 'multi-repo-scaffolding-tests', 'keep-db');
    const parentDir = path.join(caseDir, 'GitHub');
    const clonedRepoDir = path.join(parentDir, 'service-c');
    const clonedDbPath = path.join(clonedRepoDir, '.switchboard', 'kanban.db');
    const clonedWalPath = path.join(clonedRepoDir, '.switchboard', 'kanban.db-wal');
    const clonedShmPath = path.join(clonedRepoDir, '.switchboard', 'kanban.db-shm');
    ensureCleanDir(caseDir);

    sinon.stub(childProcess, 'execFileSync').callsFake((_command, args) => {
        createRepoFiles(args[3], { withDb: true });
        return Buffer.from('');
    });
    sinon.stub(mock.window, 'showWarningMessage').resolves(KEEP_SUB_REPO_DB_ACTION);
    sinon.stub(mock.window, 'showInformationMessage').resolves(undefined);

    try {
        const result = await MultiRepoScaffoldingService.scaffold({
            parentDir,
            workspaceName: 'keep-db',
            repoUrls: ['https://github.com/example/service-c.git'],
            pat: 'pat-keep-db'
        });

        assert.strictEqual(result.success, true, `Expected scaffold() to succeed when the user keeps an existing sub-repo DB: ${result.error || 'unknown error'}`);
        assert.strictEqual(result.repos[0].cleanupAction, 'kept', 'Expected the keep path to be recorded in the repo outcome.');
        assert.ok(fs.existsSync(clonedDbPath), 'Expected keep-with-warning to preserve kanban.db.');
        assert.ok(fs.existsSync(clonedWalPath), 'Expected keep-with-warning to preserve kanban.db-wal.');
        assert.ok(fs.existsSync(clonedShmPath), 'Expected keep-with-warning to preserve kanban.db-shm.');
        assert.ok(
            Array.isArray(result.warnings) && result.warnings.some((warning) => /Kept service-c\/\.switchboard\/kanban\.db/.test(warning)),
            'Expected keep-with-warning to add an explicit warning to the scaffold result.'
        );
    } finally {
        sinon.restore();
        await cleanupWorkspace(KanbanDatabase, parentDir);
    }
}

async function run() {
    const vscodeMock = installVsCodeMock();
    const childProcess = require('child_process');
    const { MultiRepoScaffoldingService } = require(path.join(process.cwd(), 'out', 'services', 'MultiRepoScaffoldingService.js'));
    const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
    const setupProviderSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts'),
        'utf8'
    );

    try {
        assert.match(
            setupProviderSource,
            /case 'scaffoldMultiRepo': \{[\s\S]*type: 'multiRepoScaffoldResult'/m,
            'Expected SetupPanelProvider to post multiRepoScaffoldResult from the scaffold case.'
        );
        const scaffoldCaseMatch = setupProviderSource.match(/case 'scaffoldMultiRepo': \{[\s\S]*?break;/m);
        assert.ok(scaffoldCaseMatch, 'Expected SetupPanelProvider to define a dedicated scaffoldMultiRepo case.');
        assert.doesNotMatch(
            scaffoldCaseMatch[0],
            /postSetupPanelState/,
            'Expected scaffoldMultiRepo routing to avoid persisting transient setup state.'
        );

        await testSuccessCase(MultiRepoScaffoldingService, KanbanDatabase, childProcess, vscodeMock.mock);
        await testSanitizedFailureCase(MultiRepoScaffoldingService, KanbanDatabase, childProcess, vscodeMock.mock);
        await testConcurrentGuard(MultiRepoScaffoldingService, KanbanDatabase, childProcess, vscodeMock.mock);
        await testValidationFailures(MultiRepoScaffoldingService, childProcess);
        await testKeepExistingDbCase(MultiRepoScaffoldingService, KanbanDatabase, childProcess, vscodeMock.mock);

        console.log('multi-repo scaffolding tests passed');
    } finally {
        sinon.restore();
        vscodeMock.restore();
    }
}

run().catch((error) => {
    console.error('multi-repo scaffolding tests failed:', error);
    process.exit(1);
});
