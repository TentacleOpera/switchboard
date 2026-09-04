# Nine Gates That Pass Without Asserting Their Own Mechanism

## Goal

Nine places where a CI gate, or a plan's named verification, reports success while checking something other than the behaviour it exists to protect. Each needs either a real assertion or an honest admission that the mechanism is unverified.

### Problem analysis

Nine reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD by running the gates rather than reading them.

They fall into two kinds. Some are **source-text assertions standing in for behaviour** — the test greps the implementation for a string and calls that coverage. Others are **named assertions that were never written at all**, where a plan's Automated verification section lists tests that do not exist and the card shipped anyway.

This is the same family as the active *Gates that mean something* feature, which owns the reachability ratchet, the source-span helper and the pin-behaviour sweep. These nine are specific instances that feature does not name.

## Metadata

- **Complexity:** 6
- **Tags:** testing, ci, verification

## User Review Required

None.

## Proposed Changes

### 1. "One Completion Signal Per Agent Turn" shipped with none of its eight named tests

`grep -rn "countActiveDispatchedByTerminal\|getActiveDispatchedRowsByTerminal" src/test/` returns zero hits; both methods exist at `KanbanDatabase.ts:10685` and `:10712`. The per-row silence sweep and the `planCount` meta are equally uncovered.

A queue/done completion-payload contract suite is the deliverable, and it pairs with the sibling finding that a batch's sibling cards are never cleared — see *Six loose defects* in this set.

### 2. The team-start feature's named assertions were never written

Three of four subtasks in *Starting A Team, And The Surfaces That Show It* shipped with none of their `### Automated` assertions. No test references `addWorktree` in a provisioning context, the `_resolveDefaultBranch`/`_createSafetyWorktree` ordering, or `startTeam`'s silent flag. The plan files' own review sections record this as MAJOR.

The feature is CODE REVIEWED and off the active board, so nothing owns it.

### 3. The workspace-mappings suite is CI-wired but missing its two named assertions

Nothing asserts `_getWatchFolders()` always contains the current workspace root (the method is `KanbanProvider.ts:1939`), and nothing asserts `refreshUI()` recovers on an unresolvable root. The CI step exists and runs three other suites.

Cheapest item here: add both to a suite already wired.

### 4. `external-headed-team` is red and owned by nothing

Ran all three contracts the memo named. `queue-pipeline` now passes, its assertion having been inverted to "must stay deleted". `stage-marker-commit` fails exactly the two cases named, and is item 10 of the seventeen-suite triage card. **`external-headed-team` fails tests 2 and 8** — test 8 on a `/kanban/dispatch` phrase that *is* present at `agentGroupInstantiation.ts:324`, so what moved is the extraction window, not the code.

It is in no triage card's list. Add it there or give it its own.

### 5. `headless-feature-mgmt` is red on an assertion in no triage list

Ran it: one failure, `headless-feature-management-contract.test.js:477`, asserting the automation gate names `#btn-autoban`. `transport.js:477-492` lists seven selectors and that is not among them. CI-wired at `integration-tests.yml:561`, and absent from the seventeen-suite card.

### 6. The "working, no output" affordance has never been seen rendered

`terminal-content-free-collapse-contract.test.js:363` labels its own webview section "Source-text — assertions on .js". Verification items 8 and 9 of the owning plan are therefore open in both hosts. This is a live-host pass, not a new test.

### 7. The terminal-creation-policy seam has no behavioural gate

`standalone-fleet-seam-contract.test.js:81-102` asserts only `assert.match(body, …)` against extracted source, and `browser-direct-terminal-helpers.test.js` only greps for the call. Nothing discriminates the one-startup-command rule, the artifacts top-up, or the post-startup settle.

The deliverable is a behavioural test with a stubbed `_ptyHostVerb`.

### 8. The cap-label gate cannot see the number it exists to check

`batch-move-team-prompt-contract.test.js:409-413` asserts the HTML contains the strings `.column-icon-btn-labeled`, `.cap-label`, `updateCapLabels`, `teamHeadColumns` and `teamBatchPlanCap`. It says nothing about which column carries the label or what number it shows — which is the whole of "SEND N OF M".

### 9. Delegated drag-and-drop is exercised in neither host

`kanban.html:8614` iterates `.column-body` for the delegated bindings, `:7975` resolves the card via `closest('.column-body')`, and `:10167` clears drag-over state; the per-card `.card-btn.review` and `.card-btn.complete` bindings are gone. No automated check can tell whether the delegated path works, in either host.

A two-host manual pass, recorded, until something can drive it.

## Verification Plan

1. Each of items 1 to 3 has its named assertions present and running in CI.
2. `external-headed-team` and `headless-feature-mgmt` are either green or explicitly listed on a triage card with a decision recorded.
3. Items 6 and 9 have a dated live-host result recorded in their plan, naming the host and the outcome.
4. Items 7 and 8 assert behaviour: the seam test stubs `_ptyHostVerb` and observes calls; the cap-label test observes the rendered column and count.
5. No gate in this set passes while the mechanism it names is absent — checked by breaking the mechanism deliberately and confirming the gate goes red.
