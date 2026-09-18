# A Seat's CLI Family Is a Record That Never Meets Reality, and a Clear Acts On It

## Goal

Make a seat's `cliFamily` either *true* or *visibly uncertain* — never quietly wrong. Today it is
derived once from the command the board composed at spawn, re-derived thereafter only from that same
record, and never compared against the process actually running in the pty. An operator who starts a
different CLI in a seat's slot leaves the board holding a confident, wrong identity, and three
behaviours act on it destructively.

The fix is not "detect the CLI harder". It is to stop treating a *declaration* as an *observation*,
tag which one a value is, and refuse the destructive paths when the answer is a declaration that
reality may have moved on from.

### Problem Analysis

**Observed 2026-09-18.** Team `Coding`: three seats reported `cliFamily: "devin"` with
`startupCommand: "devin --permission-mode bypass"`. The operator had started **Antigravity** in those
slots by hand. The board's record never moved. Nothing in any surface indicated the discrepancy —
`ptyListTerminals` reports the stale family with the same confidence it reports a correct one.

#### Where the value comes from

```ts
// src/services/goPtyFleetProjection.ts:619 — at spawn
cliFamily: deriveCliFamily(innerCli),

// src/services/goPtyFleetProjection.ts:1048 — on restore
cliFamily: row.cliFamily || deriveCliFamily(row.startupCommandInner || row.startupCommand),
```

`deriveCliFamily` (`src/services/cliIdentity.ts`) is a pure function of a command **string**. It
parses `path.basename(argv[0])` and maps it to `devin | claude | antigravity | unknown`. It is
correct at what it does. The defect is what it is asked about: the *recorded* spawn command, not the
*running* process. The Go host never assigns `t.cliFamily` from observation either — it is carried in
from the TS side and only ever read back (`cmd/switchboard-pty-host/main.go:232`).

So the family is a pure function of a record, and **no code path anywhere reconciles that record with
the pty's actual occupant.** A restore re-derives from the record, which means staleness survives a
board restart and looks freshly computed.

#### Three behaviours act on it, all destructive or silent

**1. A clear becomes a respawn — and kills the running CLI.**

```go
// cmd/switchboard-pty-host/prompt.go:101
func clearStrategy(family string) string {
    switch family {
    case "devin":
        return "respawn"
    default:
        return "in-process"
    }
}
```

`respawn` kills the CLI in the pty, starts a fresh login shell, and re-injects the recorded
`startupCommand` verbatim (`main.go:348` records it for exactly this; `:1424`, `:1452` invoke it).
With a stale `devin` label on a seat running Antigravity, **a routine clear terminates Antigravity and
launches Devin in its place.**

This is not a rare path. The orchestrator clears the accepted coder on every subtask accept, and
clears the roster at the start of a feature run. In the observed session the next accept would have
destroyed three live sessions, and the lead had no way to know from any surface it reads.

**2. The respawn prompt shape is wrong, and fails without erroring.**

```go
// cmd/switchboard-pty-host/prompt.go:120
case "claude": return " " + quoted     // positional
case "devin":  return " -- " + quoted  // after --
default:       return " -- " + quoted
```

The source comment states the failure mode plainly: *"a bare string before `--` is read as a PATH, so
a mis-shaped call does not error; it treats the prompt as a directory."* A prompt delivered under the
wrong family is not rejected — it is silently consumed as a path.

**3. Readiness timing is keyed to the wrong ceiling.**

This is the example `CLAUDE.md` already cites as a shipped bug: an `'unknown'` family *"silently
borrowing Claude's 8000ms readiness ceiling instead of Devin's 20000ms, so every fix to the Devin
timing was invisible to the seat that needed it."* A *wrong* family is the same defect with a
confident label on it.

### Root Cause

**`cliFamily` is an identity read that drives behaviour, and it is stored untagged — so a declaration
and an observation are the same value.**

`CLAUDE.md`'s rule is explicit that on reads of *configuration, identity, routing, or membership* a
value must either carry its source or fail loudly, because *"a default that behaves exactly like a
configured value turns a loud failure into a quiet wrong answer."* `cliFamily` is such a read: it
selects a destructive reset strategy, an argv shape, and a timing ceiling. Yet nothing records
whether it was **declared** by the board at spawn or **observed** from the process, and no surface can
tell the difference.

The board is not wrong to derive a family at spawn — at spawn the declaration *is* the best available
truth, and the seat genuinely was started that way. It is wrong to keep presenting that declaration as
current fact indefinitely, and to let the most destructive path in the pty host act on it unguarded.

## Metadata

- **Complexity:** 4
- **Project:** Terminals & the Fleet
- **Touches:** `src/services/cliIdentity.ts`, `src/services/goPtyFleetProjection.ts`,
  `cmd/switchboard-pty-host/prompt.go`, `cmd/switchboard-pty-host/main.go`,
  `internal/ptyhost/protocol.go`
- **Related:** `a-seats-clear-strategy-is-declared-per-cli-family-not-assumed`
  (which established that the strategy is *declared*; this plan does not overturn that — see below)

## Host Scope

**Standalone plus the Go pty host.** The Go host owns `clearStrategy` and the respawn path; the
standalone host owns derivation and the seam that reports it. No new seam is wired into
`src/extension.ts` — per the cutover the legacy host is out of scope and its absence is intended
state, not divergence.

## Settled Design

**Tag the family with its provenance, and make the destructive path require a provenance it trusts.**

This deliberately does **not** overturn the existing "declared, never inferred" principle. That plan
was right that the *clear strategy* must not be guessed from observed behaviour. This plan says
something narrower: the *family the strategy is looked up by* must not be a stale record silently
presented as current.

### 1. The family becomes a tagged read

`{ value: CliFamily, source: CliFamilySource }` where source is one of:

- `declared:spawn` — derived from the command the board composed. True at spawn; decays.
- `observed:banner` — confirmed from the CLI's own startup output in the pty buffer.
- `operator:set` — the operator stated it explicitly (see 3).
- `unknown` — nothing established it.

Reported on every seam that reports a seat today, so "which family, and how do we know?" is
answerable from `ptyListTerminals` and the fleet surfaces without reading source.

### 2. Observation confirms or contradicts the declaration

The Go host already watches the pty buffer for readiness (`devinReady` and siblings in `prompt.go`).
Each supported CLI announces itself at startup. On first output, match the buffer against the known
banners:

- Banner agrees with the declaration → promote to `observed:banner`. Nothing else changes.
- Banner contradicts it → record the observed family, keep the declared one alongside, and mark the
  seat **contradicted**. Do not silently switch the strategy on it; a contradiction is a state the
  operator must see, because the recorded `startupCommand` is now also wrong and a respawn would
  replay it.
- No banner recognised → stays `declared:spawn`. This is the common case for a wrapper-heavy or
  hand-started CLI and must not be treated as a contradiction.

Detection is best-effort by design. The plan does not depend on recognising every CLI — it depends on
never *acting destructively* on an unconfirmed declaration, which is change 4.

### 3. The operator can state the truth

A verb that sets a seat's family and startup command together — they are one fact, and correcting
only the family leaves a respawn still replaying the wrong binary. Sets `source: 'operator:set'`,
which observation does not override (the operator outranks a banner match).

This is the escape hatch that makes the observed session recoverable without restarting seats, and it
is the minimum useful slice if the rest of this plan is deferred.

### 4. Respawn requires a trusted provenance

`clearStrategy` gains the provenance, not just the family:

- `observed:banner` or `operator:set` → today's behaviour, respawn for devin.
- `declared:spawn` on a seat whose buffer has produced output that never matched the declared
  banner → **do not respawn**. Fall back to `in-process` and log the refusal naming the seat, the
  declared family and the reason.
- **contradicted** → never respawn. Refuse and surface it.

`in-process` is the correct conservative choice here and the existing default already reasons this
way: *"an unrecognised family keeps today's behaviour rather than being respawned on a guessed argv
shape."* This extends that sentence to cover a family that is recognised but unconfirmed. The failure
mode of a wrong `in-process` is a context reset that does not fully clear — recoverable, visible. The
failure mode of a wrong `respawn` is a destroyed session and a different CLI silently substituted.
That asymmetry is the whole argument, and it is `CLAUDE.md`'s "choose the value whose failure is
visible or safe."

## Proposed Changes

### Change A — a tagged family

`src/services/cliIdentity.ts`: add `deriveCliFamilyTagged(cmd): { value, source: 'declared:spawn' }`.
`deriveCliFamily` stays for the pure-string call sites the contract tests pin. No behaviour change.

### Change B — carry and report provenance

`src/services/goPtyFleetProjection.ts:619` and `:1048` populate the tagged shape;
`internal/ptyhost/protocol.go` and `main.go:232` carry and report `cliFamilySource` alongside
`cliFamily`. Restore keeps whatever provenance was persisted rather than silently re-declaring.

### Change C — banner reconciliation in the Go host

`cmd/switchboard-pty-host/prompt.go`, beside the existing readiness matchers. On first output,
promote or contradict per the design above. Emits an event the board can surface.

### Change D — the operator's correction verb

Sets family + startup command + `source: 'operator:set'` on a named seat.

### Change E — guard the respawn

`clearStrategy` takes `(family, source, contradicted)`. Refuses respawn on an unconfirmed or
contradicted declaration, logs the refusal.

## Edge Cases

- **A seat legitimately running Devin, banner not recognised** — degrades to `in-process` clear. The
  cost is a weaker clear on a correctly-labelled seat; the operator can state it with Change D to
  restore respawn. Acceptable: quiet under-clearing beats silent session destruction.
- **A remote seat over ssh/mosh** — the banner arrives through the same pty, so reconciliation works
  unchanged. The recorded `startupCommand` is transport-composed; Change D must set the *inner*
  command, not the composed one, or a respawn loses the transport prefix.
- **tmux-seated seats** — respawn already routes through `tmux respawn-window` with
  `startupCommandComposed`. The guard applies at the same decision point, before the strategy split.
- **A seat the operator re-purposes twice** — `operator:set` is last-write-wins; no history is kept.

## Users & Migrations

`cliFamily` ships today on persisted seat rows. Rows without `cliFamilySource` read as
`declared:spawn` — the honest description of every row written before this change, and the value that
triggers the conservative guard rather than the destructive path. No row is rewritten; no prior
migration is assumed to have run.

## Verification Plan

### Goal invariants

1. A seat whose pty runs a CLI different from its record can never be respawned into the recorded one.
2. Every reported family carries a provenance, and no surface shows a declaration as though it were an
   observation.
3. A correctly-labelled, banner-confirmed Devin seat keeps today's respawn behaviour exactly.
4. An operator can correct a mislabelled seat without restarting it.

### Automated tests

- `clearStrategy('devin', 'declared:spawn', contradicted=true)` → `in-process`, and logs.
- `clearStrategy('devin', 'observed:banner', false)` → `respawn` (no regression).
- A contradicting banner marks the seat and does not flip the strategy silently.
- An unrecognised banner leaves `declared:spawn` and does not mark contradiction.
- Restore preserves persisted provenance instead of re-declaring it.
- Change D sets the inner command for a transport-composed seat, and a respawn keeps the prefix.

### Manual verification

Spawn a seat as devin, start a different CLI in its slot by hand, clear it. Confirm the clear does
**not** kill the running CLI, that the refusal is logged naming the seat, and that
`ptyListTerminals` shows the family with a provenance that is not `observed:banner`.

## Outstanding Questions

1. Should a contradicted seat also block *prompt delivery* until corrected? The argv shape is wrong,
   so prompts may be silently eaten as paths. Blocking is safer and more disruptive; this plan stops
   at refusing the destructive reset and surfacing the state.
2. Are the banner signatures stable enough across CLI versions to rely on for promotion? The design
   degrades safely when they are not — a missed banner is conservative, never destructive — but if
   they prove reliable, promotion could later gate more behaviour.

## Recommendation

Land at least Change D and Change E, together, even if C is deferred. D makes a mislabelled seat
recoverable; E stops the mislabel from destroying a session. Those two are the difference between a
cosmetic staleness bug and one that silently kills an operator's running agent, and E is a change to
one switch statement plus the provenance it reads.
