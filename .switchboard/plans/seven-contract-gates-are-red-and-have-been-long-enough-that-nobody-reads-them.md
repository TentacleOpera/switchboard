# Seven Contract Gates Are Red, and Have Been Long Enough That Nobody Reads Them

## Goal

Every `test:contract:*` suite wired into CI passes, or is deleted with its reason
recorded. A red gate that everyone steps over is not a gate — it is a habit of
ignoring gates, and it hides the next real regression inside the noise.

## Problem analysis

Measured 2026-09-19 while verifying unrelated work. Each was traced to a commit that
predates that session, so none is fresh breakage — they have simply been red long
enough to become background:

| suite | failures | what it asserts that is no longer true |
| :--- | ---: | :--- |
| `standing-orders-marker` | 11 | `sendPromptToPty` call-shape in `bootstrap.ts`; the two `/api/pty/` request builders in `TaskViewerProvider`; `scopeRank` / `applyStandingOrders` rendering; `reloadTerminalGroups` redraw counts |
| `reviewer-prompt-behaviour` | 5 | apiPort injection into reviewer delegation; the Acceptance Tester default |
| `stage-marker-commit` | 4 | one `loadEffectiveStandingOrders` call site in `bootstrap.ts` (there are two since `a8da4102`); raw `getConfigJson(STANDING_ORDERS_CONFIG_KEY)` counts per file |
| `queue-pipeline` | 1 | pop ordering — "lowest `column_order`, NULLs first" returns `a` where the test expects `c` |
| `panel-runtime-surface` | 1 | `memo.html` declares `connect-src 'self' ws: wss:` |
| `batch-move-team-prompt` | 1 | the prompt contains `/kanban/task/complete` |
| `default-prompt-previews` | 1 | the coder preview contains the accuracy-mode line |

**Two of these are not stale tests — they are live defects the gate caught and
nobody acted on:**

- **`memo.html`'s CSP is a silent no-op.** `headlessPanelHtml` widens `connect-src`
  by **plain string replace** against a known literal. `memo.html` was reworded to
  `connect-src 'self' ws: wss:`, which that replace does not match, so the widening
  never happens. The panel is shipping an unwidened CSP and the test is telling the
  truth.
- **`queue-pipeline`'s pop ordering.** A queue that pops the wrong card is a real
  behavioural claim, not a naming drift. It needs reading before it is assumed stale.

**Two are tests asserting behaviour that was deliberately changed, and were never
retargeted:**

- `batch-move-team-prompt` pins `/kanban/task/complete`, the raw HTTP call that
  `de89e8d3` ("the CLI is the only way to assert completion") deliberately replaced
  with the CLI verb. The commit changed the prompt and left the gate.
- `stage-marker-commit` counts `loadEffectiveStandingOrders` call sites and expects
  one; `a8da4102` added a second, legitimately.

**Why this matters beyond tidiness.** Seven red suites is enough noise that a genuine
regression lands inside it unnoticed — and this exact thing happened during the
session that measured them: a real `agent-machines` failure introduced that day was
initially indistinguishable from the standing background, and was only separated from
it by blaming every failure individually against git history. That triage cost more
than fixing the suites would have.

## Metadata

**Complexity:** 5
**Tags:** ci, contract-tests, tech-debt, regression-gate
**Scope:** the contract suites under `src/test/`, plus `src/webview/memo.html` and
whatever the queue-ordering finding turns out to touch.

## Dependencies

None, and it should not wait for one. Each row is independently fixable and the value
arrives per-row.

## Proposed changes

### 1. Triage each row: LIVE DEFECT, RETARGET, or DELETE

For every failure, decide which of three it is, and record the decision next to the
test:

- **Live defect** — the gate is right and the code is wrong. Fix the code.
  (`memo.html` is one. `queue-pipeline` must be read before it is classed.)
- **Retarget** — the behaviour changed on purpose and the assertion was left behind.
  Move it to the new invariant, **never weaken it**. `batch-move-team-prompt` asserts
  completion is asserted; that is still true, via the CLI.
- **Delete** — the invariant is genuinely gone. Delete the test AND say in the commit
  what stopped being true, so nobody reinstates it.

The counting assertions (`exactly one call site`, `exactly three files`) deserve
particular suspicion: they go red on legitimate growth, which is how a gate teaches
people to ignore it.

### 2. Fix `memo.html`'s CSP, and make the widening unable to fail silently

Restore the literal the host can rewrite, and then remove the fragility: a
`connect-src` widening implemented as a string replace against prose will break again
the next time someone rewords a CSP. It should fail loudly when it does not match,
rather than returning the input unchanged.

### 3. Read the queue pop ordering before assuming

`the pop takes the lowest column_order, NULLs first` expects `c` and gets `a`. Either
the SQL lost its `NULLS FIRST` ordering or the fixture drifted. One is a bug that
mis-orders the operator's queue; the other is nothing. Do not batch this with the
cosmetic rows.

### 4. Make red gates visible

Whatever the current CI reporting is, seven suites went red without anyone noticing.
Fixing them does not stop the eighth. The cheap version: an aggregate step that fails
the build listing every red `test:contract:*`, so a single red suite is a build
failure rather than a line in a log nobody opens.

## Verification plan

### Automated

- Every `test:contract:*` script invoked by `.github/workflows/integration-tests.yml`
  exits zero.
- `memo.html`'s `connect-src` matches what `headlessPanelHtml` rewrites, asserted
  against the rewriter rather than against a copy of the literal.
- The widening throws or reports when its target literal is absent, and a test proves
  it — a silent no-op is what produced this.
- The queue pop returns the documented order, with NULL `column_order` leading, on a
  fixture that includes both NULL and non-NULL rows.
- Retargeted assertions pin the CURRENT invariant and fail if it regresses — checked
  by mutating the source and watching them go red, not by watching them pass.

### Goal invariants

- A red contract suite is a build failure, not a known quantity.
- No suite was made to pass by weakening what it asserts. Every change either fixes
  code, moves an assertion to the invariant that replaced it, or deletes it with a
  recorded reason.
- A counting assertion that goes red on legitimate growth is replaced by one that
  states the actual rule.

### Manual

Run the full `test:contract:*` set locally and confirm the summary is clean, then
re-run after deliberately breaking one invariant per fixed suite to confirm each
still catches what it claims to.

## Outstanding questions

- **Is `queue-pipeline` a live defect?** Unclassified on purpose — see Change 3. It
  is the one row here that could be mis-ordering real work, and guessing it stale is
  how it would stay that way.

## Related card, and why the count is "seven" rather than "all of them"

`9d6a4525` — *Triage remaining red contract gates: staging-column and
feature-file-subtask-link* — covers two suites that are **not** in the table above,
so the two cards are complementary rather than duplicates. Re-measured 2026-09-19:
**both of its gates now pass** (`staging-column` green, `feature-file-subtask-link`
14/14), so that card appears complete and should be verified and retired rather than
coded.

Its framing is the strongest argument for Change 4 here. It opens with *"Two contract
gates remain red after the queue-watch gates were fixed in a reviewer pass"* — i.e.
red gates have already been triaged at least twice, and each pass left a residue that
nobody noticed accumulating. Seven more did. Fixing this batch without making a red
gate fail the build just schedules the next card like this one.

The seven above are the suites measured on 2026-09-19 while verifying unrelated work.
They are not necessarily the complete set — nothing currently reports one.
