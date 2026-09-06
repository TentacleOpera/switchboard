# A seat's CLI family is derived once at spawn and frozen, so every Devin readiness fix silently misses any seat not classified as Devin

## Goal

Make the readiness profile follow what a seat is actually running, and make a misclassification loud instead of silent. This is the reason repeated fixes to "Devin gets its prompt too early" keep failing to take.

### Problem Analysis

**The observation.** Starting a team, the standing orders were pasted into Devin's composer and never submitted — the text sat in the input area. This has recurred across multiple attempted fixes aimed at prompts being sent before the CLI is ready.

**The delivery path is not the problem, and must not be re-fixed.** `sendPromptToPty` (`ptyPromptDelivery.ts:241-259`) opens bracketed paste, chunks the payload, closes it, settles, writes `\r`, waits `CONFIRM_ENTER_DELAY_MS = 200`, and writes a second `\r`. The confirm Enter is **unconditional by design** — the comment at `:234-240` records that the previous `CLI_AGENT_REGEX` gate was removed precisely because it "silently omitted 13 of the 19 CLIs" and was "a static name match standing in for a runtime question". That work is done. Devin is not missing a confirm Enter.

**What actually decides when the prompt fires.** Before the paste, `awaitFirstReadiness` (`clearReadiness.ts:288`) waits for the cold-booting CLI. It resolves per family (`:338-358`):

```
family = options?.cliFamily || target.cliFamily || 'unknown'

devin        → ceiling 20000ms, quiet 250ms
claude       → ceiling  8000ms, quiet 250ms
antigravity  → ceiling  8000ms, quiet 250ms
unknown      → falls through to the CLAUDE constants: 8000ms / 250ms
```

Devin's ceiling is **2.5× every other family's**, because Devin's boot is that much slower. A seat that is running Devin but is *classified* as anything else gets the 8-second gate, the prompt lands mid-boot, the composer swallows both carriage returns, and the text sits there.

**Where the classification comes from.** `ptyFleetService.ts:457`:

```ts
const cliFamily = deriveCliFamily(effectiveStartupCommand);
```

`deriveCliIdentity` (`src/services/cliIdentity.ts:25-57`) takes `basename` of the first token and matches exactly three names: `devin`, `claude`, `agy`/`antigravity`. **Everything else is `unknown`**, which silently borrows Claude's 8-second ceiling. And `cliFamily` is written onto the handle at spawn and never recomputed.

### Root Cause

**Readiness timing is keyed on a string parsed once from a command that may be stale, wrong, or simply unrecognised — and every failure mode of that parse resolves to a *shorter* wait.**

Three independent ways a Devin seat gets a non-Devin gate:

1. **A stale command.** The companion plan documents two stores holding `startupCommands` that currently disagree; the workspace DB says `coder = agy` while the global file says Devin. A seat resolved from the stale value is classified `antigravity` → 8000ms, even if what actually ends up running is Devin.
2. **A wrapper or path.** `deriveCliIdentity` matches the *first token* only. `npx devin`, `env FOO=1 devin`, `bash -lc "devin …"`, or a shell alias all yield `unknown` → 8000ms. This is not hypothetical: the command in use is `devin --permission-mode bypass`, which parses correctly, but any wrapper an operator adds silently downgrades the seat.
3. **Frozen at spawn.** Correcting the command afterwards does not reclassify a live seat. It keeps the family it was born with for its whole life.

**And this is why the fixes have not taken.** Every previous fix has been applied to the *Devin arm* — raising `DEVIN_FIRST_READINESS_TIMEOUT_MS`, tuning `DEVIN_FIRST_READINESS_QUIET_MS`. A seat whose `cliFamily` is `antigravity` or `unknown` never enters that arm, so the fix is real, correct, and completely invisible to the seat that needs it. Nothing logs which family a seat resolved, so each attempt looks like it simply did not work.

**The failure is asymmetric and that matters.** Misclassifying Devin as anything else shortens the wait and breaks delivery. Misclassifying something else as Devin lengthens it and costs at most 12 seconds. The default for an unparseable command should therefore be the *longest* ceiling, not the shortest.

### Non-goals

- **Do not touch the confirm-Enter double CR.** It is unconditional and correct; the comment at `ptyPromptDelivery.ts:235-240` explains why, and re-gating it is the exact regression that comment exists to prevent.
- **Do not build a static list of CLI names to widen the match.** The same comment names that approach as the thing that failed. Widen the *fallback*, and detect at runtime; do not extend the roster.
- No change to `CHUNK_SIZE`, `CHUNK_DELAY_MS`, or `SUBMIT_SETTLE_MS`.

## Metadata

**Topic:** Readiness family follows the running CLI and a misclassification is visible
**Complexity:** 5
**Tags:** agents, terminals, reliability, prompt-delivery, bug
**Project:** Browser Switchboard

## User Review Required

None. The safe-default direction is settled above: an unrecognised command waits longer, never shorter.

## Complexity Audit

### Routine
- Logging the resolved `cliFamily` and the command it came from at spawn and at each delivery.
- Changing the `unknown` arm's constants.

### Complex / Risky
- **Changing the `unknown` default to the Devin ceiling slows every unrecognised seat's first prompt by up to 12 seconds.** That is the correct trade — the alternative is a broken delivery — but it is a real regression in feel for anyone running a CLI outside the three known names, and it must be stated, not slipped in. The quiet window (250ms) is what actually resolves most boots; the ceiling is only reached when the CLI emits nothing at all, so the practical cost is smaller than 12s in the common case. Measure it before and after rather than asserting it.
- **Re-deriving family on a live seat.** The honest fix for "frozen at spawn" is to re-derive when the underlying command changes, but a seat mid-delivery must not have its gate swapped underneath it. Re-derivation belongs at the start of a delivery, under the existing `withTerminalLock`, never asynchronously.
- **A runtime probe is tempting and out of scope.** Detecting the real CLI from its banner output would solve all three causes at once, and is a much larger piece of work with its own false-positive surface. This plan makes the static path safe and observable; a probe is a separate plan if the observability shows it is still needed.

## Edge-Case & Dependency Audit

**Race conditions:** `awaitFirstReadiness` resolves on the first quiet window after first output. A CLI that emits a banner, pauses past the quiet window, then opens its composer resolves early regardless of family — the ceiling is not the only path to a premature prompt. Logging must record which arm resolved (`signal` vs `timeout`) so the two are distinguishable in a report.

**Security:** Logging the startup command may record flags such as `--dangerously-skip-permissions`. Keep it to the local session log; do not surface it anywhere that leaves the machine.

**Side effects:** `cliFamily` also drives brand-icon selection via `deriveAgentDisplayName`. Changing how family is derived changes which icon a seat shows — verify the icons do not shift for correctly-classified seats.

**Dependencies & conflicts:** Shares `ptyFleetService.ts:437` with the companion plan, which adds provenance at the same line.

## Dependencies

- **`two-stores-hold-agent-startup-commands-and-they-disagree.md`** — records the resolved command and its source on the handle. This plan logs the family *alongside* that provenance; without it, a family report cannot say which store produced the string it parsed. Land it first.

## Adversarial Synthesis

Key risks: (1) re-fixing the confirm Enter, which is already unconditional and correct — explicitly forbidden above and asserted in verification; (2) widening `deriveCliIdentity`'s name list, repeating the static-list mistake its own comment documents — mitigation: the fallback changes, the roster does not; (3) changing the `unknown` default and treating the 12-second cost as free — mitigation: measure the delta and report it; (4) concluding the timing is fixed because Devin now works, while wrapper-launched seats stay misclassified and silent — mitigation: verification includes a wrapped command, which is the case no previous fix covered.

## Proposed Changes

**1. The unrecognised default becomes the longest ceiling (`clearReadiness.ts:352-358`).**

The `unknown` arm takes the Devin constants, not Claude's. Replace the comment's "conservative default" claim with the real reasoning: an unknown CLI is one whose boot time is unknown, and waiting too long costs seconds while waiting too little costs the whole delivery.

**2. Log the family, its source, and which arm resolved.**

At spawn: seat, role, resolved command, provenance (from the companion plan), derived family. At each delivery: the family used and whether `awaitFirstReadiness` returned `signal`, `timeout` or `exit`, with the elapsed time. This is what makes the next "the fix didn't take" report answerable in one log line.

**3. Re-derive at delivery, not only at spawn (`ptyPromptDelivery.ts:151-193`).**

Inside the existing lock, before the readiness gate, re-derive the family from the handle's current recorded startup command. A seat whose command was corrected after spawn picks up the right gate on its next prompt instead of staying wrong for its lifetime.

> **Clarification (not a new requirement):** Re-derivation re-runs `deriveCliFamily`, which still matches only three names. A wrapped command (`npx devin`, `bash -lc "devin"`) still derives `unknown` after re-derivation — the same result as at spawn. Re-derivation's value is picking up *corrected* commands (an operator fixes a stale command in Agent Setup), not *wrapped* ones. Change #1 (unknown → longest ceiling) makes the wrong answer safe for wrappers; a runtime probe is the fix for wrappers and is correctly deferred to a separate plan.

**4. Surface a mismatch.**

When a seat's derived family is `unknown`, show it in Agent Setup next to that seat with its command — an operator who has wrapped their CLI can see that Switchboard cannot identify it, rather than discovering it through a prompt that never submits.

## Verification Plan

1. Configure `coder` as `devin --permission-mode bypass`, start the Coding team, and confirm every coder seat logs `cliFamily: devin` and a `20000ms` ceiling. Standing orders submit — the text does not remain in the composer. This is the reported defect's gate.
2. Configure a coder as `npx devin --permission-mode bypass`. Pre-change it derives `unknown`; post-change it still derives `unknown` **but waits on the Devin ceiling**, and the standing orders submit. This is the case no earlier fix covered.
3. Read the delivery log for both: it names the family, the resolved arm (`signal`/`timeout`), and the elapsed ms.
4. Correct a live seat's role command in Agent Setup and dispatch to that seat again. The next delivery re-derives and uses the corrected family — the seat is not stuck with its spawn-time classification.
5. Regression: confirm `sendPromptToPty` still writes two carriage returns for every seat regardless of family. Assert on the write sequence, not on behaviour.
6. Regression: a Claude seat's first prompt is not slowed — `claude` still derives `claude` and keeps the 8000ms ceiling.
7. Measure the first-prompt latency for an unrecognised CLI before and after change 1, and report the delta. If the quiet window resolves it in the common case, the 12-second ceiling is rarely reached and the plan should say so.
8. Confirm brand icons are unchanged for `devin`, `claude` and `agy` seats.
9. Both hosts: run 1, 2 and 5 against the VS Code extension and the standalone host — the extension's delivery chokepoint is `sendRobustText`, the standalone's is `sendPromptToPty`, and the family derivation must be correct on both.

### Goal Invariants

- Assert `awaitFirstReadiness` with `family: 'unknown'` sets `ceilingMs === DEVIN_FIRST_READINESS_TIMEOUT_MS` (20000) and `quietMs === DEVIN_FIRST_READINESS_QUIET_MS` (250) — not `CLAUDE_FIRST_READINESS_TIMEOUT_MS` (8000).
- Assert `deriveCliFamily` is called inside `sendPromptToPty`'s `withTerminalLock` callback before the readiness gate, re-deriving from the handle's current startup command — not only at spawn in `ptyFleetService.ts`.
- Assert the spawn-time log line records: seat name, role, resolved startup command, provenance source (from companion plan), and derived `cliFamily`.
- Assert the delivery-time log line records: seat name, `cliFamily` used, readiness arm (`signal`/`timeout`/`exit`), and elapsed ms.
- Assert `sendPromptToPty` writes exactly two `\r` bytes for every family — the confirm-Enter sequence is unconditional and unchanged.
- Assert a seat whose `cliFamily` is `unknown` shows an indicator in Agent Setup next to its command field.

## Review Findings

Changes 1 and 3 landed correctly: the `unknown` arm of `awaitFirstReadiness` now takes Devin's 20 s ceiling and 250 ms quiet, the family is re-derived from `handle.startupCommand` inside `withTerminalLock` before the readiness gate, `deriveCliIdentity`'s roster was not widened, and the confirm-Enter double CR is untouched (`test:contract:pty-prompt-delivery-framing` asserts exactly two `handle.write('\r')`). The inbound field check passes: `startupCommand` and `startupCommandSource` are both set in the persisted handle literal at `ptyFleetService.ts:595` and re-recorded after injection at `:681`, so the spawn log's provenance is real and not a type-level claim. Two MAJOR gaps were unimplemented and are now fixed: there was **no delivery-time log** (the plan's Goal Invariant — the line that makes "the fix didn't take" answerable), so `sendPromptToPty` now logs seat, family used, readiness arm and elapsed ms immediately before the first paste byte; and **no unrecognised-family indicator in Agent Setup** (change 4), so the AGENTS tab now stamps an "Unrecognised CLI" chip beside any role startup-command field or custom-agent command whose first token is not a bare `devin`/`claude`/`agy`/`antigravity`, refreshed on every edit and on each `startupCommands` push. Files changed by this review: `src/standalone/ptyPromptDelivery.ts`, `src/webview/kanban.html`. Validation: `test:contract:clear-readiness` 16/16, `test:contract:pty-prompt-delivery-framing` 29/29, `test:contract:host-auto-clear` 18/18, `npx tsc --noEmit` clean apart from 5 pre-existing unrelated errors; measured latency for verification step 7 — an `unknown`-family first delivery with no output now resolves at 20 003 ms (was 8 s), and the delivery floor reports `floorMs=15000` on the same seat.

## Deferred Findings

- MAJOR — verification steps 1, 2, 4, 6, 8 and 9 are live-host runs (a real `devin --permission-mode bypass` seat, an `npx devin` seat, a corrected live command, icon parity, both hosts) and were NOT executed in this pass; the automated suites discriminate on the constants, the re-derivation site and the write sequence, not on a real CLI accepting a prompt.
- NIT — the webview's `agentsTabDeriveCliFamily` duplicates the three-name roster from `src/services/cliIdentity.ts:41-47`; it is presentation-only (it labels a field, never a timeout) but the two lists can drift if a fourth family is ever added (`src/webview/kanban.html:4543`).
- NIT — the dispatch curtain's `cliFamily` is read from `handle.cliFamily` at `bootstrap.ts:517`, *before* `sendPromptToPty` re-derives it, so a seat whose family is corrected on this delivery still shows the old CLI name on this one curtain.
