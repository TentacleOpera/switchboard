import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ControlPlaneMigrationService } from '../ControlPlaneMigrationService';

suite('ControlPlaneMigrationService._discoverRepos', () => {
    let tempDir: string;

    setup(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-test-'));
    });

    teardown(async () => {
        if (fs.existsSync(tempDir)) {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('excludes planning-cache directory from discovery', async () => {
        // Create a temp structure with planning-cache subdir and a real repo
        const planningCacheDir = path.join(tempDir, 'planning-cache');
        const realRepoDir = path.join(tempDir, 'real-repo');
        
        await fs.promises.mkdir(planningCacheDir, { recursive: true });
        await fs.promises.mkdir(realRepoDir, { recursive: true });
        
        // Add a .git directory to real-repo so it gets discovered
        await fs.promises.mkdir(path.join(realRepoDir, '.git'));
        
        // Add some content to planning-cache to simulate cache files
        await fs.promises.mkdir(path.join(planningCacheDir, 'clickup'), { recursive: true });
        await fs.promises.writeFile(
            path.join(planningCacheDir, 'clickup', 'doc.md'),
            '# Test Document'
        );
        
        // Call the discovery logic through the public API
        const result = await ControlPlaneMigrationService.detectCandidateParent(realRepoDir);
        
        // Verify planning-cache is NOT in discovered repos
        const planningCacheDiscovered = result.discoveredRepos.find(
            repo => repo.repoName === 'planning-cache'
        );
        assert.strictEqual(planningCacheDiscovered, undefined, 'planning-cache should not be discovered as a repo');
        
        // Verify real-repo IS discovered
        const realRepoDiscovered = result.discoveredRepos.find(
            repo => repo.repoName === 'real-repo'
        );
        assert.ok(realRepoDiscovered, 'real-repo should be discovered');
    });

    test('excludes reserved directory when other valid repos exist', async () => {
        // Verify that SWITCHBOARD_RESERVED_DIRS exclusion works alongside valid repos
        const planningCacheDir = path.join(tempDir, 'planning-cache');
        const realRepoDir = path.join(tempDir, 'real-repo');
        
        await fs.promises.mkdir(planningCacheDir, { recursive: true });
        await fs.promises.mkdir(realRepoDir, { recursive: true });
        await fs.promises.mkdir(path.join(realRepoDir, '.git'));
        
        const result = await ControlPlaneMigrationService.detectCandidateParent(realRepoDir);
        
        const repoNames = result.discoveredRepos.map(repo => repo.repoName);
        assert.ok(!repoNames.includes('planning-cache'), 'planning-cache should be excluded');
    });

    test('still discovers regular repos alongside reserved dirs', async () => {
        const planningCacheDir = path.join(tempDir, 'planning-cache');
        const repo1Dir = path.join(tempDir, 'repo-1');
        const repo2Dir = path.join(tempDir, 'repo-2');
        
        await fs.promises.mkdir(planningCacheDir, { recursive: true });
        await fs.promises.mkdir(repo1Dir, { recursive: true });
        await fs.promises.mkdir(repo2Dir, { recursive: true });
        
        await fs.promises.mkdir(path.join(repo1Dir, '.git'));
        await fs.promises.mkdir(path.join(repo2Dir, '.git'));
        
        const result = await ControlPlaneMigrationService.detectCandidateParent(repo1Dir);
        
        const repoNames = result.discoveredRepos.map(repo => repo.repoName);
        assert.ok(repoNames.includes('repo-1'), 'repo-1 should be discovered');
        assert.ok(repoNames.includes('repo-2'), 'repo-2 should be discovered');
        assert.ok(!repoNames.includes('planning-cache'), 'planning-cache should be excluded');
    });
});
