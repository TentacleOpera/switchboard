# Two seats on one board can run different CLI builds, and nothing reports which

## Goal

Report the resolved CLI build per seat in the fleet listing and the `fleet` CLI command, so
version skew across long-lived seats is visible instead of latent.

### Problem Analysis

Agent CLIs resolve their own version at launch, so a seat pins whatever build was current when it
started. Measured on a live board, 2026-09-02:

- four devin seats launched 10:15 running `_versions/3000.6.7/bin/devin acp`
- four devin seats launched 16:13 running `_versions/3000.6.11/bin/devin acp`

Same board, same fleet, two builds. Nothing in `FleetTerminalInfo`, `ptyListTerminals`, the Fleet tab
or `switchboard fleet` reports it.

**This matters because prompt delivery is version-dependent, and that is measured, not theoretical.**
`ptyPromptDelivery.ts` records it in the comment that justifies the unconditional second CR:

> Measured 2026-08-23, devin 3000.4.25 vs 3000.5.20 … Concatenated ('/clear\r' as one write — or as
> two writes with no delay, which the pty coalesces) NEVER submits on 3000.5.20 at any delay; the CR
> is inserted as a literal newline. The identical bytes submit on 3000.4.25.

The delivery path is written to be correct on both, so nothing is broken today. But "re-seat to pick
up a CLI fix" is a real operational step that no surface prompts, and when a delivery symptom does
appear on one seat and not another, the first question — *are these the same build?* — is currently
unanswerable without `ps`.

It is also the shape this codebase's own rule targets: an identity read whose source is not recorded.
A seat's `cliFamily` is tracked; the *build* behind it is not, so a fix attributed to "devin" is
invisible to the seat that needs it.

### Root Cause

`cliFamily` was added to answer "which CLI is this" for timing ceilings and brand icons — a *family*
question. The build was never needed for those, so the resolved binary was never captured, even though
the fleet spawns the process and could read it.

### Non-goals

- **Do not branch behaviour on the version.** Delivery stays unconditional; this is reporting only.
  A version-keyed code path is exactly the static-list-pretending-to-be-a-runtime-probe the delivery
  comment already rejects.
- Do not add a version check, an update prompt, or a migration notice.
- Do not restart or re-seat anything automatically.

## Metadata

**Topic:** Resolved CLI build reported per seat
**Complexity:** 3
**Tags:** terminals, cli, observability, standalone, backend

## User Review Required

None.

## Dependencies

None.

## Both Hosts

`PtyFleetService` / `FleetTerminalInfo` (`ptyFleetService.ts`) is shared, and both composition roots
construct it — standalone in-process via `bootstrap.ts`, the extension via the pty-host sidecar
(`ptyHost.ts:44`). Adding a field to `FleetTerminalInfo` and populating it where the pty is spawned
reaches both.

`switchboard fleet` (`cli.ts`) reads the same listing, and `--json` must carry the field too — the
orchestrating-agent case is the main consumer, and it reads JSON, not the table.

## Proposed Changes

**1. Capture the resolved build at spawn (`ptyFleetService.ts`).**

Add an optional `cliBuild?: string` to `FleetTerminalInfo`. Populate it by resolving the actual
executable behind the launcher — for devin the child is
`~/.local/share/<cli>/cli/_versions/<version>/bin/<cli>`, so the version is a path segment of the
running child rather than something that needs an interrogation command.

**Tag the source, do not guess.** Where the build cannot be resolved, the field is **absent** — never
a plausible-looking placeholder, and never the family name standing in for a build. Absent means "not
determined"; a string means "this is what is running". The distinction has to survive to the consumer.

**2. Surface it in the fleet listing.** `ptyListTerminals` carries `cliBuild` through; the Fleet tab
shows it where it has room, and omits the field rather than rendering a dash that reads like a value.

**3. Surface it in `switchboard fleet`.** A column in the table when present, and the field in
`--json` unconditionally (present or absent, not empty-string).

**4. Do nothing else.** No warning when builds differ. Making skew visible is the whole deliverable;
deciding it is a problem is the operator's call.

## Verification Plan

1. Seat two devin terminals across a devin self-update, then `switchboard fleet --json` reports
   different `cliBuild` values for them.
2. Seat a claude terminal; `cliBuild` is either its real version or absent — never a placeholder and
   never `"claude"`.
3. A seat whose build cannot be resolved omits the field; the Fleet tab renders nothing for it rather
   than a dash.
4. `switchboard fleet` with no `--json` still renders cleanly at a narrow terminal width.
5. Prompt delivery is byte-identical to before for every CLI — assert no delivery path reads
   `cliBuild`.
6. **Both hosts:** `ptyListTerminals` carries the field in standalone and through the extension's
   pty-host sidecar.

### Goal Invariants

- Assert `cliBuild` is optional and absent (not `''`, not the family name) when unresolved.
- Assert no code path in `ptyPromptDelivery.ts`, `terminalUtils.ts` or `clearReadiness.ts` reads it.
- Assert `--json` includes the key.
- Assert the field is populated at the same place the pty is spawned, so both roots get it.
