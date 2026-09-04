# A delay setting must not be able to defeat known-CLI readiness detection

## Goal

Make a configured clear delay a **floor**, never a replacement, and stop a VS Code delay from
governing PTY seats at all. A number set for one delivery path must not be able to truncate
Devin's clear on another.

**This does not reopen the timing decision.** `dispatch-preparation-curtain-and-themed-ufo.md`
settled that a known CLI gets signal-based readiness with a 15s ceiling, and that is correct and
unchanged here. What changes is what a delay setting is *allowed to do* to it.

### The problem

A Devin seat's clear is truncated: the curtain shows for about half a second, the prompt is
pasted, and it does not survive Devin's longer clear. The 600ms in play was never meant to
override Devin's readiness wait.

### Root cause — compatibility inference lets a delay silently replace readiness

`resolvePtyClearPolicyFromExplicit` (`src/services/ptyClearPolicy.ts:24`) infers manual mode from the mere
presence of a delay value:

| Rule | Condition | Result |
|---|---|---|
| 3 | no explicit mode + explicit `terminal.ptyClearBeforePromptDelay` | `{mode:'manual', source:'pty-explicit'}` |
| 4 | no explicit mode + explicit **legacy** `terminal.clearBeforePromptDelay` | `{mode:'manual', source:'legacy-explicit'}` |

and `createClearReadinessTracker` (`clearReadiness.ts:166`) checks mode **above** family:

```ts
if (mode === 'manual') { mainTimer = setTimeout(() => finish('manual'), fallbackDelay); return ...; }
const family = options?.cliFamily || target.cliFamily || 'unknown';
if (family === 'devin') { /* the 15s signal state machine */ }
```

So manual short-circuits before Devin's state machine is ever consulted, and the seat gets a
blind `fallbackDelay` — `DEFAULT_CLEAR_SETTLE_MS`/`DEFAULT_FALLBACK_DELAY_MS`, both 600.

**Rule 4 is the sharpest edge.** `terminal.clearBeforePromptDelay` is the *VS Code* seat delay,
and it exists because — in the words of `expose-pty-clear-delay-in-kanban-setup-ui.md`'s own
user-review note — *"VS Code terminals still need a fixed delay because clear completion cannot
be observed there, while PTY known-CLI profiles should use readiness detection unless manually
overridden."* Rule 4 takes that VS Code number and uses it to switch PTY seats off readiness
detection. The operator set a delay for a path where nothing can be observed, and it disabled
observation on the path where it can.

### Why the existing mitigation is not enough

That plan already saw this trap. Its Goal is *"make the effective compatibility source visible
instead of allowing a 600ms slider to silently defeat known-CLI readiness detection"*, and it
shipped the escape: an explicit Auto radio (`kanban.html:3127`) that overrides the inference.

**Visibility is the wrong remedy for this failure.** The symptom is a Devin prompt landing
mid-clear — the operator sees a truncated dispatch, not a settings problem. Nothing in that
experience points at a delay slider, most of all when the value in force was set for VS Code
seats and possibly years earlier. Expecting the operator to connect those and choose Auto is
expecting them to diagnose the resolver. A correct default must not need that.

The escape hatch stays. It stops being the thing standing between a Devin seat and a truncated
clear.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, bugfix, ux
**Project:** Browser Switchboard

## User Review Required

None. The safe-default direction is settled: a delay is a floor, never a bypass. Rule 4 deletion
is a strict narrowing — a VS Code setting stops affecting PTY seats, which is the documented intent.

## Complexity Audit

### Routine
- Deleting rule 4 from `resolvePtyClearPolicyFromExplicit` — removing one `if` branch.
- Keeping `source` reporting and the legacy delay value plumbing intact.
- Extending the pty-clear-policy tests for the removed inference.

### Complex / Risky
- **Changing the mode/family precedence in `createClearReadinessTracker`.** The current code short-circuits on `mode === 'manual'` before consulting family. The fix makes a known family always run its state machine, with the delay as a floor via `max(configured delay, readiness outcome)`. This changes the resolution semantics for every manual-mode known-family seat — the delay stops being the whole wait and becomes a minimum. The resolution logic must live in `createClearReadinessTracker` itself (the one place the mode/family precedence is decided), not in the caller.
- **Late-signal detection.** After the tracker resolves (via floor/fallback/timeout), a ready signal may still arrive. Detecting this requires the `onData` subscription to remain active past `finish()` — or a separate post-resolution listener. The boundary for "late" is: any ready signal arriving after `finish()` has been called, regardless of margin. The tracker must record this as a distinct reason (e.g. `'late-signal'`) on `terminalDispatchFinished` rather than folding it into `fallback`.

## Edge-Case & Dependency Audit

**Race conditions:**
- The floor timer and the state machine run concurrently inside `createClearReadinessTracker`. The state machine may resolve `signal` before the floor elapses; in that case the floor must still be honoured — the tracker waits the remaining floor time before resolving. If the floor elapses first, the tracker resolves on `fallback` but keeps the `onData` subscription alive to detect a late signal.
- A seat that exits during the floor wait: the existing `onExit` listener fires `finish('exit')`, which must override the floor — an exited seat has nothing to wait for.

**Security:**
- No new attack surface. The change affects timing, not content.

**Side effects:**
- A manual-mode known-family seat that previously resolved in 600ms now waits at least the state machine's resolution time (up to 15s for devin). This is the intended fix but is a visible latency change for any operator who set a manual delay on a known-CLI seat.
- Rule 4 deletion means `terminal.clearBeforePromptDelay` no longer appears in PTY policy source reporting. The UI's source label for PTY seats will never show `legacy-explicit` again. This is correct but may surprise an operator who previously saw it.

**Dependencies & conflicts:**
- `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md` — changes the `unknown` arm's timeout in `createClearReadinessTracker` from `fallbackDelay` (600ms) to `DEVIN_DEFAULT_TIMEOUT_MS` (15000ms). This plan's floor logic and the frozen-family plan's timeout change both touch the `unknown` branch. They are compatible: the frozen-family plan changes the *value*, this plan changes the *precedence* (manual no longer short-circuits for known families). For `unknown` family, this plan's change is a no-op — "unknown family is unchanged: the delay is the whole policy." Land the frozen-family plan first.
- `prompt-delivery-should-be-patient-not-precise.md` — adds a flat floor timer in `sendPromptToPty`. This plan's floor is in `createClearReadinessTracker` (the clear path); the patient-delivery plan's floor is in `sendPromptToPty` (the delivery path). They are additive, not conflicting: a clear-path seat waits `max(delay, readiness)` in the tracker, then the delivery floor applies on top.

## Dependencies

- `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md` — changes the `unknown` branch timeout in `createClearReadinessTracker`. Land first; this plan's floor logic is compatible with the new timeout but should be coded against the post-frozen-family state.
- `dispatch-preparation-curtain-and-themed-ufo.md` — settled the 15s ceiling for known CLIs. Not a dependency; a constraint this plan does not reopen.

## Adversarial Synthesis

Key risks: (1) the floor-as-max resolution is underspecified — it must live in `createClearReadinessTracker`, not the caller, or two sites resolving independently reintroduce the defect; (2) late-signal detection requires the `onData` subscription to outlive `finish()`, which is a lifecycle change to the tracker — the subscription must be torn down after the late-signal window closes, not left dangling; (3) rule 4 deletion narrows PTY policy correctly but removes a source label the UI previously showed, which is a visible change. Mitigations: one resolution site; explicit late-signal teardown; the UI source label change is correct and expected.

## Proposed Changes

### `src/services/ptyClearPolicy.ts`

**Context.** `resolvePtyClearPolicyFromExplicit` (`:24`) is the one precedence rule shared by both hosts. Rule 4 (`:48-49`) infers manual mode from the legacy VS Code delay.

**Logic — delete rule 4.** Remove the `explicitLegacyDelay → {mode:'manual', source:'legacy-explicit'}` inference. `terminal.clearBeforePromptDelay` keeps governing VS Code seats via `resolvePtyClearDelay` and the extension host's `clearTerminalContext`; it stops being an input to PTY mode.

Keep `source` reporting so the UI can still show where a value came from, and keep the legacy
delay available as the *value* for PTY manual mode when manual is genuinely selected — the
plumbing that reads it stays, only the mode inference goes.

**Edge cases.** An operator who previously relied on rule 4 (setting only `terminal.clearBeforePromptDelay` and expecting PTY manual mode) will see their PTY seats switch to Auto. This is the correct behaviour — the delay was never meant to govern PTY readiness — but the change is silent. The UI's source label will show `default` instead of `legacy-explicit`.

### `src/standalone/clearReadiness.ts`

**Context.** `createClearReadinessTracker` (`:96`) is where mode/family precedence is decided. The mode check at `:166` short-circuits before the family branch at `:171`.

**Logic — make a delay a floor, not a replacement, for a known family.** In `createClearReadinessTracker`, stop treating `mode === 'manual'` as a reason to skip the family branch when the family is known. For a known family (`devin`, `claude`, `antigravity`), run the state machine and resolve on `max(configured delay, readiness outcome)` — the seat waits at least as long as the operator asked, and never less than the CLI needs.

Implementation: after the family branch resolves (via `signal` or `fallback`), check whether the configured delay has elapsed. If not, wait the remaining time before resolving the tracker's promise. This keeps the resolution in one place — `createClearReadinessTracker` itself.

- `unknown` family is unchanged: there is no signal to wait for, so the delay is the whole
  policy. This is the case the delay was always for.
- An explicit `mode: 'manual'` on a known family is still honoured as a floor, not as a
  bypass. The operator's intent when typing a number is "wait at least this long", never "stop
  detecting whether the CLI is ready" — that reading is what produced this bug.
- Preserve explicit `0`, which the prior plan calls out as meaningful: a floor of zero is just
  the readiness result.

**Logic — make a truncated clear observable.** When readiness resolves by floor/fallback and the CLI's ready signal arrives *after* the tracker has already called `finish()`, that is direct evidence the wait was too short. The `onData` subscription must remain active past `finish()` for a brief late-signal window (the same `quietMs` the family branch uses). If a ready signal arrives in that window, record it as a distinct reason `'late-signal'` on `terminalDispatchFinished` (`'signal' | 'fallback' | 'manual' | 'exit' | 'timeout' | 'late-signal'`), rather than folding it into `fallback`. After the late-signal window closes, tear down the subscription.

This is the part that makes the class self-reporting. The operator could not have diagnosed this
one; the next one should not need diagnosing either.

### Both hosts

The tracker is shared, but the policy resolvers are not:
`resolvePtyClearPolicy` (extension, `vscode.WorkspaceConfiguration`) and
`resolveStandalonePtyClearPolicy` both feed `resolvePtyClearPolicyFromExplicit`
(`src/services/ptyClearPolicy.ts:65`, `:103`). One shared helper, two callers — change the helper and check
both callers still pass what it now expects.

### Explicitly out of scope

- The Devin timings themselves (15s ceiling, 100ms quiet). Settled; unchanged.
- The Auto/Manual UI, which ships and works. This plan makes it unnecessary as a defence, not
  redundant as a control.
- `family === 'unknown'` on a seat whose CLI *is* known — a separate gap
  (`ptyHost.ts:183` passes `cliFamily` from the handle, leaving delivery dependent on `handle.cliFamily`
  from `deriveCliFamily(startupCommand)` at seat creation). Related symptom, different cause;
  worth its own plan.

## Verification Plan

1. With the legacy `terminal.clearBeforePromptDelay` explicitly set and no PTY mode chosen, a
   Devin seat's clear runs the state machine to a real `signal` — not a 600ms `manual`. This is
   the reported bug; capture it failing on current `main` first.
2. With `terminal.ptyClearBeforePromptDelay` set to 600 and no mode chosen, a Devin clear still
   waits for the signal, and waits at least 600ms.
3. With an explicit `mode: 'manual'` and a 5000ms delay on a Devin seat, the wait is at least
   5000ms and still resolves on the signal if it arrives later.
4. An `unknown`-family seat with an explicit delay behaves exactly as today — the delay is the
   whole policy.
5. Explicit `0` is preserved and is not read as unset.
6. A VS Code seat's delay behaviour is unchanged by any of the above.
7. A late ready signal (arriving after the tracker has called `finish()`) is reported distinctly from
   `fallback` on `terminalDispatchFinished` as `'late-signal'`.
8. Both hosts: run 1-6 under the extension and standalone policy resolvers.
9. `dispatch-curtain-and-ufo-contract.test.js` and the pty-clear-policy tests pass, extended for
   the new precedence. `npx tsc --noEmit -p tsconfig.json`.

### Goal Invariants

- Assert `resolvePtyClearPolicyFromExplicit` with `explicitMode: undefined`, `explicitPtyDelay: undefined`, `explicitLegacyDelay: 2000` returns `{ mode: 'auto', ... }` — NOT `{ mode: 'manual', source: 'legacy-explicit' }`. Rule 4 is gone.
- Assert `createClearReadinessTracker` with `mode: 'manual'` and `cliFamily: 'devin'` runs the devin state machine (subscribes to `onData`) — does NOT short-circuit with a flat `fallbackDelay` timer.
- Assert `createClearReadinessTracker` with `mode: 'manual'`, `cliFamily: 'devin'`, and `fallbackDelayMs: 5000` waits at least 5000ms before resolving, even if the signal arrives at 3s.
- Assert `createClearReadinessTracker` with `mode: 'manual'` and `cliFamily: 'unknown'` still uses a flat `fallbackDelay` timer — the delay is the whole policy for unknown.
- Assert `createClearReadinessTracker` with `fallbackDelayMs: 0` does not add any floor wait — explicit zero is preserved.
- Assert a ready signal arriving after `finish()` was called is recorded as `'late-signal'` on `terminalDispatchFinished`, not folded into `'fallback'`.
