#!/usr/bin/env node
'use strict';

/**
 * mirror:check — Dev-repo drift guard for the `.claude/skills` mirror.
 *
 * Regenerates the mirror from the committed `.agents/` source of truth into a
 * temp directory (using the same `generateClaudeMirror` the extension uses) and
 * diffs it against the committed `.claude/skills/`. Fails CI on drift so the
 * source repo can never commit a stale mirror again — the exact failure mode
 * behind the "skill fixes don't stick" bug this guard backstops.
 *
 * Run after `npm run compile-tests` (it requires out/services/ClaudeCodeMirrorService.js).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, '.agents');
const CLAUDE_SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');
const MIRROR_MODULE = path.join(REPO_ROOT, 'out', 'services', 'ClaudeCodeMirrorService.js');

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFilesRecursive(rootDir, base = '') {
    const out = [];
    if (!fs.existsSync(rootDir)) return out;
    for (const name of fs.readdirSync(rootDir)) {
        // Skip macOS Finder artifacts and other non-mirror junk so a stray
        // .DS_Store on a macOS checkout can't break CI for everyone.
        if (name === '.DS_Store' || name === 'Thumbs.db') continue;
        const abs = path.join(rootDir, name);
        const rel = base ? path.posix.join(base, name) : name;
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            out.push(...listFilesRecursive(abs, rel));
        } else if (stat.isFile()) {
            out.push(rel);
        }
    }
    return out.sort();
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dest, name);
        const stat = fs.statSync(s);
        if (stat.isDirectory()) {
            copyDir(s, d);
        } else if (stat.isFile()) {
            fs.copyFileSync(s, d);
        }
    }
}

function main() {
    if (!fs.existsSync(MIRROR_MODULE)) {
        console.error('❌ mirror:check — out/services/ClaudeCodeMirrorService.js not found. Run `npm run compile-tests` first.');
        process.exit(1);
    }
    if (!fs.existsSync(AGENTS_DIR)) {
        console.error('❌ mirror:check — repo .agents/ not found.');
        process.exit(1);
    }

    // ── Packaging-origin assertion ──────────────────────────────────────────
    // The extension reads bundled skills from <extensionUri>/.agents at runtime.
    // The VSIX ships the repo-root .agents/ (vsce includes it unless .vscodeignore
    // excludes it). A stale bundle defeats every other propagation fix silently —
    // so assert the packaging config still re-includes .agents and that .agents is
    // not gitignored (what ships == what's committed == what the mirror regenerates from).
    const vscodeignorePath = path.join(REPO_ROOT, '.vscodeignore');
    if (fs.existsSync(vscodeignorePath)) {
        const ignoreContent = fs.readFileSync(vscodeignorePath, 'utf8');
        // .agents must be re-included (a `!.agents/**` line) — otherwise the VSIX
        // ships no skills and every copy site reads an empty bundle.
        if (!/!\.agents\/\*\*/.test(ignoreContent)) {
            console.error('❌ mirror:check — .vscodeignore does NOT re-include .agents/**. The VSIX would ship no skills; propagation cannot work. Add `!.agents/**` to .vscodeignore.');
            process.exit(1);
        }
    }
    // .agents must be git-tracked (not gitignored) so the packaged tree == the
    // committed tree the mirror is regenerated from.
    try {
        const { execSync } = require('child_process');
        const checkIgnored = execSync(
            `git check-ignore .agents/skills 2>/dev/null || true`,
            { cwd: REPO_ROOT, encoding: 'utf8' }
        ).trim();
        if (checkIgnored) {
            console.error(`❌ mirror:check — .agents is gitignored ("${checkIgnored}"). The packaged .agents would diverge from the committed source the mirror regenerates from. Remove the ignore rule.`);
            process.exit(1);
        }
    } catch (e) {
        // git not available (unlikely in CI) — non-fatal, the .vscodeignore check still guards.
    }

    const { generateClaudeMirror } = require(MIRROR_MODULE);

    const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const version = packageJson.version;

    // Regenerate the mirror from .agents into a temp root so we never touch the
    // committed tree. generateClaudeMirror reads <root>/.agents and writes <root>/.claude.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-mirror-check-'));
    try {
        copyDir(AGENTS_DIR, path.join(tempRoot, '.agents'));
        const result = generateClaudeMirror(tempRoot, version);
        if (result.status === 'failed') {
            console.error(`❌ mirror:check — generateClaudeMirror failed: ${result.reason}`);
            process.exit(1);
        }

        const generatedSkillsDir = path.join(tempRoot, '.claude', 'skills');
        const generatedFiles = listFilesRecursive(generatedSkillsDir);
        const committedFiles = listFilesRecursive(CLAUDE_SKILLS_DIR);

        const generatedSet = new Set(generatedFiles);
        const committedSet = new Set(committedFiles);

        const missing = committedFiles.filter(f => !generatedSet.has(f));   // committed but not regenerated
        const extra = generatedFiles.filter(f => !committedSet.has(f));     // regenerated but not committed
        const drifted = [];
        for (const rel of generatedFiles) {
            if (!committedSet.has(rel)) continue;
            const genHash = sha256(path.join(generatedSkillsDir, rel));
            const comHash = sha256(path.join(CLAUDE_SKILLS_DIR, rel));
            if (genHash !== comHash) {
                drifted.push(rel);
            }
        }

        if (missing.length === 0 && extra.length === 0 && drifted.length === 0) {
            console.log(`✅ mirror:check — .claude/skills matches generateClaudeMirror(.agents) (${committedFiles.length} file(s), v${version}).`);
            return;
        }

        console.error('❌ mirror:check — .claude/skills drift detected. Run the extension activation (or `generateClaudeMirror` on the repo root) and commit the regenerated mirror.');
        if (missing.length) console.error(`  Missing from regenerated (committed only): \n    - ${missing.join('\n    - ')}`);
        if (extra.length) console.error(`  Extra in regenerated (not committed): \n    - ${extra.join('\n    - ')}`);
        if (drifted.length) console.error(`  Content drift: \n    - ${drifted.join('\n    - ')}`);
        process.exit(1);
    } finally {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* non-fatal */ }
    }
}

main();
