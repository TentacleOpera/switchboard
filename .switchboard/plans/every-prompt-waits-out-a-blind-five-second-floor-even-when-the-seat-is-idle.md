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

**Where it comes from.** `prompt.go`:

```go
func familyFloor(family string) time.Duration {
    case "claude", "antigravity": return 3 * time.Second
    case "devin":                 return 15 * time.Second
    default:                      return 15 * time.Second
}
attendedFloorCap   = 5 * time.Second
unattendedFloorCap = 10 * time.Second
```

applied unconditionally before the first paste byte:

```go
if text != "" {
    floor := deliveryFloor(family, attended)
    if elapsed := time.Since(start); elapsed < floor {
        sleep(floor - elapsed)          // blind; nothing is consulted
    }
}
```

Nothing asks whether the seat is ready. It is a timer, and it runs in full whether the CLI is
mid-boot or has been parked at an empty prompt for ten minutes.

**The attendance cap is already working as designed.** The composer declares `attended: true`
(`terminals.js:6822`, `:12052`, `:12667`), so operator sends already take the 5 s cap rather
than the 10 s one. There is no bug there and no win available from it — 5 s *is* the fast path.

### Why the obvious fix does not work

The obvious move is to gate on output silence: `t.lastDataAt` is already maintained on every read
(`main.go:318`) and is what the activity light keys on. It does not work here, and the code
already says why (`clearReadinessWindows`, `prompt.go:63-78`):

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

## Metadata

- **Complexity:** 6
- **Tags:** pty-host, prompt-delivery, performance, reliability

## User Review Required

None.

## Proposed Changes

### 1. Content-based readiness: match the CLI's idle prompt

Add a per-family **idle-screen matcher** and consult it before falling through to the floor. A
seat whose visible pane matches its family's idle prompt is ready by observation, and delivery
proceeds immediately.

The host can already read the pane: in control mode it issues `capture-pane` for the history
fetch (`controlmode_io.go:282`) and routes the reply through the block FIFO, so a bounded
`capture-pane -p` for the visible screen is an existing mechanism, not a new one.

**Declared, never inferred** — the same rule the neighbouring tables already follow
(`clearStrategy`: *"the DECLARED per-family context-reset mechanism, never inferred from observed
behaviour"*). A family with no declared matcher gets no content check and pays the ceiling, which
is today's behaviour exactly.

Matching is on the **idle** state, not the busy state: assert what a ready prompt looks like
rather than enumerating the ways a CLI can be busy, because the busy set is open-ended and
getting it wrong resolves early — the expensive direction.

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

`ptyListTerminals` did not report a `cliFamily` for a live seat during this investigation
(`cliFamily=ABSENT`). That may be a projection gap rather than the host's internal value being
empty — **establish which before changing anything**, because the two have different fixes and
the wrong one is wasted work. If the host's `t.cliFamily` is genuinely empty for seats whose
startup command plainly names a CLI, that is a separate defect this plan should surface rather
than paper over with a longer default.

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
  it should approach.
- A send to a seat that is mid-paint still waits, and the prompt still arrives intact. Verified by
  sending during a known repaint, not by reasoning about it.
- No send resolves ready on a screen that does not match a declared idle prompt.
- An unresolved family behaves exactly as today: full ceiling, no content check.
- The delivery receipt names the family and the arm that resolved, so the next person to ask "why
  was that slow" reads it instead of measuring it.
