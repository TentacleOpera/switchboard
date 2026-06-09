'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveWorkingDir, detectWorkspaceType } = require(path.join(process.cwd(), 'out', 'services', 'agentPromptBuilder'));

// --- resolveWorkingDir tests ---

function testEmptyRepoScopeReturnsEmpty() {
    console.log('Testing resolveWorkingDir with empty repoScope...');
    assert.strictEqual(resolveWorkingDir('/workspace', ''), '', 'Empty repoScope should return empty string');
    assert.strictEqual(resolveWorkingDir('/workspace', '   '), '', 'Whitespace-only repoScope should return empty string');
    assert.strictEqual(resolveWorkingDir('/workspace', undefined), '', 'Undefined repoScope should return empty string');
    assert.strictEqual(resolveWorkingDir('/workspace', null), '', 'Null repoScope should return empty string');
    console.log('  PASS: Empty repoScope returns empty string');
}

function testValidRepoScopeResolvesToExistingDir() {
    console.log('Testing resolveWorkingDir with valid repoScope (existing directory)...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resolve-working-dir-'));
    try {
        const subDir = path.join(tmpDir, 'be');
        fs.mkdirSync(subDir);
        const result = resolveWorkingDir(tmpDir, 'be');
        assert.strictEqual(result, subDir, 'Valid repoScope should resolve to the existing subdirectory');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: Valid repoScope resolves to existing directory');
}

function testInvalidRepoScopeFallsBackToWorkspaceRoot() {
    console.log('Testing resolveWorkingDir with invalid repoScope (non-existent directory)...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resolve-working-dir-'));
    try {
        const result = resolveWorkingDir(tmpDir, 'nonexistent');
        assert.strictEqual(result, tmpDir, 'Invalid repoScope should fall back to workspaceRoot');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: Invalid repoScope falls back to workspaceRoot');
}

function testRepoScopeResolvesToFileNotDir() {
    console.log('Testing resolveWorkingDir when repoScope resolves to a file (not a directory)...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resolve-working-dir-'));
    try {
        // Create a file (not a directory) at the candidate path
        fs.writeFileSync(path.join(tmpDir, 'readme'), 'content');
        const result = resolveWorkingDir(tmpDir, 'readme');
        assert.strictEqual(result, tmpDir, 'repoScope resolving to a file should fall back to workspaceRoot');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: repoScope resolving to a file falls back to workspaceRoot');
}

function testRepoScopeWithLeadingTrailingSpaces() {
    console.log('Testing resolveWorkingDir with repoScope that has leading/trailing spaces...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resolve-working-dir-'));
    try {
        const subDir = path.join(tmpDir, 'fe');
        fs.mkdirSync(subDir);
        const result = resolveWorkingDir(tmpDir, '  fe  ');
        assert.strictEqual(result, subDir, 'repoScope with spaces should be trimmed and resolved');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: repoScope with spaces is trimmed correctly');
}

// --- detectWorkspaceType tests ---

function testSingleRepoWorkspace() {
    console.log('Testing detectWorkspaceType with single-repo workspace...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detect-workspace-'));
    try {
        // No subdirectories with project markers
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.mkdirSync(path.join(tmpDir, 'docs'));
        const result = detectWorkspaceType(tmpDir);
        assert.strictEqual(result.isMultiRepo, false, 'Workspace without project-marker subdirs should be single-repo');
        assert.deepStrictEqual(result.subRepoNames, [], 'subRepoNames should be empty for single-repo');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: Single-repo workspace detected correctly');
}

function testMultiRepoWorkspace() {
    console.log('Testing detectWorkspaceType with multi-repo workspace...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detect-workspace-'));
    try {
        // Create two subdirectories with project markers
        const beDir = path.join(tmpDir, 'be');
        const feDir = path.join(tmpDir, 'fe');
        fs.mkdirSync(beDir);
        fs.mkdirSync(feDir);
        fs.writeFileSync(path.join(beDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(feDir, 'Cargo.toml'), '');
        const result = detectWorkspaceType(tmpDir);
        assert.strictEqual(result.isMultiRepo, true, 'Workspace with 2+ project-marker subdirs should be multi-repo');
        assert.ok(result.subRepoNames.includes('be'), 'subRepoNames should include "be"');
        assert.ok(result.subRepoNames.includes('fe'), 'subRepoNames should include "fe"');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: Multi-repo workspace detected correctly');
}

function testDetectWorkspaceTypeSkipsDotAndNodeModules() {
    console.log('Testing detectWorkspaceType skips .hidden and node_modules...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detect-workspace-'));
    try {
        // Create .hidden and node_modules with project markers — should be skipped
        fs.mkdirSync(path.join(tmpDir, '.hidden'));
        fs.writeFileSync(path.join(tmpDir, '.hidden', 'package.json'), '{}');
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'package.json'), '{}');
        const result = detectWorkspaceType(tmpDir);
        assert.strictEqual(result.isMultiRepo, false, 'Dot-dirs and node_modules should not count as sub-repos');
        assert.deepStrictEqual(result.subRepoNames, [], 'subRepoNames should be empty');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('  PASS: Dot-dirs and node_modules are skipped');
}

function testDetectWorkspaceTypeWithNonExistentRoot() {
    console.log('Testing detectWorkspaceType with non-existent root...');
    const result = detectWorkspaceType('/nonexistent/path/that/does/not/exist');
    assert.strictEqual(result.isMultiRepo, false, 'Non-existent root should default to single-repo');
    assert.deepStrictEqual(result.subRepoNames, [], 'subRepoNames should be empty for non-existent root');
    console.log('  PASS: Non-existent root defaults to single-repo');
}

// --- Run all tests ---

try {
    testEmptyRepoScopeReturnsEmpty();
    testValidRepoScopeResolvesToExistingDir();
    testInvalidRepoScopeFallsBackToWorkspaceRoot();
    testRepoScopeResolvesToFileNotDir();
    testRepoScopeWithLeadingTrailingSpaces();
    testSingleRepoWorkspace();
    testMultiRepoWorkspace();
    testDetectWorkspaceTypeSkipsDotAndNodeModules();
    testDetectWorkspaceTypeWithNonExistentRoot();
    console.log('\nresolveWorkingDir & detectWorkspaceType tests PASSED!');
} catch (err) {
    console.error('\nTest FAILED:', err.message);
    process.exit(1);
}
