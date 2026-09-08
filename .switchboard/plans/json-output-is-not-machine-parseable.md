# `--json` output is not machine-parseable: an interactive prompt is appended, and stdout truncates on exit

## Goal

Make `switchboard <cmd> --json` emit exactly one JSON document on stdout and nothing else, complete regardless of size, so any agent or script can pipe it straight into a parser — and keep it that way via a regression harness, since both headline defects were already fixed at HEAD and the remaining risk is silent reintroduction.

### Problem Analysis

Two defects were originally reported. **Both are already addressed in the current code; this plan's value is now the regression guard and the audit that confirms no `--json` path bypasses the fix.** They are documented here as the original findings, with superseded callouts recording what HEAD already does.

**1. An interactive picker line was appended after the JSON.**

`switchboard ready --json` originally wrote the JSON document, then appended:

```
Select a card to dispatch (1-161) [or Enter to exit]:
```

Every JSON parser failed on this: `json.decoder.JSONDecodeError: Extra data: line 6608 column 1 (char 230116)`. The prompt was emitted even when stdout was not a TTY (verified over ssh, which allocates no TTY). `--json` is an explicit request for machine output and must suppress the picker entirely, not merely skip blocking on it.

> **Superseded:** "`switchboard ready --json` writes the JSON document, then appends the 'Select a card to dispatch' prompt — every JSON parser fails on it."
> **Reason:** Verified at HEAD: `cmdReady` gates the picker on `jsonFlag` at `cli.ts:1298`, emitting via `emitJson` + `exitFlushed(0)` at `:1300` *before* the interactive picker is reached at `:1321`. The `ready` command no longer appends the prompt under `--json`. The remaining picker sites (`cli.ts:1321`, `:2715`, `:2844`, `:2925`) all live inside interactive TTY browse loops (`consoleBrowseByColumn`, `consoleFilterByProject`, etc.) that are not reached on the `--json` path.
> **Replaced with:** An audit (Proposed Change #1) that grep-asserts **no** `--json` success path reaches an interactive prompt, covering every JSON-emitting command — not a re-fix of `ready`, which is already correct.

**2. stdout truncated past roughly 400KB.**

Measured on `plans "PLAN REVIEWED"`:

| `--limit` | bytes | result |
| :-- | :-- | :-- |
| 100 | 146,757 | valid |
| 300 | 360,448 | valid |
| 500 | 425,984 | truncated mid-document |

425,984 is exactly 416KB — a buffer boundary, not a card count. The cutoff moved with load: an agent session on the same board measured it at roughly 250KB. This was the classic Node pattern where `process.exit()` is called with pending asynchronous writes still queued on a piped stdout; the process died before the buffer drained. It could not be worked around reliably by callers, because the threshold was not deterministic.

> **Superseded:** "Replace `process.exit()` on success paths with a drain-then-exit helper that awaits the `drain` event when `process.stdout.write()` returns `false`."
> **Reason:** That helper already exists: `exitFlushed(code)` at `cli.ts:232` — it exits immediately when `process.stdout.writableLength === 0`, otherwise writes an empty buffer whose callback exits, with a 2s `unref`'d timeout as a belt-and-braces guard against a drain that never fires. Its own comment (`:226-230`) documents exactly the truncation failure this plan described, including why a hard exit is still required (DB services leave handles behind, so returning normally is not guaranteed to end the process). Every `emitJson` success path pairs with `exitFlushed(0)` (e.g. `:1133-1134`, `:1233-1234`, `:1300`, `:1497-1498`, `:1674`, `:1775`).
> **Replaced with:** An audit (Proposed Change #2) that grep-asserts **no** `--json` success path calls `process.exit()` directly instead of `exitFlushed`, and routes any bypass found through `exitFlushed`. The helper is not invented here; it is reused.

**3. Human-readable output on stderr — already done.**

> **Superseded:** "Send human-readable output to stderr, always. It already goes there for some commands; make it consistent so stdout carries the JSON document alone."
> **Reason:** `emitJson`'s setup redirects `console.log`, `console.info`, and `console.debug` to stderr (`cli.ts:270-272`), so any human-readable logging routed through `console.*` already lands on stderr when the JSON path is active. The mechanism is universal, not per-command.
> **Replaced with:** A grep-assertion (Proposed Change #3) that no `--json` success path writes non-JSON to stdout via `process.stdout.write` directly (bypassing `emitJson`), which is the one way the stderr discipline could be defeated.

### Root Cause

1. The picker was originally invoked on a code path that checked TTY-ness (or did not check at all) rather than checking whether `--json` was requested. `--json` must short-circuit every interactive affordance. **Fixed at HEAD for `ready`; the audit generalises the guarantee to every command.**
2. `process.exit()` was called while stdout still had buffered data. On a pipe, Node's stdout is asynchronous, so anything unflushed was lost. **Fixed at HEAD by `exitFlushed`; the audit generalises the guarantee to every `--json` path.**

The remaining failure mode this plan guards against is **regression**: a future command that emits JSON and then calls `process.exit(0)` directly, or reaches an interactive prompt before checking `--json`, reintroduces both defects silently — silently, because nothing currently asserts the invariant across the whole command surface.

## Metadata

**Complexity:** 3
**Tags:** cli, bugfix, agent-ergonomics
**Project:** Browser Switchboard

## User Review Required

No — the fixes are already in place; this is an audit + regression-harness plan with no product decisions.

## Complexity Audit

### Routine

- Grep the CLI for `process.exit(` on success paths and cross-reference against `--json`-emitting commands.
- Grep for `process.stdout.write` calls outside `emitJson` on JSON paths.
- Add a regression test that pipes each JSON-emitting command through a parser.

### Complex / Risky

- **The >500KB-under-load case is the only non-trivial part.** Reproducing the original truncation required concurrent board load to lower the threshold to ~250KB. A regression test that runs `plans --limit 500 --json` on a quiet board passes trivially and proves nothing about the load case. The harness must either drive concurrent load or assert on `exitFlushed` *usage* (static) rather than only on parse success (dynamic), to avoid a green test that does not cover the original failure mode.
- **Static vs dynamic coverage gap.** A parse-success test catches a truncation that *has happened*; a grep-assertion that every `--json` success path uses `exitFlushed` catches one that *would happen*. Both are needed — the static check is the proactive guard, the dynamic check is the proof.

## Edge-Case & Dependency Audit

**Race conditions**
- None for the audit (static). For the dynamic test: a board whose plan set changes between runs changes the byte count — assert parse-success and completeness (the document ends with a closing brace/newline), not an exact byte count, unless the board is frozen.

**Security**
- None. No new routes, no new credentials, no new output channel.

**Side effects**
- None. The plan adds tests and (only if the audit finds bypasses) routes existing paths through an existing helper. No behaviour change for any current command.

**Dependencies & conflicts**
- Shares `cli.ts` with the *agents-need-a-named-operation-set* subtask, which introduces a single command table that derives `usage()`, per-command error strings, and the docs page. **Ordering:** this plan should land before or alongside that one, so the command table inherits the `exitFlushed` discipline from the start rather than having to retrofit it across a newly-generated surface. If the command table lands first, its generated per-command exit paths must be grep-asserted to use `exitFlushed` on `--json` — the same audit, applied to generated code.

## Dependencies

- Reuses `exitFlushed` (`cli.ts:232`) and `emitJson` (`cli.ts:276`) — both already present.
- **Ordering within feature:** land before or alongside *agents-need-a-named-operation-set* (shared `cli.ts`; the command table must inherit the drain discipline).

## Adversarial Synthesis

Key risks: (1) the plan "succeeds" by re-fixing already-fixed bugs and ships nothing — mitigated by reframing the deliverable as audit + regression harness; (2) a parse-success test on a quiet board proves nothing about the load-induced truncation that was the original failure — mitigated by pairing the dynamic test with a static grep-assertion that every `--json` success path uses `exitFlushed`; (3) a future command reintroduces the defect silently because nothing enforces the invariant across the whole surface — mitigated by making the grep-assertion a CI gate, not a one-off check.

## Proposed Changes

1. **Audit: no `--json` success path reaches an interactive prompt.** Grep-assert, across every JSON-emitting command, that the `jsonFlag` branch returns/emits before any `prompter.ask` / `promptWithSigInt` call. `ready` is already correct (`cli.ts:1298`); confirm the rest. Fail CI on a violation.
2. **Audit: no `--json` success path calls `process.exit()` directly.** Grep-assert that every `emitJson(...)` success path is followed by `exitFlushed(...)` (or returns to a caller that exits flushed), and that no `--json` path writes non-JSON to stdout via `process.stdout.write` outside `emitJson`. Route any bypass found through `exitFlushed`. Fail CI on a violation.
3. **Regression harness — the primary deliverable.** A test that pipes `--json` output of each JSON-emitting command through a parser (`python3 -c 'import sys,json;json.load(sys.stdin)'` or equivalent) and asserts it parses, including one case above 500KB (`plans "PLAN REVIEWED" --limit 500 --json`). Pair the dynamic parse check with the static grep-assertion from #2 so the load case is covered structurally even when the test board is quiet.
4. **Under-load stability (best-effort).** If feasible without flakiness, run the >500KB parse test under concurrent board load and assert the byte count is stable across runs. If reproducing load reliably in CI is not feasible, rely on the static `exitFlushed`-usage assertion as the load-case guard and record that decision in the test.

### Migration

None. No stored shapes change, no config changes, no behaviour change for any current command. The plan adds guards; it does not alter output.

## Verification Plan

> **Session directive:** compilation and automated tests are skipped for this run. The checks below remain the plan's verification contract for when they are executed normally.

### Automated Tests

1. `switchboard ready --json | python3 -c 'import sys,json;json.load(sys.stdin)'` exits 0.
2. `switchboard plans "PLAN REVIEWED" --limit 500 --json | wc -c` returns the full document, and it parses.
3. Repeat 2 under concurrent board load — byte count is stable across runs (or, if load is not reproducible in CI, the static `exitFlushed`-usage assertion covers the load case and the test records this).
4. No command emits "Select a card to dispatch" when `--json` is present — grep-asserted across the command surface.
5. `switchboard plans "CREATED" --json 2>/dev/null` yields JSON alone on stdout.
6. CI gate: grep-asserts no `--json` success path calls `process.exit()` directly (must use `exitFlushed`), and no `--json` path writes non-JSON to stdout outside `emitJson`.

### Goal Invariants

- **Positive:** every `emitJson(...)` call site in `cli.ts` is followed (on the success path) by `exitFlushed(...)` or a return to a flushed exit — grep-asserted.
- **Positive:** `switchboard <cmd> --json` for every JSON-emitting command produces output that parses as exactly one JSON document (regression harness).
- **Negative:** no `--json` success path in `cli.ts` calls `process.exit()` directly — grep-asserted (the original truncation cause is absent from every JSON path).
- **Negative:** no `--json` path in `cli.ts` reaches a `prompter.ask` / `promptWithSigInt` call — grep-asserted (the original picker-append cause is absent from every JSON path).

## Recommendation

Complexity 3 → **Send to Intern.** The work is an audit plus a regression harness; both headline bugs are already fixed at HEAD, so the coder is adding guards, not debugging. The one non-trivial piece is making the >500KB-under-load test meaningful rather than a green-on-quiet-board false positive — the coder should lean on the static `exitFlushed`-usage assertion as the load-case guard if dynamic load is hard to reproduce in CI.
