# The Startup Curtain Lifts Onto the Shell Banner It Exists to Hide

## Goal

The startup curtain stays up until the agent CLI has painted, instead of lifting during the silence between the shell prompt and the CLI's first frame.

### Problem analysis

**Observed, measured, not inferred.** On a Devin seat on this machine, timing every output frame from seat creation:

```
+2206ms   gap=2001ms   (silence after the bash prompt)
+4210ms   gap=2004ms   then: the Devin CLI banner
```

The shell prints its prompt within ~200 ms, then **nothing for two seconds**, then the CLI's first paint at **+4210 ms**.

**Both dismissal thresholds sit below that.** `terminals.js:258-260`:

- `CURTAIN_QUIET_MS = 1200` — *"LIVE output stopped this long => CLI has settled"*. At boot the first quiet period is not the CLI settling; it is the gap **before the CLI starts**. `bumpStartupCurtain` arms this on the shell prompt, it expires at ~2.2 s, and the curtain lifts onto the raw shell banner — precisely what it exists to hide, for the two seconds until the CLI paints.
- `CURTAIN_NO_OUTPUT_MS = 4000` — the backstop for a pane whose whole boot arrived as replay. Measured first paint is **4210 ms**, so on any boot at or slower than the one measured this cap *also* fires before the CLI appears. Two independent paths to the same wrong outcome.

`CURTAIN_MAX_MS = 15000` is fine and is not in scope.

**The quiet heuristic is sound; its trigger is not.** "Output went quiet, so the thing has settled" is only meaningful once the thing has *started*. Applied from the moment of the first shell byte, it measures the wrong silence.

**A larger constant is not the fix.** 2 s is what this machine produced for one CLI; a Raspberry Pi, a cold FS cache or a slower CLI will produce more. Any number chosen here is a guess that fails on the hardware this product targets.

**The signal already exists.** The dispatch curtain in this same file is already family-aware — its comment (`:263-270`) reasons in terms of *"the clear-readiness ceiling (15s)"*, *"awaitFirstReadiness (20s)"* and *"the per-delivery family floor"*. `clearReadiness.ts:77-82` holds the real numbers, resolved per family at `:415-428`:

| Family | First-readiness ceiling |
| :--- | :--- |
| `claude` | 8000 ms |
| `devin` | 20000 ms |
| `antigravity` | 8000 ms |
| unknown | the longest, per the repository's fallback rule |

The webview already carries `cliFamily` per seat (`terminals.js:1423`, `:2947`, `:3072`). The startup curtain is the one path that ignores it.

## Metadata

- **Complexity:** 3
- **Tags:** terminals, ui, bugfix, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. A family-derived minimum age, before any quiet dismissal

`armStartupCurtain(name, hasStartupCommand)` takes the seat's `cliFamily` and records a `notBefore` stamp: `armedAt + firstReadinessCeiling(family)`.

`bumpStartupCurtain` keeps its quiet timer, but a quiet expiry earlier than `notBefore` re-arms to the remainder instead of dismissing. Quiescence still decides *when* the curtain lifts; it can no longer decide it before the CLI could plausibly have painted.

**Reuse the shipped constants, do not restate them.** The values live in `clearReadiness.ts`. A second copy in the webview is a fork that will drift — and drift here is invisible, because both halves keep working while disagreeing.

**Unknown family takes the longest ceiling**, per the repository's fallback rule: guessing short strands the operator behind a raw shell, guessing long costs seconds of a curtain that was going to lift anyway.

### 2. Raise the no-output backstop above the measured first paint

`CURTAIN_NO_OUTPUT_MS = 4000` is 190 ms under the measured 4210 ms. It exists for a genuinely different case — a late-seated pane whose entire boot arrived as replay, with no live frame coming — so it must outlast a *normal* boot or it fires on the common path instead of the rare one.

Derive it from the same family ceiling plus a margin, rather than picking another literal.

### 3. Say why in the constants

Both constants read as self-evident and are not. Record the measurement (`prompt at ~200 ms, 2 s silence, first paint at ~4.2 s`) beside them, so the next reader knows the number has a boot profile behind it.

## Edge-Case & Dependency Audit

1. **A seat with no CLI.** `hasStartupCommand` already gates arming; a plain shell gets no curtain and none of this applies. Do not extend the minimum age to it — that is pure added latency over nothing.
2. **A CLI that fails to launch.** The minimum age must not become a floor on *failure*: `CURTAIN_MAX_MS` (15 s) still applies, and the exit/error dismissal paths must keep bypassing the minimum entirely, or a seat whose CLI died sits behind a curtain for the full Devin ceiling.
3. **Reattach.** Arming is deliberately not on "output arrived" (`:2655`) because a replay is indistinguishable from a boot burst. The minimum age must hang off the same arming decision, not off first output, or every reload curtains every pane for 20 s.
4. **Click-to-dismiss stays immediate.** The operator overrides the heuristic; the minimum age must not outrank an explicit click.
5. **Slower hardware is the target.** The measurement above is an x86 tower. A 4 GB Pi will be slower, which is the argument for the family ceiling over any literal — state it so nobody "optimises" it back to a constant.

## Verification Plan

1. On a Devin seat, the curtain is still up at 4.5 s and the shell banner is never visible; it lifts once the CLI has painted and gone quiet.
2. On a Claude seat the same holds against the 8 s ceiling — assert the two families genuinely differ rather than both taking one number.
3. A seat whose CLI exits immediately dismisses on the exit path, not after the family ceiling.
4. A reattach to an established seat does not arm a curtain at all.
5. A click dismisses instantly regardless of remaining minimum age.
6. A seat with no startup command gets no curtain, unchanged.
7. The webview reads the readiness ceilings from the shipped constants; assert no second copy of those numbers exists in `src/webview/`.
