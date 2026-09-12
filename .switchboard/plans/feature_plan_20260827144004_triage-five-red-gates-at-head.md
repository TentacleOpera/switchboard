# Triage five red gates at HEAD

> **RESCOPED 2026-09-12.** Gate 1 of the five is not a gate to repair — it is a gate being **deleted**. *Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets* (PLAN REVIEWED) removes `npm run mirror:check`, `generateClaudeMirror` and `scripts/check-claude-mirror.js`, and drops the CI step at `.github/workflows/integration-tests.yml:71` / `package.json:967`, replacing it in the same commit with a **drift test** asserting each `.claude/skills/<name>/SKILL.md` body matches its `.agents/` counterpart modulo frontmatter. Do not regenerate the mirror to go green. **This plan now triages four gates**; gate 1 closes when the deletion lands, and the only work left here is to confirm the drift test is green against the committed skill files.

## Goal

Five gates are red at HEAD independent of any current work and should be triaged:

1. ~~**`npm run mirror:check`**~~ — **superseded, not triaged here.** The gate is deleted with the mirror generator (see the callout above). The drift it reports on `.claude/skills/switchboard-remote/SKILL.md` stops being drift the moment that file becomes committed source rather than generated output.
2. **`test:contract:claude-protocol-block`** — packaged AGENTS.md drifted from `RESIDENT_PROTOCOL_BODY`, and "Plan Authoring" is back in the resident block.
3. **`test:contract:skill-preconditions`** — `kanban_operations` and `query-kanban` SKILL.md missing/incomplete Preconditions sections.
4. **`src/test/control-plane-migration.test.js:324`** — `importPlanFiles()` count assertion fails (expects 2, gets a different number).
5. **`src/test/control-plane-repo-scope.test.js:152`** — `getCompletedPlansFilteredByProject` assertion fails.

The first three look like fallout from commit `5cd79357` "Restore control plane to its pre-sync state" — a revert that restored old content without re-validating the contract tests that depend on it.

## Metadata

**Complexity:** 4
**Tags:** test, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- `mirror:check` needs no work: the gate is deleted with the generator, so there is nothing to regenerate and nothing to align.
- `claude-protocol-block` is a content alignment: update `RESIDENT_PROTOCOL_BODY` or the packaged AGENTS.md to match.
- `skill-preconditions` is adding missing `## Preconditions` sections to two SKILL.md files.
- The two test failures (items 4–5) require running the tests, reading the assertion failures, and fixing either the test expectations or the code.

**Complex/Risky:**
- The `5cd79357` revert may have intentionally restored old content — the fix must not re-introduce the change the revert was meant to undo. Need to understand what `5cd79357` reverted and why.
- Items 4 and 5 could be real bugs in `importPlanFiles` or `getCompletedPlansFilteredByProject`, not just stale test expectations. Must trace the code path before deciding.

## Edge-Case & Dependency Audit

- **`5cd79357` context:** The revert restored the control plane to its pre-sync state. If the contract tests were updated to expect the post-sync state, the revert would break them. The fix is either to update the tests to match the reverted state, or to re-apply the sync changes that the tests depend on.
- **`mirror:check` script:** `scripts/check-claude-mirror.js` is deleted along with the generator. Its successor drift test compares the committed `.claude/skills/<name>/SKILL.md` body against its `.agents/` counterpart modulo frontmatter — a content check with no generation step.
- **`RESIDENT_PROTOCOL_BODY`:** Defined in `ClaudeCodeMirrorService.ts`. If the packaged AGENTS.md was reverted but `RESIDENT_PROTOCOL_BODY` was not (or vice versa), they drift. Must align both.
- **"Plan Authoring" in resident block:** The AGENTS.md protocol block should not contain the "Plan Authoring & Problem Analysis Protocol" section — it was moved out. The revert may have put it back.
- **Test isolation:** Items 4–5 may share a root cause if both depend on the same import/scoping logic that the revert changed.

## Proposed Changes

### 1. ~~Fix `mirror:check`~~ — no change; the gate is deleted

Nothing to do in this plan. `npm run mirror:check` and the generator behind it are removed by
*Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets*.
**Do not regenerate the mirror** — that writes generated output over what is becoming committed
source, and re-introduces exactly the coupling the deletion removes.

After that plan lands, the only check here is that the successor drift test is green:
`.claude/skills/switchboard-remote/SKILL.md` must match `.agents/skills/switchboard-remote.md`
modulo the frontmatter block. If it does not, **edit the two files to agree** — both are source.

### 2. Fix `test:contract:claude-protocol-block`

Read `src/test/claude-protocol-block-size-contract.test.js` to understand the exact assertion. Then:
- If `RESIDENT_PROTOCOL_BODY` in `ClaudeCodeMirrorService.ts` is stale, update it to match the current AGENTS.md content.
- If the packaged AGENTS.md contains "Plan Authoring" in the resident block, move that section outside the managed block (it should be in the user-editable region, not the auto-managed resident block).
- Run `npm run test:contract:claude-protocol-block` to verify.

### 3. Fix `test:contract:skill-preconditions`

Read `src/test/skill-preconditions-contract.test.js` to understand the required schema. Then add `## Preconditions` sections to:
- `.agents/skills/kanban_operations/SKILL.md`
- `.agents/skills/query-kanban/SKILL.md` (or `.agents/skills/query-kanban-plans/SKILL.md` — verify which file the test references)

Each Preconditions section should document what must be true before the skill is invoked (e.g., "The VS Code extension must be running" for kanban_operations).

### 4. Fix `control-plane-migration.test.js:324`

Run the test to see the actual count:
```bash
node --require ./src/test/bootstrap/sandboxStateHome.js src/test/control-plane-migration.test.js
```
Read the test setup (lines 290–328) to understand what files it creates and what `importPlanFiles` is expected to discover. The assertion expects 2 plans (top-level + one-level repo-folder), ignoring runtime mirror files. If the count differs, either:
- The test's temp files are being picked up by a broader scan (fix the scan or the test setup).
- `importPlanFiles` logic changed (fix the code or update the expectation).

### 5. Fix `control-plane-repo-scope.test.js:152`

Run the test to see the actual result:
```bash
node --require ./src/test/bootstrap/sandboxStateHome.js src/test/control-plane-repo-scope.test.js
```
The assertion at line 152 expects `getCompletedPlansFilteredByProject` to return `['sess-completed-be', 'sess-completed-unscoped']` for project 'ProjA'. If the result differs, trace `getCompletedPlansFilteredByProject` in `KanbanDatabase.ts` to find the query logic discrepancy.

## Verification Plan

1. Run `npm run mirror:check` — assert it passes (exit code 0).
2. Run `npm run test:contract:claude-protocol-block` — assert it passes.
3. Run `npm run test:contract:skill-preconditions` — assert it passes.
4. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/control-plane-migration.test.js` — assert it passes.
5. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/control-plane-repo-scope.test.js` — assert it passes.
6. Run the full contract test suite to confirm no regressions: `npm run test:contract` (or the equivalent aggregate).
