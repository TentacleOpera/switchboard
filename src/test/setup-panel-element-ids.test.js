'use strict';

/**
 * Contract test for "Delete the Vestigial Default Prompt Overrides UI Left
 * Behind in the Setup Panel".
 *
 * The regression this locks down: commit `be89aa2a` moved Default Prompt
 * Overrides to the kanban Prompts tab and deleted Setup's entry-point markup
 * but left ~90 lines of JavaScript behind, including a bare
 * `getElementById('default-prompt-override-summary').textContent = …` that
 * threw an uncaught TypeError on every panel load (the load-time sender is
 * `TaskViewerProvider.postSetupPanelState`). The same class of leftover —
 * markup gone, JavaScript left behind — had already been hand-fixed once in
 * `kanban.html:4168`. This test makes the defect countable and non-growable
 * so the next occurrence fails on the commit that creates it.
 *
 * Two-tier policy:
 *   1. HARD FAIL — unguarded orphan. Any `getElementById('x').foo` (immediate
 *      dereference, no `?.`) for an id the markup does not define fails
 *      unconditionally. Not allowlistable. Green == "no crashing reads".
 *   2. SHRINK-ONLY — guarded orphan. A guarded read (`?.`, or captured into a
 *      const that is null-checked before use) may sit in KNOWN_ORPHANED_IDS.
 *      The set must never grow; a new orphan is a regression.
 *
 * Scanner requirements (all three load-bearing):
 *   - Skip template-literal reads: `getElementById(`${kind}-setup-status`)`
 *     resolves at runtime to real markup and is unresolvable statically.
 *   - Match `id="…"` anywhere in the file, template literals included, so ids
 *     emitted from `innerHTML` templates count as defined.
 *   - Treat a CAPTURE with no null check as unguarded, not just an immediate
 *     `.foo`. The reported crash was `const x = getElementById('gone')` on one
 *     line and `x.textContent = …` on another; a same-line-only classifier
 *     calls that "guarded" and rule 1 stops meaning anything.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const WEBVIEW_SRC = path.join(repoRoot, 'src', 'webview');
const SERVICES_SRC = path.join(repoRoot, 'src', 'services');

// KNOWN-DEAD element lookups awaiting triage: markup gone, JavaScript left
// behind. Every entry is either a feature whose UI moved (delete the code —
// see the Default Prompt Overrides removal this test shipped with) or markup
// dropped/restructured (restore or repoint the element). Shrink this list;
// never grow it. A NEW orphan is a regression, and the allowlist exists so
// that adding to it is a deliberate, reviewed act rather than an accident
// nobody sees for three months.
//
// ONLY guarded reads may appear here. An UNGUARDED orphan is an uncaught
// TypeError on a live code path and is never exemptible — see the hard-fail
// rule below.
const KNOWN_ORPHANED_IDS = new Set([
    // ── Notion Backup: singleton → per-database refactor (setup.html renders
    //    these per db via class + data-db-index). Status surface never
    //    rewired. ──
    'notion-backup-status', 'notion-backup-error', 'notion-backup-progress',
    'notion-db-url-input', 'notion-option-realtime-sync', 'notion-option-delete-sync',
    'notion-option-inbound-delete',
    // ── Board-state export row: markup absent, listeners registered ──
    'board-state-export-select', 'board-state-export-remote-url',
    'board-state-export-remote-url-row', 'board-state-export-init-git-row',
    'btn-init-control-plane-git', 'control-plane-git-init-status',
    // ── Agent-behaviour toggles: markup absent ──
    'accurate-coding-toggle', 'advanced-reviewer-toggle', 'lead-challenge-toggle',
    'jules-auto-sync-toggle',
    // ── Plan scanner ──
    'plan-scanner-switchboard',
]);

// Files to scan. Seeded with setup.html so extending the scanner to
// kanban.html (which suffered the same failure — see kanban.html:4168) is a
// one-line change later rather than a rewrite.
const FILES = ['src/webview/setup.html'];

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

/**
 * Scan HTML source for getElementById reads and id="…" definitions.
 * Returns { reads, definedIds } where reads is an array of
 * { id, line, guarded } for static (non-template-literal) reads only.
 */
function scanHtml(html) {
    const lines = html.split('\n');

    // Definitions: id="…" anywhere in the file, template literals included,
    // so ids emitted from innerHTML templates count as defined.
    const definedIds = new Set();
    const reDef = /id="([^"]+)"/g;
    let dm;
    while ((dm = reDef.exec(html)) !== null) { definedIds.add(dm[1]); }

    const reads = [];
    const reGet = /getElementById\(([^)]*)\)/g;
    // How far below a capture to look for its null check. Generous: the check
    // is idiomatically the next line, but some arms capture several elements
    // first and then guard each one.
    const GUARD_WINDOW = 20;
    lines.forEach((ln, i) => {
        reGet.lastIndex = 0;
        let m;
        while ((m = reGet.exec(ln)) !== null) {
            const arg = m[1].trim();
            // Skip template-literal reads: `${kind}-setup-status` resolves at
            // runtime to real markup and is unresolvable statically.
            if (arg.includes('${')) { continue; }
            // Only literal-string reads are statically resolvable.
            if (!(arg.startsWith("'") || arg.startsWith('"'))) { continue; }
            const id = arg.slice(1, -1);
            const callText = `getElementById(${arg})`;
            const callIdx = ln.indexOf(callText, m.index);
            const after = ln.slice(callIdx + callText.length).replace(/^\s*/, '');

            // (a) Immediate dereference on the same line. `.foo` crashes,
            //     `?.foo` does not.
            let unguarded = after.startsWith('.') && !after.startsWith('?.');
            let why = unguarded ? `immediate deref :: ${after}` : '';

            // (b) CAPTURE-then-deref — the shape that produced the reported
            //     crash and that a same-line check cannot see:
            //         const promptOverrideSummary = document.getElementById('gone');
            //         …
            //         promptOverrideSummary.textContent = '…';   // TypeError
            //     A capture whose binding is never null-checked is exactly as
            //     fatal as (a), so it must not be classifiable as "guarded" —
            //     otherwise rule 1's promise ("green == no crashing reads") is
            //     false for the one shape this test was written for.
            //     Only applies when the binding holds the ELEMENT itself. A
            //     `const v = getElementById('x')?.value || ''` binds a property
            //     that optional chaining already made safe, so it is not a
            //     capture-of-element and must not be reported.
            const bindsElement = after === '' || /^[;,)]/.test(after);
            if (!unguarded && bindsElement) {
                const capture = ln.slice(0, callIdx).match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w.$]*$/);
                if (capture) {
                    const name = capture[1];
                    const nullCheck = new RegExp(
                        `if\\s*\\(\\s*!?\\s*${name}\\b`          // if (x) / if (!x)
                        + `|!\\s*${name}\\b`                      // … && !x …
                        + `|\\b${name}\\s*(?:\\?\\.|&&|\\|\\|)`   // x?.  x &&  x ||
                        + `|\\b${name}\\s*\\?[^.]`                // x ? a : b
                    );
                    const windowText = lines.slice(i, i + GUARD_WINDOW).join('\n');
                    if (!nullCheck.test(windowText)) {
                        unguarded = true;
                        why = `captured as '${name}' and never null-checked within ${GUARD_WINDOW} lines`;
                    }
                }
            }

            reads.push({ id, line: i + 1, guarded: !unguarded, after: why || after });
        }
    });

    return { reads, definedIds };
}

function scanFile(fileRel) {
    const abs = path.join(repoRoot, fileRel);
    return { ...scanHtml(fs.readFileSync(abs, 'utf8')), abs };
}

test('The scanner itself classifies the reported crash shape as UNGUARDED', () => {
    // Self-test: rule 1 is only worth anything if the classifier recognises the
    // shape that actually crashed — a capture with no null check, dereferenced
    // further down. Verbatim from setup.html before this cleanup landed.
    const crashy = scanHtml([
        '<div id="live-one"></div>',
        "const promptOverrideSummary = document.getElementById('default-prompt-override-summary');",
        "const liveEl = document.getElementById('live-one');",
        "promptOverrideSummary.textContent = 'x';",
    ].join('\n'));
    const dead = crashy.reads.find(r => r.id === 'default-prompt-override-summary');
    assert.ok(dead, 'scanner missed the read entirely');
    assert.strictEqual(dead.guarded, false, 'capture-then-deref must classify as unguarded, not guarded');

    // …and the null-checked capture is still guarded, so the rule does not just
    // report everything.
    const safe = scanHtml([
        "const badge = document.getElementById('gone');",
        'if (badge) { badge.textContent = "x"; }',
    ].join('\n'));
    assert.strictEqual(safe.reads[0].guarded, true, 'a null-checked capture must stay guarded');
});

test('No unguarded orphans — every orphaned read is guarded (no crash candidates)', () => {
    for (const rel of FILES) {
        const { reads, definedIds } = scanFile(rel);
        const orphans = reads.filter(r => !definedIds.has(r.id));
        const unguarded = orphans.filter(r => !r.guarded);
        assert.strictEqual(
            unguarded.length, 0,
            `unguarded orphan reads in ${rel} (immediate deref of undefined id):\n` +
            unguarded.map(r => `  ${r.id} @line ${r.line} :: ${r.after}`).join('\n')
        );
    }
});

test('No un-allowlisted orphans — every orphaned read is defined or known-dead', () => {
    for (const rel of FILES) {
        const { reads, definedIds } = scanFile(rel);
        const orphans = reads.filter(r => !definedIds.has(r.id));
        const unlisted = orphans.filter(r => !KNOWN_ORPHANED_IDS.has(r.id));
        assert.strictEqual(
            unlisted.length, 0,
            `un-allowlisted orphan ids in ${rel} (add markup, delete the code, or ` +
            `deliberately add to KNOWN_ORPHANED_IDS):\n` +
            unlisted.map(r => `  ${r.id} @line ${r.line}`).join('\n')
        );
    }
});

test('The allowlist is honest — every entry is still actually orphaned', () => {
    for (const rel of FILES) {
        const { reads, definedIds } = scanFile(rel);
        const readIds = new Set(reads.map(r => r.id));
        for (const id of KNOWN_ORPHANED_IDS) {
            // An allowlisted id that is now defined in markup, or no longer
            // read at all, is stale and must be removed from the list.
            assert.ok(
                !definedIds.has(id) && readIds.has(id),
                `KNOWN_ORPHANED_IDS entry '${id}' is no longer orphaned in ${rel} ` +
                `(either markup was restored or the read was deleted) — remove it.`
            );
        }
    }
});

test('The prompts-override symbols are gone from setup.html', () => {
    const html = fs.readFileSync(path.join(WEBVIEW_SRC, 'setup.html'), 'utf8');
    const gone = [
        'updatePromptOverrideSummary', 'openCustomPromptsModal', 'closeCustomPromptsModal',
        'custom-prompts-modal', 'PROMPT_ROLES', 'promptRoleTabs',
        'default-prompt-override-summary', 'btn-cancel-prompt-overrides',
    ];
    const present = gone.filter(sym => html.includes(sym));
    assert.strictEqual(
        present.length, 0,
        'Default Prompt Overrides residue still in setup.html: ' + present.join(', ')
    );
});

test('The crash-triggering sender is gone from TaskViewerProvider', () => {
    const tv = fs.readFileSync(path.join(SERVICES_SRC, 'TaskViewerProvider.ts'), 'utf8');
    // The unsolicited push into the Setup panel must be gone. The live
    // TaskViewer arm (kanban Prompts tab) uses `this.postMessage` and must
    // stay; only the `_setupPanelProvider.postMessage` sender is dead.
    assert.ok(
        !tv.includes("_setupPanelProvider.postMessage({ type: 'defaultPromptOverrides'"),
        "TaskViewerProvider still pushes 'defaultPromptOverrides' to the setup panel"
    );
    // …but the shared implementation and the live TaskViewer arms must remain.
    assert.ok(tv.includes('handleGetDefaultPromptOverrides'), 'handleGetDefaultPromptOverrides was deleted — kanban Prompts tab depends on it');
    assert.ok(tv.includes('handleSaveDefaultPromptOverrides'), 'handleSaveDefaultPromptOverrides was deleted — kanban Prompts tab depends on it');
    assert.ok(tv.includes('handleGetDefaultPromptPreviews'), 'handleGetDefaultPromptPreviews was deleted — kanban Prompts tab depends on it');
});

test('Export/Import Prompt Settings survives (the near-miss boundary)', () => {
    const html = fs.readFileSync(path.join(WEBVIEW_SRC, 'setup.html'), 'utf8');
    for (const id of ['btn-export-prompts', 'btn-import-prompts', 'prompt-settings-status']) {
        assert.ok(
            html.includes(`id="${id}"`),
            `Export/Import Prompt Settings element '${id}' was deleted — it is a live feature, not part of Default Prompt Overrides`
        );
    }
});

test('Escape still closes a modal — keydown handler references closeControlPlaneModal', () => {
    const html = fs.readFileSync(path.join(WEBVIEW_SRC, 'setup.html'), 'utf8');
    assert.ok(
        html.includes('closeControlPlaneModal'),
        'Escape handler was deleted without repointing — the panel has no Escape-to-close'
    );
});

if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
} else {
    console.log(`\nAll ${passed} tests passed.`);
}
