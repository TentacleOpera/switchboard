# Triage three red checks at clean HEAD

## Goal

Three checks are red at clean HEAD and unrelated to any current work. Verified in a detached worktree at HEAD:

1. **`npm run mirror:check`** — `.claude/skills/switchboard-remote/SKILL.md` content drift. The checked-in mirror file doesn't match what `generateClaudeMirror` would produce from the current `.agents/` source.

2. **`npm run test:contract:staging-column`** — "the autoban schedule run sheet pops STAGING and nothing else" assertion fails. The staging column contract test expects that an autoban schedule run sheet moves cards to STAGING and only STAGING, but something is popping additional columns or not respecting the STAGING-only scope.

3. **One case in `feature-file-subtask-link-contract`** — "an unresolvable planId aborts instead of writing guessed links" assertion fails. The contract test expects that when a planId in a feature file's subtask list cannot be resolved, the link-writing process aborts cleanly rather than writing guessed/placeholder links. The current behavior writes guessed links instead of aborting.

**Root cause:** These are pre-existing failures at clean HEAD, independent of any current branch work. They may be fallout from an earlier merge, a stale checked-in file, or a code change that broke a contract without updating the test.

## Metadata

**Complexity:** 4
**Tags:** test, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- `mirror:check` is a content regeneration or source fix — run the checker, identify the drift, fix the source or regenerate the mirror.
- `staging-column` is a contract test — run it, read the assertion, trace the code path, fix the code or update the test.
- `feature-file-subtask-link` is a contract test — run it, read the assertion, trace the link-writing code, fix the code or update the test.

**Complex/Risky:**
- Each failure could be a real bug (code broke the contract) or a stale test (the contract changed but the test wasn't updated). Must determine which before fixing.
- The `mirror:check` drift in `switchboard-remote/SKILL.md` may be caused by a source `.agents/` file that was edited without regenerating the mirror, or by a `generateClaudeMirror` logic change that wasn't reflected in the checked-in mirror.
- The `staging-column` failure may involve the autoban scheduler's column-scoping logic — a broad change that could have side effects.
- The `feature-file-subtask-link` failure may involve the plan-linking logic that resolves planIds — a change to the resolution path could have weakened the abort-on-unresolvable guard.

## Edge-Case & Dependency Audit

- **`mirror:check` script:** `scripts/check-claude-mirror.js` compares checked-in `.claude/skills/` against a fresh generation. The fix is either regenerate-and-commit or fix-the-source.
- **`staging-column` test:** `src/test/staging-column-contract.test.js` — need to read the full test to understand the exact assertion and setup.
- **`feature-file-subtask-link` test:** `src/test/feature-file-subtask-link-contract.test.js` — need to read the "unresolvable planId" test case specifically.
- **Overlap with Issue 4:** Both Issue 4 and Issue 10 name `mirror:check` as red. They may be the same drift or different drifts. Issue 4 lists five gates; Issue 10 lists three (verified in a detached worktree). The `mirror:check` fix likely resolves both.
- **No current-work contamination:** The issues state these are red at clean HEAD, verified in a detached worktree. Fixes should be against HEAD, not any branch.

## Proposed Changes

### 1. Fix `mirror:check` (`.claude/skills/switchboard-remote/SKILL.md`)

```bash
npm run mirror:check
```

Read the diff output to identify what drifted. Then either:
- **Source fix:** If `.agents/skills/switchboard-remote.md` (or the source file that generates this mirror entry) was edited and the mirror wasn't regenerated, run the mirror generation and commit:
  ```bash
  node -e "const {generateClaudeMirror} = require('./out/services/ClaudeCodeMirrorService'); generateClaudeMirror(process.cwd(), '1.0.0');"
  git add .claude/skills/switchboard-remote/SKILL.md
  ```
- **Logic fix:** If `generateClaudeMirror`'s output format changed (e.g., a new header, a different metadata block), update the checked-in mirror to match by regenerating.

Verify: `npm run mirror:check` exits 0.

### 2. Fix `test:contract:staging-column`

```bash
node --require ./src/test/bootstrap/sandboxStateHome.js src/test/staging-column-contract.test.js
```

Read the assertion failure. The test expects "the autoban schedule run sheet pops STAGING and nothing else." Trace the autoban scheduler's run-sheet logic:
- Find where the schedule run sheet is built (likely in `KanbanProvider.ts` or `TaskViewerProvider.ts`).
- Verify it only pops STAGING when the schedule targets STAGING.
- If the code pops additional columns, fix the scoping logic.
- If the test expectation is stale (the contract changed), update the test.

Verify: `npm run test:contract:staging-column` exits 0.

### 3. Fix `feature-file-subtask-link-contract` (unresolvable planId case)

```bash
node --require ./src/test/bootstrap/sandboxStateHome.js src/test/feature-file-subtask-link-contract.test.js
```

Read the "unresolvable planId" test case. The test expects that when a planId in a feature file's SUBTASKS block cannot be resolved against the kanban DB, the link-writing process aborts (throws or returns without writing) rather than writing guessed/placeholder links.

Trace the link-writing code:
- Find the function that resolves planIds in feature files (likely in `KanbanProvider.ts` or a feature-file service).
- Verify it throws or returns early when a planId is unresolvable.
- If the code currently writes guessed links (e.g., matching by filename or topic), add a guard that aborts on unresolvable planIds.
- If the test expectation is stale (the behavior was intentionally changed to write guessed links), update the test.

Verify: `npm run test:contract:feature-file-subtask-link` exits 0.

## Verification Plan

1. Run `npm run mirror:check` — assert exit code 0.
2. Run `npm run test:contract:staging-column` — assert exit code 0.
3. Run `npm run test:contract:feature-file-subtask-link` — assert exit code 0.
4. Run the full contract test suite — assert no regressions from the fixes.
5. Verify in a detached worktree at HEAD that all three checks pass after the fix.
