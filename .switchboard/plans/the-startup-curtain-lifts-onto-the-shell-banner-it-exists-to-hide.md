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

**One dismissal threshold sits below that, not two.** `terminals.js:304-307`:

- `CURTAIN_QUIET_MS = 1200` — *"LIVE output stopped this long => CLI has settled"*. At boot the first quiet period is not the CLI settling; it is the gap **before the CLI starts**. `bumpStartupCurtain` arms this on the shell prompt (the first live output at ~200 ms), it expires at ~3.4 s (200 + 1200 + subsequent bumps from shell output), and the curtain lifts onto the raw shell banner — precisely what it exists to hide, for the two seconds until the CLI paints.

- `CURTAIN_NO_OUTPUT_MS = 4000` — the backstop for a pane whose whole boot arrived as replay. This fires only when `!s.sawLiveOutput` (`:2821`), and the shell prompt at ~200 ms sets `sawLiveOutput = true` (`:2872`). So in the **normal boot case, the no-output timer is a no-op** — it never fires. It is NOT a second path to the wrong outcome.

> **Superseded:** The original analysis stated: "Two independent paths to the same wrong
> outcome" — claiming both `CURTAIN_QUIET_MS` and `CURTAIN_NO_OUTPUT_MS` fire before the CLI
> appears.
> **Reason:** The no-output timer fires only when `!s.sawLiveOutput` (`:2821`). The shell
> prompt is live output — `bumpStartupCurtain` sets `sawLiveOutput = true` (`:2872`). So in
> the normal boot case, the no-output timer's guard is false and it never fires. There is
> ONE path to the wrong outcome (the quiet timer), not two. The no-output timer is a
> concern only for the late-seated replay edge case (no live output at all), which is a
> separate, minor issue.
> **Replaced with:** Only the quiet timer fires prematurely in the normal boot case. Change
> 2 (raise the no-output backstop) is valid for the replay edge case but is a separate
> concern, not a second front.

`CURTAIN_MAX_MS = 15000` is fine and is not in scope.

**The quiet heuristic is sound; its trigger is not.** "Output went quiet, so the thing has settled" is only meaningful once the thing has *started*. Applied from the moment of the first shell byte, it measures the wrong silence.

**A larger constant is not the fix.** 2 s is what this machine produced for one CLI; a Raspberry Pi, a cold FS cache or a slower CLI will produce more. Any number chosen here is a guess that fails on the hardware this product targets.

**The signal already exists.** The dispatch curtain in this same file is already family-aware — its comment (`:309-317`) reasons in terms of *"the clear-readiness ceiling (15s)"*, *"awaitFirstReadiness (20s)"* and *"the per-delivery family floor"*. `clearReadiness.ts:77-82` (in `src/standalone/`) holds the real numbers, resolved per family at `:415-428`:

| Family | First-readiness ceiling |
| :--- | :--- |
| `claude` | 8000 ms |
| `devin` | 20000 ms |
| `antigravity` | 8000 ms |
| unknown | the longest, per the repository's fallback rule |

The webview already carries `cliFamily` per seat — the fleet list (`fleetList = data.terminals` at `:2395`) includes `cliFamily` on each terminal object (confirmed by `TaskViewerProvider.ts:1045` which maps `t.friendlyName` → `t.cliFamily`). The startup curtain is the one path that ignores it.

## Metadata

- **Complexity:** 3
- **Tags:** terminals, ui, bugfix, both-hosts

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a `cliFamily` parameter to `armStartupCurtain` and looking it up from the fleet list.
- Adding a comment documenting the boot profile measurement beside the constants.

### Complex / Risky
- Choosing the minimum-age value. Using the full first-readiness ceiling (e.g., 20 s for Devin) as the minimum age means the curtain stays up for 20 s even if the CLI painted and settled at 5 s — a 15 s UX regression that makes the board look frozen. The ceiling is the MAXIMUM plausible first-readiness time, not the typical. See Change 1 for the design choice.
- Transporting the readiness ceilings from `src/standalone/clearReadiness.ts` (server-side TypeScript) to `src/webview/terminals.js` (browser-side JavaScript). They cannot share an import. The existing pattern is `workingSilenceMs` (`:328-332`) — injected as a `data-*` attribute by the host. The host must inject the per-family ceilings the same way, or the webview must duplicate them (a fork that will drift).

## Adversarial Synthesis

Key risks: using the full first-readiness ceiling as the minimum age (20 s for Devin) creates
a 15 s UX regression on fast boots — the curtain stays up long after the CLI has settled; the
transport mechanism for the constants is unspecified (browser-side JS cannot import from
server-side TypeScript); the "two independent paths" claim was wrong (only the quiet timer
fires in the normal boot case). Mitigations: gate the minimum age on pre-CLI silence only
(once the CLI produces output, the quiet timer can dismiss normally); inject the ceilings as
a `data-*` attribute following the `workingSilenceMs` pattern; correct the no-output timer
analysis.

## Proposed Changes

### 1. A family-derived minimum age, before any quiet dismissal — but gated on pre-CLI silence

`armStartupCurtain(name, hasStartupCommand)` takes the seat's `cliFamily` (looked up from the
fleet list by `name`) and records a `notBefore` stamp: `armedAt + firstReadinessCeiling(family)`.

`bumpStartupCurtain` keeps its quiet timer. A quiet expiry earlier than `notBefore` re-arms
to the remainder instead of dismissing. Quiescence still decides *when* the curtain lifts;
it can no longer decide it before the CLI could plausibly have painted.

**Design choice — the 20 s problem.** The Devin ceiling is 20 s. Using it as the minimum age
means the curtain stays up for 20 s even if the CLI painted at 4.2 s and settled by ~5 s.
That is a 15 s UX regression. Two options:

- **(a) Gate the minimum age on pre-CLI silence only.** Once `bumpStartupCurtain` fires from
  CLI output (not shell output), the quiet timer can dismiss normally — the pre-CLI silence
  is over, and the quiet heuristic is now meaningful. This requires distinguishing "shell
  output" from "CLI output" in `bumpStartupCurtain`, or arming the minimum-age gate only
  until the first bump that produces a meaningful frame. This is the cleaner option: the
  curtain lifts at ~5.4 s (CLI settles) on a fast Devin boot, not at 20 s.
- **(b) Use the full ceiling as the minimum age and accept the cost.** Simpler, but 15 s of
  unnecessary curtain on every fast Devin boot. The plan rejects this — it is the same error
  as using a large literal, just family-flavored.

**Decision: option (a).** The minimum age prevents dismissal during the pre-CLI silence
only. Once `bumpStartupCurtain` fires from CLI output (not shell output), the quiet timer can
dismiss normally — the pre-CLI silence is over, and the quiet heuristic is now meaningful.
The curtain lifts at ~5.4 s (CLI settles) on a fast Devin boot, not at 20 s. The 15 s UX
cost of option (b) was rejected by the user as too long.

This requires distinguishing "shell output" from "CLI output" in `bumpStartupCurtain`, or
arming the minimum-age gate only until the first bump that produces a meaningful frame. If
distinguishing the two proves impractical at implementation time, fall back to a fraction of
the ceiling (e.g., 50%) as the minimum age, which bounds the cost without guessing a literal.

**Reuse the shipped constants, do not restate them.** The values live in
`clearReadiness.ts` (`src/standalone/`). The webview is browser-side JS and cannot import
them. The host must inject the per-family ceilings as a `data-*` attribute on the terminals
panel (following the `workingSilenceMs` pattern at `:328-332`), and the webview reads them
from `document.body.dataset`. A second copy in the webview is a fork that will drift — and
drift here is invisible, because both halves keep working while disagreeing.

**Unknown family takes the longest ceiling**, per the repository's fallback rule: guessing
short strands the operator behind a raw shell, guessing long costs seconds of a curtain
that was going to lift anyway.

### 2. Raise the no-output backstop above the measured first paint

`CURTAIN_NO_OUTPUT_MS = 4000` is 190 ms under the measured 4210 ms. It exists for a genuinely
different case — a late-seated pane whose entire boot arrived as replay, with no live frame
coming — so it must outlast a *normal* boot or it fires on the common path instead of the rare
one. In the normal boot case the no-output timer is a no-op (`sawLiveOutput` is true after the
shell prompt), so this change only affects the replay edge case.

Derive it from the same family ceiling plus a margin, rather than picking another literal.

### 3. Say why in the constants

Both constants read as self-evident and are not. Record the measurement (`prompt at ~200 ms, 2 s silence, first paint at ~4.2 s`) beside them, so the next reader knows the number has a boot profile behind it.

## Edge-Case & Dependency Audit

1. **A seat with no CLI.** `hasStartupCommand` already gates arming; a plain shell gets no curtain and none of this applies. Do not extend the minimum age to it — that is pure added latency over nothing.
2. **A CLI that fails to launch.** The minimum age must not become a floor on *failure*: `CURTAIN_MAX_MS` (15 s) still applies, and the exit/error dismissal paths must keep bypassing the minimum entirely, or a seat whose CLI died sits behind a curtain for the full Devin ceiling.
3. **Reattach.** Arming is deliberately not on "output arrived" (`:2805`) because a replay is indistinguishable from a boot burst. The minimum age must hang off the same arming decision, not off first output, or every reload curtains every pane for 20 s.
4. **Click-to-dismiss stays immediate.** The operator overrides the heuristic; the minimum age must not outrank an explicit click.
5. **Slower hardware is the target.** The measurement above is an x86 tower. A 4 GB Pi will be slower, which is the argument for the family ceiling over any literal — state it so nobody "optimises" it back to a constant.
6. **The 20 s UX cost.** If option (b) is chosen (full ceiling as minimum age), a Devin seat that boots in 5 s sits behind a curtain for 15 s. This is a visible regression. Option (a) avoids it by gating on pre-CLI silence only.

## Dependencies

None — this plan is self-contained within `src/webview/terminals.js` and the host that
injects the `data-*` attributes (both `src/extension.ts` and `src/standalone/bootstrap.ts`).

## Verification Plan

1. On a Devin seat, the curtain is still up at 4.5 s and the shell banner is never visible; it lifts once the CLI has painted and gone quiet.
2. On a Claude seat the same holds against the 8 s ceiling — assert the two families genuinely differ rather than both taking one number.
3. A seat whose CLI exits immediately dismisses on the exit path, not after the family ceiling.
4. A reattach to an established seat does not arm a curtain at all.
5. A click dismisses instantly regardless of remaining minimum age.
6. A seat with no startup command gets no curtain, unchanged.
7. The webview reads the readiness ceilings from the injected `data-*` attributes; assert no second copy of those numbers exists in `src/webview/`.
8. A fast Devin boot (CLI settles at ~5 s) does NOT sit behind the curtain for 20 s — the curtain lifts shortly after the CLI settles, not at the full ceiling.

### Goal Invariants

- Assert `armStartupCurtain` in `src/webview/terminals.js` accepts and records a `cliFamily`-derived `notBefore` stamp.
- Assert a quiet-timer expiry before `notBefore` re-arms instead of dismissing.
- Assert the exit/error dismissal paths bypass `notBefore` entirely (a dead CLI does not sit behind the curtain for the full ceiling).
- Assert the per-family readiness ceilings are read from a `data-*` attribute (injected by the host), not duplicated as literals in `src/webview/terminals.js`.
- Assert `CURTAIN_NO_OUTPUT_MS` is derived from the family ceiling plus a margin, not a bare literal.
