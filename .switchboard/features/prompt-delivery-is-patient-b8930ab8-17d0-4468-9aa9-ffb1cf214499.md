# Prompt delivery is patient

**Complexity:** 5

## Goal

A prompt must not land in a CLI that is not accepting input. Four loose plans converge on one rule: an unrecognised seat waits on the longest known ceiling rather than the shortest, that floor applies to every delivery and not just the first, and a configured delay is a floor rather than a replacement for readiness detection. Prerequisite outside the feature: the startup-command provenance plan, which supplies the command each seat actually ran.

## How the Subtasks Achieve This

- **A seat's CLI family is derived once at spawn and frozen**: Changes the `unknown` family fallback from Claude's 8s ceiling to Devin's 20s ceiling, so a misclassified seat waits longer (safe) instead of shorter (broken). Re-derives the family at each delivery from the handle's current startup command, so a corrected command picks up the right gate on the next prompt. Logs the family, its source, and which arm resolved at spawn and delivery, making misclassification observable instead of silent.
- **Prompt delivery should be patient, not precise**: Adds a flat per-delivery floor timer in `sendPromptToPty` so deliveries 2..N get a minimum wait even when `clearBeforePrompt` is off and no readiness gate runs. Makes the standing-orders relay awaitable at the clear callback in both hosts, serializing it against the next dispatch instead of racing. Replaces the flat 1500ms establish delay with a family-aware floor. Changes the `createClearReadinessTracker` unknown branch from 600ms to 15s. Defers the `awaitFirstReadiness` unknown-arm change to the frozen-family plan, which owns it.
- **A delay setting must not be able to defeat known-CLI readiness detection**: Deletes rule 4 in `resolvePtyClearPolicyFromExplicit` so a VS Code delay (`terminal.clearBeforePromptDelay`) stops flipping PTY seats to manual mode. Makes a configured delay a floor (`max(delay, readiness)`) instead of a replacement for known-family readiness detection in `createClearReadinessTracker`. Adds late-signal detection so a truncated clear is self-reporting.
- **Explain the seat-clear session-restart toll where seat CLIs are configured**: Adds a static informational note in the AGENTS tab next to the startup-command field, explaining that clearing a seat restarts its CLI session and OAuth-backed MCP servers prompt again. Pure copy — no runtime code, no behavioural change.

## Dependencies & sequencing (2026-09-04, Board Collapse 08)

**Prerequisite outside this feature:** *Two stores hold agent startup commands, they currently
disagree, and a spawned seat records no evidence of which one it read*. It stamps each seat with the
command it actually ran and which store answered, which is what makes a family re-derivation
possible. Land it first.

1. **A seat's CLI family is derived once at spawn and frozen** — owns the `clearReadiness.ts`
   unknown-arm change: an unrecognised family takes the **longest** known ceiling, not the shortest,
   because guessing short breaks delivery while guessing long costs seconds.
2. **Prompt delivery should be patient, not precise** — the per-delivery floor and the awaitable
   orientation relay. **Its duplicate edit of the same unknown arm is removed**; step 1 owns it.
   Both plans proposed the identical change to the same lines.
3. **A delay setting must not be able to defeat known-CLI readiness detection** — a configured delay
   is a floor, never a replacement.
4. **Explain the seat-clear session-restart toll where seat CLIs are configured** — static copy only,
   independent, land any time.

## Team Dispatch Instructions

### A seat's CLI family is derived once at spawn and frozen

- **Seat:** Lead Coder (complexity 5)
- **Acceptance:**
  - A `devin --permission-mode bypass` coder seat logs `cliFamily: devin` and a 20000ms ceiling; standing orders submit (text does not remain in composer).
  - An `npx devin` coder seat still derives `unknown` but waits on the Devin ceiling (20000ms); standing orders submit.
  - Correcting a live seat's command in Agent Setup and dispatching again re-derives the family on the next delivery.
  - `sendPromptToPty` still writes two `\r` bytes for every family — confirm-Enter sequence unchanged.
  - Both hosts: family derivation correct on extension and standalone.
- **Must not touch:** The confirm-Enter double-CR sequence (`ptyPromptDelivery.ts:256-259`), `CHUNK_SIZE`, `CHUNK_DELAY_MS`, `SUBMIT_SETTLE_MS`. Do not widen `deriveCliIdentity`'s name list — change the fallback, not the roster.

### Prompt delivery should be patient, not precise

- **Seat:** Lead Coder (complexity 5)
- **Acceptance:**
  - `done --from <seat>` with `clearBeforePrompt` off: next card's prompt not written until the floor has elapsed; standing orders not in flight concurrently.
  - `relayStartupOrientation` awaited at standalone clear callback (`bootstrap.ts:3318`); `cleared: true` does not return while relay is pending.
  - `_deliverStandingOrdersAfterClear` awaited at both `cleared: true` return points in `clearTerminalContext` (`:11327`, `:11372`).
  - Delivery #1 behaviour unchanged — `awaitFirstReadiness` already consumes `>= familyFloorMs`.
  - Bracketed-paste and double-CR sequence byte-for-byte identical before and after floor timer.
  - `ESTABLISH_ORDERS_READY_DELAY_MS` no longer appears as a bare flat wait on the send path.
- **Must not touch:** The confirm-Enter double-CR sequence, `CHUNK_SIZE`, `CHUNK_DELAY_MS`, `SUBMIT_SETTLE_MS`. Screen-state idle detection (parked plan `75b6017a`). The `awaitFirstReadiness` unknown-arm change — owned by the frozen-family plan. Creation-site callers of `relayStartupOrientation` (`:1884`, `:1897`, `:3183`, `:3657`) must remain fire-and-forget.

### A delay setting must not be able to defeat known-CLI readiness detection

- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - With legacy `terminal.clearBeforePromptDelay` set and no PTY mode chosen, a Devin clear runs the state machine to `signal` — not a 600ms `manual`.
  - With `mode: 'manual'` and 5000ms delay on a Devin seat, wait is at least 5000ms and still resolves on signal if it arrives later.
  - An `unknown`-family seat with an explicit delay behaves exactly as today — delay is the whole policy.
  - Explicit `0` is preserved and not read as unset.
  - A late ready signal (after `finish()`) is reported as `'late-signal'` on `terminalDispatchFinished`, not folded into `'fallback'`.
  - Both hosts: run 1-6 under extension and standalone policy resolvers.
- **Must not touch:** The Devin timings themselves (15s ceiling, 100ms quiet) — settled, unchanged. The Auto/Manual UI — ships and works. The `unknown` branch timeout value — owned by the patient-delivery plan.

### Explain the seat-clear session-restart toll where seat CLIs are configured

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - Note renders in AGENTS tab on both extension and standalone hosts, legible in light and dark themes.
  - A reader who has never seen the problem can answer "why does my agent keep asking me to log in?" from the note alone.
  - `git diff` touches only `src/webview/kanban.html` and a docs file — no `.ts` source files.
  - Note says "remove", never "disable". No specific CLI names.
  - No `confirm(`, `window.confirm`, or `showWarningMessage` in the diff.
- **Must not touch:** `TaskViewerProvider.ts`, `hostSeams.ts`, `cliIdentity.ts`, either composition root. The clear gating logic (`:1004-1010`). No runtime detection, no banner, no notification.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Explain the seat-clear session-restart toll where seat CLIs are configured](../plans/devin-clear-reauth-toll-visibility.md) — **PLAN REVIEWED** — ID: fe5daf69-426e-4b5a-92b0-da1df24fe6cd
- [ ] [A delay setting must not be able to defeat known-CLI readiness detection](../plans/a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness.md) — **PLAN REVIEWED** — ID: 4570333b-0cce-4e40-b8a0-8da118d86191
- [ ] [A seat's CLI family is derived once at spawn and frozen, so every Devin readiness fix silently misses any seat not classified as Devin](../plans/a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md) — **PLAN REVIEWED** — ID: d8f86774-a517-4040-b9aa-513decfaae17
- [ ] [Prompt delivery should be patient, not precise — an unknown seat gets the fastest profile and deliveries 2..N get no gate at all](../plans/prompt-delivery-should-be-patient-not-precise.md) — **PLAN REVIEWED** — ID: c11ab0cd-0370-44d8-a33d-58a875d2cd18
- [ ] [A Half-Delivered Dispatch Has No Safe Recovery — Retry Is the Only Lever, and It Destroys State](../plans/a-half-delivered-dispatch-has-no-safe-recovery-retry-is-the-only-lever-and-it-destroys-state.md) — **CREATED** — ID: ba068390-01cb-4832-a805-c924e2ccdc71
<!-- END SUBTASKS -->

