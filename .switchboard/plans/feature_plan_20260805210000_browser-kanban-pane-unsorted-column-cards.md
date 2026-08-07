# Browser Kanban Pane Renders a Column in Raw SQL Order, Not Descending Date

## Goal

Make the browser Switchboard's kanban-mode pane list a column's plans newest-first, matching the extension board's column ordering exactly.

### Problem

In the browser cockpit, a terminal pane switched to **kanban mode** shows the plans of one kanban column (column picker in the pane header). The order those rows appear in does not match the same column on the extension's kanban board — cards that are clearly older sit above newer ones, and at least one card is pinned to the top permanently.

### Root cause — two defects that compose

**1. The pane has no sort at all.** `renderKanbanPane` renders `kanbanPaneCards[index]` in whatever order the HTTP response delivered:

- `src/webview/terminals.js:2329` — `const cards = kanbanPaneCards[index] || [];`
- `src/webview/terminals.js:2357` — `for (const card of cards) { … }` — direct iteration, no comparator anywhere. `grep '\.sort('` in `terminals.js` returns exactly one hit (line 2146, the *column picker* list), so the card list is never ordered client-side.

The extension board does the opposite — it never trusts the server's order, it sorts every bucket itself:

- `src/webview/kanban.html:6366-6368` — stamps `card._ts = new Date(card.lastActivity).getTime()` (`NaN → 0`).
- `src/webview/kanban.html:6408-6417` — `sortedItems = [...items].sort(...)`: `_ts` descending, then `createdAt` descending as tiebreaker.

So the extension's order is "parsed-timestamp descending"; the pane's order is "whatever SQL returned".

**2. The SQL order is not chronological.** The pane's data comes from the `getBoardCards` verb (`src/services/KanbanProvider.ts:10370-10408`), which reads `db.getBoard(wsId)` / `db.getBoardFilteredByProject(...)`. Both end in:

```sql
ORDER BY updated_at DESC
```

(`src/services/KanbanDatabase.ts:3491` for `getBoard`, `:3999` for `getBoardFilteredByProject`)

`plans.updated_at` is a **TEXT** column and the live DB holds at least three incompatible value shapes. Measured on `.switchboard/kanban.db` (2088 rows):

| `length(updated_at)` | rows | shape | example |
|---|---|---|---|
| 24 | 1963 | ISO-8601 UTC with ms | `2026-08-05T11:33:20.599Z` |
| 19 | 124 | SQLite datetime, space separator, no zone | `2026-06-09 10:48:50` |
| 13 | 1 | **not a timestamp at all** | `reviewer-pass` |

Consequences of lexicographic `DESC` over that mix:

- `'reviewer-pass'` starts with `r` (0x72) > `'2'` (0x32), so that row sorts **first** — a card from April is permanently pinned to the top of its column in the pane. (Row `a5243677…d694`, column `COMPLETED`, `created_at` = `2026-04-12T11:54:31.353Z`.)
- For the same calendar day, `'2026-06-09 10:48:50'` sorts before `'2026-06-09T…'` because space (0x20) < `T` (0x54) — the two families interleave wrongly.
- `new Date('2026-06-09 10:48:50')` parses as **local time** while the ISO form is UTC, so the extension's client-side numeric sort and the SQL text sort place those 124 rows ~10 hours apart from each other. Same data, two different orders — which is exactly the reported symptom.

The extension board is immune to all three because it re-sorts on parsed dates and floors unparseable values to `0` (bottom). The pane inherits the raw order, so it is the only surface that shows the corruption.

### Scope decision

Fix the **read path** (client-side sort in the pane), not the stored data. Rewriting `updated_at` values would be a destructive migration over a shipped column with ~4k installs on older versions, and it is unnecessary: the extension board has proven the parse-and-sort approach works against exactly this data. The one non-timestamp value is left alone; the new comparator floors it to `0`, matching the board.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

- **Scope decision confirmation**: The plan deliberately leaves the corrupt `updated_at` values in the DB (the `reviewer-pass` row, the 124 SQLite-format rows). This is the right call — a data migration is destructive and unnecessary — but the user should be aware that the root cause (dirty data) is not being fixed, only masked at the read path. If a future plan normalizes the column, this client-side sort becomes redundant but harmless.
- **No other review gates**: The change is browser-only, single-file, and ports a proven comparator. No architectural decisions need user sign-off.

## Complexity Audit

### Routine

- Single-file client-side change plus one new test file. No DB writes, no migration, no schema change, no verb-surface change (`getBoardCards` keeps its contract).
- The comparator already exists and is battle-tested in `kanban.html:6408-6417`; this ports it, it does not invent it.
- No cross-host risk: `terminals.js` is a browser-only panel (there is no `TerminalsPanelProvider` in `src/services/`; `terminals.html` is served only through `headlessPanelHtml.ts:getTerminalsHtml`), so the change cannot regress the editor.
- `terminals.html` does not load `sharedUtils.js` (confirmed: no match in the file), so the comparator must be a **local** function in `terminals.js`, not an import. This follows the existing pattern — `terminals.js` already keeps local copies of small helpers (`scoreToCategory` at :2171, `categoryToCssClass` at :2184).

### Complex / Risky

- **The signature-gating subtlety** (the one non-obvious bit): the pane's render is signature-gated (`src/webview/terminals.js:2331-2334`). The signature is built by mapping over `cards` in order, so a pure reorder *does* change it and *does* trigger a re-render — but the signature must be computed from the **sorted** array, otherwise the first sorted render writes a signature derived from the unsorted array and the next poll tick sees a mismatch and re-renders forever (scroll position reset every 5s). Sort first, then build `bodySig`. This is the single load-bearing detail in an otherwise mechanical port.

## Edge-Case & Dependency Audit

- **Unparseable / missing `lastActivity`** — `new Date('reviewer-pass').getTime()` is `NaN`. Floor to `0` so the row sinks to the bottom, identical to `kanban.html:6367`. Do not drop the card.
- **Ties** — the 124 rows sharing `'2026-06-09 10:48:50'` all produce the same `_ts`. Apply the board's `createdAt` descending tiebreaker (`kanban.html:6411-6416`); their `created_at` values are distinct ISO strings, so the order becomes stable and meaningful rather than insertion-order.
- **`Array.prototype.sort` stability** — guaranteed stable in every browser that can run this cockpit (ES2019+), so equal-on-both-keys rows keep server order deterministically. No extra tiebreaker needed.
- **Mutation** — `kanbanPaneCards[index]` is read by `renderKanbanPane` on every 5s poll tick. Sort a copy (`[...cards]`) rather than in place; sorting the cached array in place is harmless today but couples render to cache state for no benefit.
- **`COMPLETED` column pane** — `_buildBoardCards` (`src/services/KanbanProvider.ts:1827-1860`) appends completed rows *after* active rows (line 1846: `cards.push(...completedRowsFiltered.map(...))`), so that pane's raw order is doubly arbitrary. The client sort fixes it with no special-casing.
- **Empty / not-yet-fetched states** — the `!hasFetched` and `cards.length === 0` branches (`terminals.js:2337-2354`) return before the list is built; the sort must sit after the fetch guard and before `bodySig`, so those branches are untouched.
- **Fields present on the wire** — confirmed against the live API (`POST /kanban/verb/getBoardCards` with `{"column":"CREATED"}`): every card carries both `lastActivity` and `createdAt` as ISO strings. No payload change needed. The `getBoardCards` verb uses the same `_buildBoardCards` pipeline as the board's `getFullStateMessages`, so the field shapes are identical between the two surfaces.
- **No dependency on `sharedUtils.js`** — `terminals.html` does not load it; `terminals.js` already keeps local copies of small helpers (`scoreToCategory` at :2171, `categoryToCssClass` at :2184). Follow that pattern: a local `compareCardsByRecency` next to them.
- **Not in scope:** repairing the corrupt `updated_at` values, changing `ORDER BY updated_at DESC`, or adding a sort to the server. The board and the pane will both be parse-and-sort surfaces after this change, which is the consistent contract.

## Dependencies

None. This plan is self-contained — it touches only `src/webview/terminals.js` (browser-only panel) and adds one test file. No other plan or feature blocks it, and it blocks nothing else.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) sorting after `bodySig` instead of before causes an infinite re-render loop that resets scroll every 5s — mitigated by the explicit sort-before-signature ordering in the proposed code. (2) The two comparators (board and pane) can silently diverge over time — mitigated by a source-text contract test asserting both exist and both use `lastActivity`-then-`createdAt`. (3) Line-number references in this plan will drift again as `terminals.js` evolves — mitigated by anchoring the proposed changes to identifiable code patterns (the `const cards =` line, the `scoreToCategory` function) rather than line numbers alone. No data-consistency, security, or cross-host risks.

## Proposed Changes

### `src/webview/terminals.js`

**(a) Add the comparator beside the other local card helpers (near `scoreToCategory`, line ~2171).** Same semantics as `kanban.html:6366-6417`, with the comment pointing at the source of truth so the two cannot silently diverge.

```js
    /**
     * Newest-first ordering for kanban-pane cards.
     *
     * Must match the board's column comparator (kanban.html:6408-6417): parsed
     * `lastActivity` descending, `createdAt` descending as the tiebreaker,
     * unparseable/absent timestamps floored to 0 so they sink rather than
     * jumping to the top.
     *
     * Sorting here is load-bearing, not cosmetic: the pane's cards arrive in
     * `ORDER BY updated_at DESC` order over a TEXT column that holds ISO-8601,
     * SQLite `YYYY-MM-DD HH:MM:SS`, and (in at least one shipped row) a
     * non-timestamp string. That lexicographic order is not chronological, so
     * the raw response order does NOT match the board.
     */
    function cardTimestamp(value) {
        if (!value) { return 0; }
        const t = new Date(value).getTime();
        return isNaN(t) ? 0 : t;
    }

    function compareCardsByRecency(a, b) {
        const tsDiff = cardTimestamp(b.lastActivity) - cardTimestamp(a.lastActivity);
        if (tsDiff !== 0) { return tsDiff; }
        return cardTimestamp(b.createdAt) - cardTimestamp(a.createdAt);
    }
```

**(b) Sort before building the signature (line 2329-2332).** Replace the `const cards = …` line:

```js
        // Body: plan list. Signature-gated — the 5s poll calls this on every tick, and
        // an unconditional rebuild reset the list's scroll position and wiped the
        // "Copied!" state off a button mid-timeout.
        // Sorted BEFORE the signature is built: bodySig is derived by mapping over
        // `cards` in order, so signing the unsorted array and rendering the sorted
        // one would mismatch on every poll tick and re-render forever.
        const cards = [...(kanbanPaneCards[index] || [])].sort(compareCardsByRecency);
        const hasFetched = index in kanbanPaneCards;
        const bodySig = `${chosenWs || ''} ${chosenProj || ''} ${chosen || ''} ${hasFetched ? '1' : '0'}`
            + cards.map(c => `${c.planId || c.sessionId || ''} ${c.topic || c.title || ''} ${c.complexity || ''} ${c.working ? 'w' : ''} ${c.project || ''} ${c.isFeature ? 'f' : ''}`).join('');
```

No other edit is required — the render loop at line 2357 already iterates `cards`, which is now the sorted copy.

### `src/test/browser-kanban-pane-order.test.js` (new)

Source-level contract test in the repo's existing style (the suite asserts against source text rather than booting a browser — see `browser-panel-scrollbar-contract.test.js` for the pattern):

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const TERMINALS_JS = path.join(repoRoot, 'src', 'webview', 'terminals.js');
const KANBAN_HTML = path.join(repoRoot, 'src', 'webview', 'kanban.html');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

const terminalsSrc = fs.readFileSync(TERMINALS_JS, 'utf8');
const kanbanSrc = fs.readFileSync(KANBAN_HTML, 'utf8');

test('terminals.js defines compareCardsByRecency', () => {
    assert.match(terminalsSrc, /function\s+compareCardsByRecency\s*\(/,
        'compareCardsByRecency must exist as a named function in terminals.js');
});

test('terminals.js defines cardTimestamp that floors NaN to 0', () => {
    assert.match(terminalsSrc, /function\s+cardTimestamp\s*\(/,
        'cardTimestamp helper must exist');
    assert.match(terminalsSrc, /isNaN\s*\(\s*t\s*\)\s*\?\s*0/,
        'cardTimestamp must floor NaN to 0, matching kanban.html:6367');
});

test('terminals.js sorts pane cards before building bodySig', () => {
    // The sort must be on the line that produces `cards`, before bodySig.
    assert.match(terminalsSrc, /\.sort\(compareCardsByRecency\)/,
        'cards must be sorted with compareCardsByRecency');
    // Verify the sort appears before bodySig in the source.
    const sortIdx = terminalsSrc.indexOf('.sort(compareCardsByRecency)');
    const sigIdx = terminalsSrc.indexOf('bodySig');
    assert.ok(sortIdx > -1 && sigIdx > -1 && sortIdx < sigIdx,
        'sort must appear before bodySig in source order — sorting after signature causes infinite re-render');
});

test('compareCardsByRecency uses lastActivity primary, createdAt tiebreaker', () => {
    const fnMatch = terminalsSrc.match(/function\s+compareCardsByRecency[\s\S]*?\n\s*\}/);
    assert.ok(fnMatch, 'could not extract compareCardsByRecency body');
    const body = fnMatch[0];
    assert.ok(body.includes('lastActivity'), 'comparator must use lastActivity as primary key');
    assert.ok(body.includes('createdAt'), 'comparator must use createdAt as tiebreaker');
});

test('kanban.html still carries its own comparator (parity check)', () => {
    assert.match(kanbanSrc, /sortedItems\s*=\s*\[\.\.\.items\]\.sort/,
        'kanban.html must still have its column sort — the two comparators must stay in sync');
    assert.match(kanbanSrc, /lastActivity/,
        'kanban.html comparator must still use lastActivity');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

## Verification Plan

### Automated Tests

> **Session scope note:** Compilation and automated test execution are excluded from this planning session per session directives. The test file above is a proposed deliverable for the implementer; the steps below are for the implementer to run after coding, not for this planning pass.

1. **Contract test:** `npm test -- browser-kanban-pane-order` (or the repo's full `npm test`) — new test green, no existing test red.

### Manual / UAT

2. **Data check (pre-fix, proves the premise):**
   ```
   sqlite3 .switchboard/kanban.db "SELECT length(updated_at), count(*) FROM plans GROUP BY 1;"
   sqlite3 .switchboard/kanban.db "SELECT plan_id, quote(updated_at) FROM plans WHERE updated_at NOT LIKE '2%';"
   ```
   Expect the three length families and the single `'reviewer-pass'` row. This is the input that makes SQL order ≠ date order.

3. **Server order is unsorted (pre-fix):**
   ```
   curl -s -X POST localhost:$(cat .switchboard/api-server-port.txt)/kanban/verb/getBoardCards \
     -H 'Content-Type: application/json' -d '{"column":"COMPLETED"}' \
     | python3 -c "import json,sys; [print(c['lastActivity'], c['topic'][:40]) for c in json.load(sys.stdin)['cards']]"
   ```
   Record the sequence — the `reviewer-pass` row appears first despite an April `createdAt`.

4. **UAT in the browser cockpit:** open the browser Switchboard, add a pane, switch it to kanban mode, pick `COMPLETED` (the column holding the corrupt row), and confirm:
   - rows read newest-first top-to-bottom;
   - the `reviewer-pass` card is now at the **bottom**, not the top;
   - the order matches the same column on the extension board card-for-card.

5. **No re-render loop:** leave the pane open for 30s (≥6 poll ticks). Scroll halfway down the list and confirm the scroll position is preserved and the list does not visibly rebuild. This is the regression the sort-before-signature ordering protects.

6. **Column/workspace/project switch:** change the pane's column picker, then its project picker, and confirm each new list is also newest-first (the sort runs on every render, not once at fetch).

7. **Editor untouched:** open the extension kanban board and confirm column ordering is unchanged (this change cannot reach it — `terminals.js` is browser-only — but confirm once).

## Implementation Summary

Implemented the browser kanban pane card sort in `src/webview/terminals.js`. Added `cardTimestamp` and `compareCardsByRecency` beside the existing local helpers and updated `renderKanbanPane` to sort `cards` newest-first before the body signature is built, matching the extension board's `kanban.html` comparator. Added the source contract test `src/test/browser-kanban-pane-order.test.js` to guard the comparator, sort-before-signature ordering, and board parity. The inline comment was rephrased to avoid the literal `bodySig` identifier so the contract test's first-occurrence assertion keys on the declaration. Compilation and test execution were skipped per the session directives.

## Review Findings

**Reviewer pass completed.** The implementation matches the plan: `cardTimestamp` and `compareCardsByRecency` are semantically identical to `kanban.html:6366-6417`, the sort is applied to a copy before `bodySig` (line 2565 < 2567), and the contract test passes (5/5). Regression analysis traced all callers (`renderKanbanPane` only), confirmed no cache mutation, no double-trigger, no race, and no orphaned references. **One MAJOR finding fixed:** the contract test had no `test:contract:*` script in `package.json` and no CI workflow step — the exact "green while incomplete" hole. Added `test:contract:browser-kanban-pane-order` to `package.json` and a workflow step to `integration-tests.yml`. Files changed: `package.json`, `.github/workflows/integration-tests.yml`. Verification: `npm run test:contract:browser-kanban-pane-order` passes (5/5). Remaining risk: the two comparators (board and pane) can still silently diverge — the parity test guards presence and key fields but not full semantic equivalence.
