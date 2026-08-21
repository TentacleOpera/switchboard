# Give the 12 BDD-Style Dark Test Files a Runner

## Goal

Make the 12 mocha/BDD-style test files under `src/test/` executable by something, so their assertions can be triaged at all.

### Problem

12 test files use mocha's BDD globals (`describe` / `it`). Run with plain `node` they throw `ReferenceError: describe is not defined` before a single assertion evaluates. Nothing else runs them either:

- **`npm test` → `vscode-test`** reads `.vscode-test.mjs`, which globs **five specific paths**, all under `out/`: `out/test/pair-programming-*.test.js`, three `out/services/__tests__/*.test.js` files, and `out/test/kanban-complexity.test.js`. None of the 12 matches.
- **CI invokes `npm test` twice**, both `--grep`-filtered (`"agentPromptBuilder"`, `"KanbanProvider"`), so even a matching glob would be filtered out.
- **No npm script** references any of the 12.
- **`tsc`** does not emit them to `out/test/` (confirmed: `out/test/path-normalization.test.js` does not exist).

So these files are not merely unwired — they are **unrunnable in their current form**. Their assertions have never executed, and cannot be triaged until this is fixed. Running one by hand under `npx mocha` produces real failures immediately (`path-normalization.test.js`: *"Expected `_migrateLegacyPrimaryFiles` to hash `stableBrainSourcePath`"*, *"Expected mirror->brain guard to use `_isPathWithin`"*), which is evidence there is signal behind the wall.

### Root Cause Analysis

The repo runs three different test styles and only two have a path to execution:

| Style | Invocation | Reachable? |
| :--- | :--- | :--- |
| Standalone script (`node file.js`, own `test()` helper, `process.exit(1)`) | `node --require ./src/test/bootstrap/sandboxStateHome.js <file>` | Yes — this is what every `test:contract:*` script uses |
| Mocha TDD (`suite`/`test`), compiled | `mocha --ui tdd … out/…` or `vscode-test` via the `.vscode-test.mjs` glob | Yes, for the five globbed paths |
| **Mocha BDD (`describe`/`it`), uncompiled, in `src/test/`** | — | **No** |

The third style was presumably written when a broader `out/test/**` glob or a general mocha script existed, or by an author assuming `npm test` would pick anything up. When the config narrowed to five explicit paths, these files became orphans silently — narrowing a glob removes tests from the run without removing them from the tree, and nothing reports the delta.

### Measured Scope

12 files, 8 of them a single cluster:

- `brain-delete-tombstone-regression`, `brain-duplicate-dedupe-regression`, `brain-new-plan-visibility-regression`, `brain-path-depth-regression`, `brain-registry-rescue-regression`, `brain-rescan-regression`, `brain-session-dedupe`, `brain-source-layout-regression` — the `brain-*` cluster (8)
- `agent-config-drag-drop-mode`
- `path-normalization`
- `plan-recovery-regression`
- `workspace-scope-regression`

## Metadata
- **Complexity:** 4
- **Tags:** testing, ci, infrastructure

## User Review Required
None. The runner decision is made below: add a mocha script for BDD-style files in `src/test/` rather than converting the files or widening the `vscode-test` glob. Rationale is in Proposed Changes.

## Complexity Audit

### Routine
- Adding one npm script that runs mocha with the BDD UI and the existing `sandboxStateHome` preload.
- Adding the matching CI step.
- Confirming each of the 12 now executes (executes — not passes).

### Complex / Risky
- **Choosing the runner is the whole decision, and two of the three options are traps.** Widening the `.vscode-test.mjs` glob drags these into the Electron/xvfb `vscode-test` harness, which is slower, needs a display, and is `--grep`-filtered in CI — so they would still not all run. Converting 12 files to the standalone style is a mechanical rewrite of 12 files' worth of `describe`/`it` nesting into the hand-rolled `test()` helper, which risks changing what each assertion covers while claiming to be a no-op. A plain mocha script does neither.
- **They will be red on arrival.** Making them runnable makes them fail — that is the point, but it means the CI step cannot be added until the failures are triaged, or CI goes red. The step lands disabled-by-baseline (see Proposed Changes).
- **`sandboxStateHome` preload must be honoured.** Every existing test script preloads `./src/test/bootstrap/sandboxStateHome.js` to redirect state writes away from the developer's real home. A mocha invocation that omits it lets 12 tests write to the real state home. `.vscode-test.mjs` already declares this preload, which is the precedent.

## Edge-Case & Dependency Audit

- **Do not widen the `.vscode-test.mjs` glob.** It would pull these into the Electron harness, and CI's two `--grep` filters mean most still would not run — a change that looks like wiring and delivers nothing.
- **BDD vs TDD UI.** These files use `describe`/`it` (BDD, mocha's default), while the two existing mocha scripts pass `--ui tdd` for `suite`/`test` files. The new script must NOT pass `--ui tdd`, and must not be merged with the existing ones.
- **State-home preload is mandatory**, matching every other test script and `.vscode-test.mjs`'s `mocha.preload`.
- **Mocha is present but UNDECLARED — declare it.** `node_modules/mocha` is 11.7.5, but nothing in `package.json` names it; it arrives transitively via `@vscode/test-cli` (`"mocha": "^11.7.4"`). Two CI steps already invoke bare `mocha` on that hoist — `test:contract:reviewer-prompt-behaviour` and `test:contract:kanban-column-labels` — so a `@vscode/test-cli` bump that drops or renests it breaks those two steps with an error that looks nothing like its cause. Add `mocha` as an explicit devDependency at the version already resolved, pinning what two gates and this plan's new script all assume.
- **Do not fix assertions in this plan.** Making the files runnable and fixing what they then report are separate deliverables; folding them together makes the runner decision unreviewable behind a wall of assertion diffs.
- **Shared-fixture risk.** Running 12 previously-unexecuted files in one mocha process shares state across them in a way none has experienced. The 8 `brain-*` files are the likely collision point. Isolate per-file if the cluster proves order-dependent.
- **`workspace-scope-regression.test.js` is in this set, not the standalone set.** Its style was initially misclassified by a `^\s*(describe|suite)\s*\(` scan; it fails with `describe is not defined` and belongs here.

## Dependencies

None blocking. Related but independent:
- *Test reachability ratchet* — once these 12 are runnable they count toward its reachable set, lowering its baseline.
- *Triage the failing dark tests* — covers the 83 standalone-style failures. Whatever these 12 report once runnable is triaged by the same criterion, and should be appended to that plan's scope rather than duplicated here.

## Adversarial Synthesis

Key risks: (1) picking the `vscode-test` glob option, which reads as wiring and delivers almost nothing because CI `--grep`-filters that runner; (2) converting the files to the standalone style and silently altering assertion coverage while calling it a port; (3) omitting the `sandboxStateHome` preload, letting 12 tests write to the real state home — a defect that only shows up as pollution on the developer's own machine; (4) adding the CI step while the tests are red, which either breaks CI or trains people to ignore it; (5) declaring victory on "runnable" when the step is not actually invoked. Mitigations: decide the runner explicitly and record why the other two were rejected; do not touch the files' contents in this plan; copy the preload flag from `.vscode-test.mjs`; land the CI step with a pass-threshold baseline so it is green on arrival and ratchets down as the sibling triage plan fixes them; verify the step appears in the workflow AND resolves to a real npm script.

## Proposed Changes

### Runner decision

Add a **plain mocha script with the default BDD UI** for the BDD-style files in `src/test/`. Rejected alternatives, recorded so they are not revisited:

- *Widen `.vscode-test.mjs`* — pulls them into the Electron/xvfb harness, which is slower, needs a display, and is `--grep`-filtered in CI, so most still would not run.
- *Convert to the standalone style* — a 12-file mechanical rewrite that risks changing assertion coverage while claiming to be a no-op, for no gain over invoking the runner they were written for.

### `package.json`

- Add `test:mocha:bdd` invoking mocha over the BDD-style files with `--require ./src/test/bootstrap/sandboxStateHome.js` and **no** `--ui` override (BDD is the default). Enumerate the 12 paths explicitly rather than globbing `src/test/*.test.js` — a glob would sweep in the ~180 standalone-style files, which mocha would load and which would run their own harnesses on import.
- Add `mocha` as an explicit devDependency at the resolved version (11.7.5). It is currently undeclared and reaches `node_modules` only through `@vscode/test-cli`'s dependency tree — see the Edge-Case audit. This is a pre-existing fragility that two CI steps already sit on; this plan should not add a third undeclared consumer.

### `.github/workflows/integration-tests.yml`

- Add a `BDD-style test suite` step running `test:mocha:bdd`, with a comment recording that these 12 files were executable by nothing until this landed, and that `.vscode-test.mjs` globs five explicit `out/` paths so narrowing it silently orphaned them.
- Land the step **only once the tests pass**, or with an explicit pass-count baseline that ratchets down, so it is green on arrival. A step that is red from day one is worse than no step.

## Verification Plan

### Automated Tests

- `npm run test:mocha:bdd` **executes** all 12 files — the first success criterion is that assertions evaluate at all, distinct from passing. Verify by asserting the reported test count is non-zero for each file, not by reading the exit code.
- Each of the 12 individually: `npx mocha --require ./src/test/bootstrap/sandboxStateHome.js src/test/<file>` reports assertions run.
- **State-home containment:** run the suite and confirm nothing was written outside the sandboxed state home — the preload's whole purpose, and silent when omitted.
- **Order independence:** run the suite, then run it with the file list reversed; the same set passes and fails. A difference means cross-file state leakage in the `brain-*` cluster.
- Existing mocha scripts still pass — `test:contract:reviewer-prompt-behaviour`, `test:contract:kanban-column-labels` — confirming the new script did not disturb the TDD-UI invocations.
- `npm ls mocha` shows it as a declared top-level devDependency, not only as a transitive of `@vscode/test-cli`.
- Eight static gates still pass.
- The new CI step resolves to a real npm script (parse the workflow, check each `npm run <name>` against `package.json`).

### Manual Verification

1. Run `npm run test:mocha:bdd` and confirm the output names all 12 files with assertion counts.
2. Confirm no `--ui tdd` on the new script and that the two existing mocha scripts still carry theirs.
3. Confirm the enumerated path list contains exactly the 12 files and no glob.

## Outstanding Questions

None.
