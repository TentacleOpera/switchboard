'use strict';

/**
 * Contract: worktree strategy is the USER's choice, and nothing else writes it.
 *
 * Before this contract, `feature_worktree_mode` was broadcast-only and
 * write-only-over-HTTP: no webview read it, no webview wrote it, and its only
 * live writer was `applyOversightWorktreeTopology` — machinery whose whole job
 * was to take the setting away on arm and hand it back on disarm. A crashed or
 * force-quit session left the forced `per-feature` in place with the user's real
 * value parked under `mission-control_prior_feature_worktree_mode`.
 *
 * Three properties, because deleting the forcing machinery alone satisfies none
 * of them:
 *  - the forcer is GONE, and the stash key survives in exactly one place: the
 *    one-shot drain that rescues stranded installs. A second reference is a
 *    left-behind writer.
 *  - the drain is idempotent by CONSUMING the key. A drain that restores without
 *    clearing re-runs on every activation and overwrites the user's later choice
 *    on every restart — the original defect wearing a migration's clothes.
 *  - the control EXISTS and offers exactly the two modes the verb arm accepts.
 *    A third radio ahead of its provisioning is a dead control (PRD contract #6),
 *    and a control whose checked state comes from a local click assumption rather
 *    than the broadcast lies about the state it reflects.
 *
 * Source-text throughout: `KanbanProvider.ts` imports vscode and `kanban.html` is
 * a webview document, so neither is requirable here. The one pure function is
 * extracted and executed so its mapping table is pinned behaviourally, not by
 * eyeballing a ternary.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KANBAN_PROVIDER_SRC = path.join(REPO_ROOT, 'src', 'services', 'KanbanProvider.ts');
const TASK_VIEWER_SRC = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const KANBAN_HTML = path.join(REPO_ROOT, 'src', 'webview', 'kanban.html');

const kanbanProviderSource = fs.readFileSync(KANBAN_PROVIDER_SRC, 'utf8');
const taskViewerSource = fs.readFileSync(TASK_VIEWER_SRC, 'utf8');
const kanbanHtml = fs.readFileSync(KANBAN_HTML, 'utf8');

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

/** Slice from a member declaration to the next one at the same indent. */
function memberBody(source, declaration) {
    const start = source.indexOf(declaration);
    assert.notStrictEqual(start, -1, `declaration not found: ${declaration}`);
    const after = source.slice(start);
    const next = after.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    return next === -1 ? after : after.slice(0, next + 1);
}

// ── the forcing machinery is deleted ────────────────────────────────────────

test('applyOversightWorktreeTopology is gone from both providers', () => {
    // Asserted per-file so a half-deletion (method removed, caller left) fails.
    assert.ok(
        !kanbanProviderSource.includes('applyOversightWorktreeTopology'),
        'KanbanProvider still defines the worktree topology forcer'
    );
    assert.ok(
        !taskViewerSource.includes('applyOversightWorktreeTopology'),
        'TaskViewerProvider still calls the worktree topology forcer'
    );
});

test('the permanent reconciler is gone — the drain replaced it', () => {
    assert.ok(
        !kanbanProviderSource.includes('_reconcileStaleWorktreeMode'),
        '_reconcileStaleWorktreeMode survives — once the stash key stops being written it is dead code that runs twice per workspace focus change'
    );
    const calls = kanbanProviderSource.split('_drainRetiredWorktreeModeStash(').length - 1;
    assert.strictEqual(
        calls, 3,
        `expected the drain declaration plus its two activation call sites (constructor + setCurrentWorkspaceRoot), found ${calls} reference(s)`
    );
});

test('the stash key survives in exactly one place: the drain', () => {
    const hits = kanbanProviderSource.split('mission-control_prior_feature_worktree_mode').length - 1;
    assert.strictEqual(
        hits, 1,
        `mission-control_prior_feature_worktree_mode appears ${hits} time(s) in KanbanProvider — asserted by COUNT, not presence, so a left-behind writer fails`
    );
});

test('the setFeatureWorktreeMode arm writes the mode and nothing else', () => {
    // Bounded by the NEXT case label rather than a named one — sibling arms move.
    const armStart = kanbanProviderSource.indexOf("case 'setFeatureWorktreeMode': {");
    assert.notStrictEqual(armStart, -1, 'the setFeatureWorktreeMode verb arm must still exist');
    const armRest = kanbanProviderSource.slice(armStart);
    const armEnd = armRest.slice(1).indexOf("\n            case '");
    const arm = armEnd === -1 ? armRest : armRest.slice(0, armEnd + 1);
    assert.ok(
        !arm.includes('mission-control_prior_feature_worktree_mode'),
        'the arm still clears the stashed prior — that clear defended against a restore that no longer exists, and clearing it here would consume the key before the drain can rescue a stranded install'
    );
    assert.ok(
        arm.includes("db.setConfig('feature_worktree_mode'"),
        'the arm no longer persists the mode'
    );
});

// ── the drain ───────────────────────────────────────────────────────────────

test('the drain restores, consumes the key, and re-broadcasts', () => {
    const body = memberBody(kanbanProviderSource, 'private async _drainRetiredWorktreeModeStash');
    assert.ok(
        /if \(!savedPrior\) \{ return; \}/.test(body),
        "the drain must treat a falsy prior ('' and null alike) as already-drained and return"
    );
    assert.ok(
        /setConfig\('feature_worktree_mode', normalizeFeatureWorktreeMode\(savedPrior\)\)/.test(body),
        'the drained value must be clamped through normalizeFeatureWorktreeMode — a legacy per-subtask/high-low prior would otherwise be restored verbatim'
    );
    assert.ok(
        /setConfig\(PRIOR_KEY, ''\)/.test(body),
        'the drain must CONSUME the key — the cleared key is the idempotency latch; without it the drain re-runs every activation and overwrites the user choice on every restart'
    );
    assert.ok(
        body.indexOf('_sendWorktreeConfig') > body.indexOf("setConfig(PRIOR_KEY, ''"),
        'the drain must end with _sendWorktreeConfig so a Worktrees tab opened mid-drain settles on the drained value instead of the stranded per-feature'
    );
    assert.ok(
        !/private\s+\w*[Dd]rained\b|this\._drained/.test(body),
        'no in-memory latch — the stash key is per-DB, so an in-memory flag would skip the drain for a second workspace'
    );
});

// ── the normaliser ──────────────────────────────────────────────────────────

test('normalizeFeatureWorktreeMode clamps every legacy value to none', () => {
    const match = kanbanProviderSource.match(
        /export function normalizeFeatureWorktreeMode\([^)]*\)[^{]*\{([\s\S]*?)\n\}/
    );
    assert.ok(match, 'normalizeFeatureWorktreeMode must be exported from KanbanProvider');
    const normalize = new Function('value', match[1]);
    assert.strictEqual(normalize('per-feature'), 'per-feature');
    // V53 carried epic_worktree_mode across; installs still hold these.
    for (const legacy of ['none', 'per-subtask', 'high-low', 'per-team', '', null, undefined]) {
        assert.strictEqual(
            normalize(legacy), 'none',
            `normalizeFeatureWorktreeMode(${JSON.stringify(legacy)}) must clamp to 'none'`
        );
    }
});

test('every mode read routes through the normaliser', () => {
    assert.ok(
        !/getConfig\('feature_worktree_mode'\)\)?\s*\|\|\s*'none'/.test(kanbanProviderSource),
        "a raw `getConfig('feature_worktree_mode') || 'none'` read survives — a legacy value would render no radio selection at all"
    );
    const normalized = kanbanProviderSource.split(
        "normalizeFeatureWorktreeMode(await db.getConfig('feature_worktree_mode'))"
    ).length - 1;
    assert.strictEqual(
        normalized, 2,
        `expected both reads (_sendWorktreeConfig broadcast + stageForQueue provisioning snapshot) to clamp, found ${normalized}`
    );
});

// ── the control ─────────────────────────────────────────────────────────────

const strategyBlock = (() => {
    const start = kanbanHtml.indexOf('// ── Worktree strategy');
    assert.notStrictEqual(start, -1, 'the Worktrees tab has no worktree-strategy block');
    const end = kanbanHtml.indexOf('settingsSection.appendChild(modeRow);', start);
    assert.notStrictEqual(end, -1, 'the worktree-strategy block is never appended to the settings section');
    return kanbanHtml.slice(start, end);
})();

test('the control renders exactly the two modes the verb arm accepts', () => {
    const values = [...strategyBlock.matchAll(/\{\s*value:\s*'([^']+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(
        values, ['none', 'per-feature'],
        `the radio offers ${JSON.stringify(values)} — setFeatureWorktreeMode accepts only ['none','per-feature'], so any extra option is a dead control that the arm rejects`
    );
});

test('checked state derives from the broadcast, never from a click assumption', () => {
    assert.ok(
        /config\.featureWorktreeMode/.test(strategyBlock),
        'the radio does not read featureWorktreeMode from the worktreeConfig broadcast'
    );
    assert.ok(
        /radio\.checked\s*=\s*current === opt\.value/.test(strategyBlock),
        'checked state must be recomputed from the broadcast on every render so a rejected write settles back to the true value'
    );
    assert.ok(
        /=== 'per-feature' \? 'per-feature' : 'none'/.test(strategyBlock),
        "the control must clamp on read too — a broadcast carrying a legacy value must check 'none' rather than checking nothing"
    );
});

test('selecting a mode posts the verb with mode and workspaceRoot', () => {
    assert.ok(
        /type:\s*'setFeatureWorktreeMode'/.test(strategyBlock),
        'the radio does not post setFeatureWorktreeMode'
    );
    assert.ok(
        /mode:\s*opt\.value/.test(strategyBlock) && /workspaceRoot:\s*currentWorkspaceRoot/.test(strategyBlock),
        'the posted payload must carry both mode and workspaceRoot — the arm resolves the DB from the root'
    );
});

test('no confirm gate on the control', () => {
    // Project rule, and confirm() is a silent no-op in a VS Code webview: a gate
    // here would make the radio do literally nothing. Comments are stripped first —
    // the block deliberately DOCUMENTS the prohibition, which must not trip it.
    const code = strategyBlock.replace(/\/\/[^\n]*/g, '');
    assert.ok(
        !/\bconfirm\s*\(/.test(code),
        'a confirm gate was added to the worktree-strategy control'
    );
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll worktree-strategy control contract assertions passed.');
