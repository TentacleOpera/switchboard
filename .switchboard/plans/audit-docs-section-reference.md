# Doc-Parity Audit — `reference` Section (6 files, 788 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `reference` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. This is the largest section and the one densest in concrete, testable assertions.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/reference/`):

| File | Lines |
|---|---|
| `settings-commands.md` | 224 |
| `local-api-server.md` | 197 |
| `architecture.md` | 114 |
| `setup-panel.md` | 97 |
| `troubleshooting.md` | 84 |
| `theme-status-bar.md` | 72 |

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

This section is unusually high-yield and unusually easy to get wrong. `settings-commands.md` enumerates settings and commands one by one — each is a discrete testable claim, and a command that exists in the palette but does nothing in the browser is exactly the false-green this audit is built to catch. `local-api-server.md` documents HTTP endpoints, which are the **one** area where checking reachability is legitimate evidence, because the endpoint response *is* the user-facing behaviour — but a documented endpoint that returns fabricated state (the `bootstrap.ts:341-346` literals) is a `GAP`, not `LIVE`, so responses must be checked for content, not just status.

### Evidence rules (binding — from the harness subtask)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- Record a line-coverage figure per file; under 100% means unfinished.
- No requirement may be sourced from `getting-started/headless-switchboard.md`.

## User Review Required

None.

## Complexity Audit

### Routine
- Reading each file and extracting claims.

### Complex / Risky
- **`settings-commands.md` is an enumeration, not prose.** Every listed setting and command is its own row. Summarising the list into a handful of rows defeats the audit — this file alone likely produces the most rows in the whole feature.
- **Commands must be executed, not located.** A command registered in the standalone host may still no-op, since the provider `postMessage` sink is absent. Presence in a palette or a registry is not evidence.
- **Endpoint responses must be inspected for content.** `local-api-server.md` claims are only `LIVE` if the response carries real state. An endpoint returning `routingConfig: {}` or the raw default column set is a `GAP` even though it responds `200`.
- **`architecture.md` may describe internals with no user-facing surface.** Those rows are `N/A` — but mark them explicitly rather than skipping, or line coverage is unverifiable.
- **`troubleshooting.md` describes failure paths.** Verifying them means inducing the failure; where that is impractical, record `N/A` with the reason rather than a speculative `LIVE`.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — record credential *presence* only; never paste values.

**Side Effects** — exercising documented commands mutates the scratch board. Expected; must be a scratch workspace.

**Dependencies & Conflicts** — overlaps the **Standalone Push-Path Parity** feature, particularly anything touching board payload state. Cross-reference the existing plan rather than writing a duplicate.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — the register, evidence rules, audited build and provisioned hosts must exist first.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each user-facing feature or behaviour claim as a register row.
3. Exercise it against the running standalone host; record verdict and evidence class.
4. For `local-api-server.md`, call each documented endpoint and inspect the **body** for real versus fabricated state.
5. For `settings-commands.md`, execute each command and change each setting, confirming the effect is observable in the browser.
6. Record the line-coverage figure.
7. For each `GAP` / `PARTIAL`, check the Standalone Push-Path Parity plans for existing coverage and link, or flag for the closeout subtask.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `reference` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Enumerated settings/commands each get a row; endpoint verdicts judged on response content.

## Verification Plan

1. All 6 files carry a recorded line-coverage figure, each 100%.
2. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
3. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
4. Every documented command in `settings-commands.md` has its own row — count rows against the file's enumeration.
5. Every documented endpoint in `local-api-server.md` has a verdict judged on response content.
6. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
7. Every `GAP` / `PARTIAL` links an existing plan or is flagged for closeout.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The largest section, and the one where the enumerated-claim discipline matters most.
