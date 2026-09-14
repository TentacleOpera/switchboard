# Every Prompt Waits Out a Blind Five-Second Floor, Even When the Seat Is Idle

## Goal

A prompt sent to a seat that is sitting idle at its prompt is delivered in well under a second.
The long wait is kept for the case it was written for — a CLI that has not finished painting —
and is reached by observing the seat rather than by sleeping a fixed amount every time.

### Problem analysis

**Measured on this host, 2026-09-12, against live `devin` seats on the running board:**

| Send | Elapsed |
| :--- | ---: |
| attended (`attended: true`) | **5664 / 5620 / 5622 ms** |
| unattended | **10660 / 10630 ms** |
| CLI round-trip floor (send to a non-existent seat) | 343 ms |

The last row is the control: ~330 ms is what a `switchboard verb` round trip costs before any
delivery logic runs. So the delivery itself is adding **~5.3 seconds to every attended send**,
and it does so on the second and third send exactly as much as the first — this is not a
cold-start cost that warms up.

For a four-seat team that is ~21 seconds of pure waiting per round of dispatches.

> **Update (2026-09-13, post-measurement):** The first sentence of the Goal — "idle seat
> delivered in well under a second" — is now **achieved for the non-cleared case** by the
> stopgap commit `ba7d2f28` (landed 2026-09-13 16:52, ~17h after this plan was written). The
> delivery floor is now gated on `cleared`, so a send to a seat that was NOT just cleared
> skips the floor entirely. The measurement above was taken against the pre-stopgap code
> where the floor applied to every send unconditionally; it would not reproduce the same way
> today for a non-cleared seat. **The remaining work this plan covers is the second sentence:
> the cleared/boot case still waits a blind floor, and should wait observantly instead.**

**Where it comes from.** `prompt.go`:

> **Superseded:** The code below showed the pre-stopgap condition.
> ```go
> if text != "" {
>     floor := deliveryFloor(family, attended)
>     if elapsed := time.Since(start); elapsed < floor {
>         sleep(floor - elapsed)          // blind; nothing is consulted
>     }
> }
> ```
> **Reason:** Commit `ba7d2f28` ("the delivery floor applies only to a send that follows a
> clear") gated this on `cleared`. The floor now runs only after a `/clear` (which restarts
> the CLI's session), not on every send. The blind `sleep` still exists inside that gate —
> it is the remaining target of this plan.
> **Replaced with** (`prompt.go:343-348`):
> ```go
> if text != "" && cleared {
>     floor := deliveryFloor(family, attended)
>     if elapsed := time.Since(start); elapsed < floor {
>         sleep(floor - elapsed)
>     }
> }
> ```

Nothing asks whether the seat is ready. It is a timer, and it runs in full whether the CLI is
mid-boot or has been parked at an empty prompt for ten minutes — **for the cleared case**.
For the non-cleared case the stopgap removed it entirely.

**The attendance cap is already working as designed.** The composer declares `attended: true`
(`terminals.js:6952`, `:12040`, `:12659`), so operator sends already take the 5 s cap rather
than the 10 s one. There is no bug there and no win available from it — 5 s *is* the fast path
for a cleared attended send.

### Why the obvious fix does not work

The obvious move is to gate on output silence: `t.lastDataAt` is already maintained on every read
(`main.go:417` and `:1128`) and is what the activity light keys on. It does not work here, and the
code already says why (`clearReadinessWindows`, `prompt.go:63-78`):

> devin emits ~12 content-free redraw frames per second — a frame every ~82ms — so a window near
> that interval fires in an ordinary gap between two redraws and calls a repainting editor ready.
> 1500ms is ~18 frames of margin, which means the quiet branch **effectively does not fire on a
> live seat and the ceiling becomes the real timer**.

So for devin the existing quiet window is deliberately set so that it never fires. Silence is not
a readiness signal for a CLI that repaints continuously, and any plan built on it reproduces the
bug it is trying to fix.

**And the cost of resolving early is recorded, not hypothetical.** From the same comment:

> Resolving early pastes into an editor that has not finished repainting; the prompt is lost, the
> receipt still says success, and the lead blocks on a callback that never comes — ~55 minutes on
> Coding-coder-1, 2026-09-12.

That is the failure this floor exists to prevent, it happened today, and it must not be
reintroduced in exchange for five seconds.

### Root cause

Readiness is inferred from elapsed time because no cheaper signal was available that survives a
redraw loop. Silence was tried and had to be tuned until it stopped firing. What was never tried
is asking what the pane actually *shows* — a CLI parked at its prompt renders a different screen
from one that is still painting, and that difference is observable.

**What already exists that this plan builds beside.** The cleared path is not purely blind:
`waitReadiness` (`prompt.go:160-224`) already runs after `/clear`, with a quiet window and — for
devin — a `devinReady` escape-sequence predicate (`prompt.go:144-152`) that matches bracketed-paste
mode re-enablement. The blind floor at `:343-348` is a **backstop on top of** that observational
wait, not the only gate. This plan's content-based idle-screen matcher is a third signal that can
short-circuit the backstop; it does not replace `waitReadiness` or `devinReady`.

### Non-goals

- **Shortening the floor by guessing.** Lowering 15 s to a smaller constant is the change this
  plan exists to avoid. If readiness cannot be established, the full ceiling must still be paid.
- **Changing the attendance caps.** They are working and the composer already declares
  attendance.
- **Touching claude/antigravity timings.** At 3 s they sit below both caps and are not the
  complaint. They benefit incidentally if readiness resolves sooner, and must not regress.
- **Re-tuning the quiet windows.** `clearReadinessWindows` is the post-clear policy and its
  values were chosen against measured frame rates. This plan adds a signal beside it; it does not
  re-open those numbers.
- **Re-opening the `cleared` gate.** The stopgap (`ba7d2f28`) is correct and pinned by
  `TestFloorAppliesOnlyAfterAClear`. This plan does not un-gate the floor; it makes the gated
  wait observant.

## Metadata

**Feature:** 1797113d-a0e7-4ad6-99f3-dd8886223ab6
- **Complexity:** 6
- **Tags:** backend, performance, reliability, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- Declaring a per-family idle-prompt pattern table (a `switch` on family, mirroring
  `clearReadinessWindows` and `clearStrategy`).
- Surfacing the resolved family and the resolving arm in the delivery receipt — the receipt
  already carries a `readiness` map (`prompt.go:255`, assembled into `out` at `:432-435`); adding
  two keys is a one-line extension.
- Setting `t.cliFamily` from the create payload so `ptyListTerminals` reports it (one line in the
  constructor, `main.go:325-359`).

### Complex / Risky

- **Synchronous `capture-pane` for the visible screen is new plumbing, not an existing call.**
  The host issues `capture-pane` for scrollback (`-peqJN -S -50000 -E -1`) and the pending
  fragment (`-p -P -C`) via `sendHistoryFetchLocked` (`controlmode_io.go:288-306`), routing replies
  through the `pendingBlocks` FIFO (`blockScrollback`, `blockPending`). A visible-screen capture
  (`capture-pane -p` without `-S`/`-E`) needs a **new block kind**, a push onto `pendingBlocks`,
  and a synchronous wait for the reply — the `waitReadiness` subscription channel reads pty output
  chunks, not capture-pane block replies, so the two paths do not share a wait mechanism.
- **Idle-prompt matching against a continuously-redrawing CLI.** Devin redraws ~12 frames/s even
  at idle; a single `capture-pane` snapshot may catch a mid-redraw frame. The matcher must be
  robust to partial repaints or it resolves early — the expensive direction that cost 55 minutes.
- **`t.cliFamily` is never set in the Go host.** The constructor (`main.go:325-359`) does not read
  `cliFamily` from the payload; the field stays the Go zero value (empty string). The TS side
  derives it (`ptyFleetService.ts:645`) and passes it at delivery time (`main.go:1491`), but never
  at create time. Fixing this touches both the Go constructor and the TS create-payload assembly.

## Edge-Case & Dependency Audit

- **Race Conditions:** A `capture-pane` issued during a redraw may return a partial frame. The
  matcher must either retry on no-match (within the floor ceiling) or match on a stable substring
  (e.g. the prompt line) rather than exact-screen equality. The floor ceiling is the backstop, so
  a failed match never resolves early — it falls through to today's behaviour.
- **Security:** No new attack surface. `capture-pane` reads the seat's own pane; the matcher is a
  read-only string comparison.
- **Side Effects:** The idle-screen check must not consume/route the capture-pane reply to the
  browser (it is a readiness probe, not a history fetch). A new `blockKind` that is parsed and
  discarded — not routed to consumers — prevents the reply from appearing as a spurious screen
  update in the webview.
- **Dependencies & Conflicts:** The `cleared` gate (`ba7d2f28`) and `TestFloorAppliesOnlyAfterAClear`
  must stay intact. `waitReadiness` and `devinReady` are not modified — the new matcher runs
  alongside them. The `cliFamily` fix interacts with the plan
  `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md` (the TS-side
  re-derivation at `ptyPromptDelivery.ts:288-292`); the Go-side `t.cliFamily` should be set once at
  create and not re-derived, matching the "frozen at spawn" contract.

## Dependencies

- `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md` — the TS-side
  `cliFamily` derivation and re-derivation contract. The Go-side `t.cliFamily` set-at-create must
  agree with the value the TS side derives, or the projection and the delivery arm disagree.

## Resolved Assumptions

- **"Is `ptyListTerminals`'s `cliFamily=ABSENT` a projection gap or an empty host value?"** —
  Resolved by code investigation (2026-09-14): it is the **host's internal value being empty**.
  The Go constructor (`main.go:325-359`) never reads `cliFamily` from the create payload; the
  struct field stays `""`. The projection at `main.go:232` faithfully reports the empty value.
  The TS side derives `cliFamily` (`ptyFleetService.ts:645`) and passes it at delivery time
  (`main.go:1491`: `strField(payload, "cliFamily")`), but not at create time. The fix is to set
  `t.cliFamily` in the constructor from the payload (and ensure the create payload carries it).

## Adversarial Synthesis

Key risks: (1) a `capture-pane` snapshot catching a mid-redraw frame resolves early and
reproduces the 55-minute stall; (2) the new block-kind plumbing for a synchronous visible-screen
capture is more work than the plan's "existing mechanism" language implies; (3) setting
`t.cliFamily` at create without aligning the TS create payload leaves the field empty and the fix
is a no-op. Mitigations: the matcher only ever shortens (floor ceiling is the backstop, so a
no-match is today's behaviour exactly); the mid-paint test (Verification Plan #2) must assert a
repainting screen does NOT match; the `cliFamily` fix touches both the Go constructor and the TS
create-payload assembly in one diff.

## Proposed Changes

### 1. Content-based readiness: match the CLI's idle prompt

Add a per-family **idle-screen matcher** and consult it before falling through to the floor. A
seat whose visible pane matches its family's idle prompt is ready by observation, and delivery
proceeds immediately.

The host can already read the pane: in control mode it issues `capture-pane` for the history
fetch (`controlmode_io.go:288-306`) and routes the reply through the `pendingBlocks` block FIFO.
A bounded `capture-pane -p` for the visible screen reuses the `writeControlCommandLocked`
infrastructure but requires a **new `blockKind`** (e.g. `blockVisibleScreen`) and a synchronous
wait for the reply — this is new plumbing on top of an existing mechanism, not a call that exists
today.

**Declared, never inferred** — the same rule the neighbouring tables already follow
(`clearStrategy`: *"the DECLARED per-family context-reset mechanism, never inferred from observed
behaviour"*). A family with no declared matcher gets no content check and pays the ceiling, which
is today's behaviour exactly.

Matching is on the **idle** state, not the busy state: assert what a ready prompt looks like
rather than enumerating the ways a CLI can be busy, because the busy set is open-ended and
getting it wrong resolves early — the expensive direction.

**Integration point.** The matcher runs in the post-clear path, **after** `waitReadiness` resolves
and **in place of** the blind floor sleep (`prompt.go:343-348`). The restructured wait:

```
if text != "" && cleared {
    floor := deliveryFloor(family, attended)
    if matched := idleScreenMatches(t, family); matched {
        // ready by observation — proceed to paste
    } else if elapsed := time.Since(start); elapsed < floor {
        waitUntil(floor - elapsed, idleScreenProbe(t, family))  // poll the screen, fall through on floor
    }
}
```

The `idleScreenProbe` issues a `capture-pane -p` on a short interval (e.g. 500ms) and checks the
reply against the family's declared idle pattern. On match, the wait returns early; on the floor
ceiling, it falls through — today's behaviour exactly.

### 2. The floor becomes a ceiling, never a target

Restructure the wait so the floor is the upper bound:

```
wait until (idle-screen matched) OR (floor elapsed)
```

Content match only ever **shortens**. If the matcher does not fire — unknown family, unmatched
screen, capture failed, control mode not active — the wait is exactly what it is today. There is
no path in which this plan makes a send slower or resolves sooner than the evidence supports.

### 3. Resolve the CLI family for a seat, and prove it is resolved

`familyFloor`'s `default` arm is 15 s, so a seat whose family does not resolve is treated as
devin. That is the correct conservative default and must stay — but it means an unresolved
**claude** seat silently pays 15 s instead of 3 s, and nothing reports it.

> **Resolved (2026-09-14):** `ptyListTerminals` reported `cliFamily=ABSENT` because the Go host's
> `t.cliFamily` is **never set** — the constructor (`main.go:325-359`) does not read it from the
> payload. This is the host's internal value being empty, not a projection gap. The TS side
> derives `cliFamily` (`ptyFleetService.ts:645`) and passes it at delivery (`main.go:1491`) but
> not at create. See `## Resolved Assumptions` above.

The fix: set `t.cliFamily = strField(payload, "cliFamily")` in the Go constructor, and ensure the
TS create-payload assembly includes `cliFamily` (it currently includes `startupCommand` and
`startupCommandInner` but not `cliFamily`). This is a two-file change: `main.go` (constructor)
and the TS side that builds the create payload (`ptyFleetService.ts` / `bootstrap.ts`).

Whatever the answer: the resolved family must be **visible** — in `ptyListTerminals` and in the
delivery receipt — so "why did this send take 15 seconds" is answerable after the fact instead of
by re-deriving it from the source. The receipt already carries a `readiness` map
(`prompt.go:255`); the family and which arm resolved belong in it.

## Verification Plan

### Automated Tests

1. **New** `src/test/prompt-delivery-readiness-contract.test.js`, wired as
   `test:contract:prompt-readiness` **and invoked from `.github/workflows/integration-tests.yml`**
   — defined-but-not-invoked is not a gate. Asserts: an idle-screen match resolves delivery
   before the family floor; a non-matching screen waits the full floor; an unknown family takes
   the ceiling unchanged.
2. **Go test** over the matcher itself, against captured pane fixtures for each declared family —
   an idle screen and a mid-paint screen — asserting the mid-paint screen does **not** match.
   This is the test that protects against the 55-minute failure: it must be impossible for a
   repainting screen to read as ready.
3. Assert `familyFloor`'s default arm is still 15 s and still shared with devin — a future edit
   that "tidies" the default to 0 reintroduces the original bug silently.
4. Regression: `test:contract:pty-prompt-delivery-framing`, `test:contract:pty-clear-policy`,
   `test:contract:pty-host-blackbox`, `go test ./cmd/...`.

### Goal Invariants

- A send to a seat parked at its idle prompt completes in **under 1 second**, measured end to end
  the same way the 5664 ms figure above was measured — the CLI round trip (~330 ms) is the floor
  it should approach. (For the non-cleared case this is already met by the `cleared` gate; this
  plan extends it to the cleared case via observational readiness.)
- A send to a seat that is mid-paint still waits, and the prompt still arrives intact. Verified by
  sending during a known repaint, not by reasoning about it.
- No send resolves ready on a screen that does not match a declared idle prompt.
- An unresolved family behaves exactly as today: full ceiling, no content check.
- The delivery receipt names the family and the arm that resolved, so the next person to ask "why
  was that slow" reads it instead of measuring it.
- `t.cliFamily` is non-empty for any seat whose create payload carried a family; `ptyListTerminals`
  reports it.
