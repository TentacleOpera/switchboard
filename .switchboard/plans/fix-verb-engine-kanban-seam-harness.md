---
description: "The shared verb-engine test harness (verbEngineTestSeams.js) declares `pathConfig` twice in one object literal — last key wins, so the first block's `workspaceRoot` field and `opts.config`-backed getters are silently dead. verb-engine-kanban-headless's getDbPath seam test has been red since it was written (00d6a94, 2026-07-16), which means the config-seam contract for kanban verbs currently has no working guard. Merge the duplicate blocks, green the test, diagnose whether _initKanbanService's seam rebuild also clobbers injected harness seams (harness-side fix only if so), and wire the now-green verb-engine contract suites into CI — they are defined in package.json but never invoked by any gate."
---

# Fix the Verb-Engine Kanban Seam Harness (and CI-Wire the Verb-Engine Suites)

## Goal

**Definition of done: `npm run test:contract:verb-engine-kanban` passes 17/17, the harness's `config` option actually reaches providers under test, and every green verb-engine contract suite is invoked by CI — not merely defined in `package.json`.**

### Core problem (root-cause analysis)

**Root cause 1 — certain, mechanical.** `src/test/helpers/verbEngineTestSeams.js` builds the seams bundle with `pathConfig` declared **twice** in the same object literal:

- First block (`:79-96`): carries `workspaceRoot` plus getters backed by **`opts.config`** and recording `updateConfigGlobal`/`updateConfigWorkspace` writers.
- Second block (`:193-202`): getters backed by **`opts.configStrings`/`configBooleans`/`configNumbers`/`configJson`**, no `workspaceRoot`, no-op writers.

JavaScript object literals resolve duplicate keys last-wins, so the first block is silently dead. Any test passing `{ config: {...} }` — as `verb-engine-kanban-headless.test.js:192` does for its `getDbPath` case — gets getters that read a different option bag, return `''`, and the arm falls to its default (`.switchboard/kanban.db` vs the expected `/custom/kanban.db`). The test has been red since the harness and test were created together in `00d6a94` (2026-07-16; the same commit era as the known five-red-tests landmark).

The cost is not one red row: **the config-seam contract for kanban verbs has no working guard**, and every future suite using `createHeadlessTestSeams({config})` inherits the same silent no-op. The harness is shared by the per-provider verb-engine suites, so the blast radius of the fix must be checked across all of them.

**Root cause 2 — resolved at plan time (2026-07-29): the clobber is unreachable in this harness.**

> **Superseded:** "plausible, must be diagnosed rather than assumed… `handleServiceVerb` triggers it on first dispatch when `_kanbanService` is unset… Sixteen of seventeen kanban harness tests pass today, so either the harness pre-empts the rebuild or most arms don't read seams the rebuilt bundle breaks — diagnose which before changing anything."
> **Reason:** The guard and the harness were both read. `handleServiceVerb` calls `_initKanbanService()` **only when `this._kanbanService` is falsy** (`KanbanProvider.ts:7210-7213`), and the kanban harness pre-assigns a real `KanbanService` with a headless ctx precisely to pre-empt it (`verb-engine-kanban-headless.test.js:104-110`; the file header says so verbatim). `_initKanbanService` (method at `:7065`; the seam rebuild at `:7073`, the empty-root clear at `:7067-7071`) therefore never executes under this harness. The 1 red test is root cause 1 alone. (The injection-contract note lives in the `_seams()` doc comment at `:7121-7127`.)
> **Replaced with:** Keep the diagnosis step as a one-run confirmation: after the merge, re-run the suite — `getDbPath` greening closes root cause 2 as "pre-empted by harness design" in the completion summary. Any residual red indicates a *third*, unknown cause — diagnose then, and any fix stays **harness-side** (never make `_initKanbanService` skip rebuilds when `_hostSeams` exists: the rebuild re-roots seams on workspace switch and ships to ~4,000 installs — byte-compat, PRD contract #2).

**Root cause 3 — gate-wiring hole (deeper than first stated).**

> **Superseded:** "`test:contract:verb-engine`, `test:contract:verb-engine-kanban`, and `test:contract:verb-engine-planning`-class scripts are defined in `package.json`"
> **Reason:** Only **two** are defined — `test:contract:verb-engine` (`package.json:813`) and `test:contract:verb-engine-kanban` (`:814`). `src/test/verb-engine-planning-headless.test.js` exists and imports the same helper but has **no npm script at all**.
> **Replaced with:** Two verb-engine scripts exist but no CI step invokes either (verified 2026-07-29: CI runs catalog/compile/parity/push-routing/verb-returns/mirror-drift, four design/scope contract suites, headless-feature-mgmt, and the integration suite). The planning suite is a step further behind: it needs a `test:contract:verb-engine-planning` script **defined** in `package.json` and then CI-wired (if green) in the same change.

A red test nobody runs stays red for six weeks; that is precisely what happened here.

## Metadata
- **Tags:** testing, bugfix, ci
- **Complexity:** 2
- **Project:** browser-switchboard

## User Review Required
- **None.**

## Scope

### ✅ IN SCOPE
1. Merge the two `pathConfig` blocks in `createHeadlessTestSeams` into one that honours **both** option bags (`opts.config` first, then the typed `configStrings`/`configBooleans`/`configNumbers`/`configJson`, then the default), restores `workspaceRoot`, and keeps the recording writers.
2. Confirm root cause 2's resolution with the merged harness (expected: pre-empted by the harness's `_kanbanService` pre-assignment — see the resolved callout above); apply a harness-side fix only if a residual red demonstrates a third cause. Record the outcome either way in the completion summary.
3. Green `verb-engine-kanban-headless.test.js` (17/17) and re-run every suite that imports the helper; fix any test that was (mis)relying on the dead-block semantics.
4. Define the missing `test:contract:verb-engine-planning` script in `package.json`, then add the green verb-engine contract suites to `.github/workflows/integration-tests.yml`.

### ⚙️ OUT OF SCOPE
- **Any change to `src/services/KanbanProvider.ts`.** The rebuild-on-init behaviour ships to ~4,000 installs and re-roots seams on workspace switch; it stays.
- Fixing other red suites that turn out to be red for unrelated reasons (the 2026-07-16 landmark noted five). Enumerate them in the completion summary; each gets its own plan if still red.
- Extending harness capabilities beyond the merge (no new seam surfaces).

## Implementation Steps

1. Run all suites importing `verbEngineTestSeams` and record the baseline (which are red, and why — one line each).
2. Merge the duplicate `pathConfig` blocks; precedence `opts.config?.[key] → opts.config<Typed>?.[key] → default`, `workspaceRoot` restored, writers recording.
3. Re-run the kanban suite — expected 17/17 (root cause 2 is pre-empted by the harness; see the resolved callout). If `getDbPath` is somehow still red, instrument which seams bundle the arm actually read; any fix stays harness-side.
4. Re-run every helper-importing suite; reconcile any newly-red test against the *intended* semantics (a test that passed only because `config` was dead is a bug in the test).
5. Define `test:contract:verb-engine-planning` in `package.json`, then add CI steps for each suite that is green at the end of step 4, in the same change.

## Proposed Changes

### `src/test/helpers/verbEngineTestSeams.js`

- **Context.** Shared harness; the duplicate key is at `:79-96` / `:193-202`.
- **Logic.** One `pathConfig`, both option-bag styles honoured, nothing else changed.
- **Edge cases.** Grep every `createHeadlessTestSeams(` call site for which option bag it passes before deciding precedence details; the merged getter must not change the observed values of currently-green tests. **Blast radius pinned 2026-07-29:** seven suites import the helper (`verb-engine-headless-seams`, `verb-engine-kanban-headless`, `verb-engine-planning-headless`, `design-asset-route-traversal`, `design-reply-addressing-regression`, `design-system-contract`, `cross-client-scope-contract`); four of them are already CI-wired and green under the current last-wins semantics. **No suite passes any typed bag** (`configStrings`/`configBooleans`/`configNumbers`/`configJson`), and only the kanban suite's `getDbPath` test passes `config` — so with precedence `opts.config[key] → typed bag → default`, every currently-green test observes identical values (both bags absent → defaults). `workspaceRoot` is declared on the seam interface (`hostSeams.ts:28`) but no arm reads `pathConfig.workspaceRoot` today — restore it for interface fidelity, not because a test depends on it.

### `.github/workflows/integration-tests.yml`

- One step per green verb-engine suite, alongside the existing contract steps. Suites left red after this plan are **not** wired (a red gate is worse than none) — they are named in the completion summary instead.

## Complexity Audit

### Routine
- The literal merge; the CI lines.

### Complex / Risky
- **Step 4 is where the surprises live:** currently-green tests may pass *because* `config` is dead. Treat every flip as a semantics question, not a fix-the-assertion chore.
- **Root cause 2's fix must stay harness-side** — the temptation to "just make the provider respect injected seams" is a shipped-behaviour change disguised as a test fix.

## Edge-Case & Dependency Audit

- **Race conditions:** none — synchronous harness construction.
- **Security:** none.
- **Side effects:** CI runtime grows by the wired suites' duration (seconds; they're plain-node).
- **Migration / shipped state:** none. Test helper + CI only.
- **Dependencies & conflicts:** serialise `.github/workflows/integration-tests.yml` edits with the destructive-paths test plan (both add steps). The helper is shared — do not land concurrently with another plan editing it.
- **No confirmation dialogs** are added.

## Dependencies

- None. Independently shippable; unblocks trustworthy verb-engine gating for every provider burndown that follows. Serialise the `.github/workflows/integration-tests.yml` edit with the sibling destructive-paths test plan (both append CI steps).

## Adversarial Synthesis

Key risks: a currently-green test silently depending on the dead first block (none found — no suite passes either option bag except the kanban `config` case, and step 4's full re-run of all seven importing suites is the guard); wiring a flaky or red suite into CI (mitigated: only suites green at the end of step 4 are wired; the rest are named in the completion summary). Root cause 2 was diagnosed at plan time as unreachable in the harness — the residual risk is a third, unknown cause surfacing after the merge, and any fix for it stays harness-side per the shipped-behaviour constraint.

## Verification Plan

### Automated Tests
1. `npm run test:contract:verb-engine-kanban` → 17/17, specifically `getDbPath reads through the HostPathConfigProvider seam` with `/custom/kanban.db` observed.
2. All other helper-importing suites at least as green as baseline (step 1's record is the comparator).
3. A new harness self-test in the kanban suite (or helper-adjacent): `createHeadlessTestSeams({ config: { k: 'v' } }).seams.pathConfig.getConfigString('k') === 'v'` and `…({ configStrings: { k: 'v' } })…` likewise — pins the merge against a future re-split.
4. CI wiring: the added step names appear in `integration-tests.yml` in the same change (gate-wiring audit criterion).

### Manual
- None required.

---

**Recommendation:** Complexity 2 → **Send to Intern.**

**Stage Complete:** CREATED
