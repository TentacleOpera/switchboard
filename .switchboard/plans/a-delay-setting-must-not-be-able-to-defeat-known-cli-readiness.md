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

`resolvePtyClearPolicyFromExplicit` (`ptyClearPolicy.ts:24`) infers manual mode from the mere
presence of a delay value:

| Rule | Condition | Result |
|---|---|---|
| 3 | no explicit mode + explicit `terminal.ptyClearBeforePromptDelay` | `{mode:'manual', source:'pty-explicit'}` |
| 4 | no explicit mode + explicit **legacy** `terminal.clearBeforePromptDelay` | `{mode:'manual', source:'legacy-explicit'}` |

and `createClearReadinessTracker` (`clearReadiness.ts:127`) checks mode **above** family:

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
shipped the escape: an explicit Auto radio (`kanban.html:7480`) that overrides the inference.

**Visibility is the wrong remedy for this failure.** The symptom is a Devin prompt landing
mid-clear — the operator sees a truncated dispatch, not a settings problem. Nothing in that
experience points at a delay slider, most of all when the value in force was set for VS Code
seats and possibly years earlier. Expecting the operator to connect those and choose Auto is
expecting them to diagnose the resolver. A correct default must not need that.

The escape hatch stays. It stops being the thing standing between a Devin seat and a truncated
clear.

## Implementation

### 1. Delete rule 4 — a VS Code delay must never govern PTY policy

Remove the `explicitLegacyDelay → {mode:'manual', source:'legacy-explicit'}` inference from
`resolvePtyClearPolicyFromExplicit`. `terminal.clearBeforePromptDelay` keeps governing VS Code
seats exactly as it does now; it stops being an input to PTY mode.

Keep `source` reporting so the UI can still show where a value came from, and keep the legacy
delay available as the *value* for PTY manual mode when manual is genuinely selected — the
plumbing that reads it stays, only the mode inference goes.

### 2. Make a delay a floor, not a replacement, for a known family

In `createClearReadinessTracker`, stop treating `mode === 'manual'` as a reason to skip the
family branch when the family is known. For a known family, run the state machine and resolve on
`max(configured delay, readiness outcome)` — the seat waits at least as long as the operator
asked, and never less than the CLI needs.

- `unknown` family is unchanged: there is no signal to wait for, so the delay is the whole
  policy. This is the case the delay was always for.
- An explicit `mode: 'manual'` on a known family is still honoured as a floor, not as a
  bypass. The operator's intent when typing a number is "wait at least this long", never "stop
  detecting whether the CLI is ready" — that reading is what produced this bug.
- Preserve explicit `0`, which the prior plan calls out as meaningful: a floor of zero is just
  the readiness result.

Decide this in one place. The mode/family precedence is the defect; two call sites resolving it
independently would reintroduce it.

### 3. Make a truncated clear observable instead of silent

When readiness resolves by floor/fallback and the CLI's ready signal arrives *after* the prompt
was written, that is direct evidence the wait was too short. Record it — the reason is already
carried on `terminalDispatchFinished` (`'signal' | 'fallback' | 'manual' | 'exit' | 'timeout'`),
so the shape exists. Surface a late signal distinctly rather than folding it into `fallback`.

This is the part that makes the class self-reporting. The operator could not have diagnosed this
one; the next one should not need diagnosing either.

### 4. Both hosts

The tracker is shared, but the policy resolvers are not:
`resolvePtyClearPolicy` (extension, `vscode.WorkspaceConfiguration`) and
`resolveStandalonePtyClearPolicy` both feed `resolvePtyClearPolicyFromExplicit`
(`ptyClearPolicy.ts:65`, `:103`). One shared helper, two callers — change the helper and check
both callers still pass what it now expects.

### Explicitly out of scope

- The Devin timings themselves (15s ceiling, 100ms quiet). Settled; unchanged.
- The Auto/Manual UI, which ships and works. This plan makes it unnecessary as a defence, not
  redundant as a control.
- `family === 'unknown'` on a seat whose CLI *is* known — a separate gap
  (`ptyHost.ts:291` passes no `cliFamily`, leaving delivery dependent on `handle.cliFamily`
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
7. A late ready signal (arriving after the prompt was written) is reported distinctly from
   `fallback` on `terminalDispatchFinished`.
8. Both hosts: run 1-6 under the extension and standalone policy resolvers.
9. `dispatch-curtain-and-ufo-contract.test.js` and the pty-clear-policy tests pass, extended for
   the new precedence. `npx tsc --noEmit -p tsconfig.json`.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, bugfix, ux
