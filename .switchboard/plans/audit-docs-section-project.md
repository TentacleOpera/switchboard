# Doc-Parity Audit — `project` Section (12 files, 480 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `project` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. This section documents the Project panel's tabs and the browser terminal fleet.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/project/`):

| File | Lines |
|---|---|
| `browser-terminals.md` | 104 |
| `constitution.md` | 73 |
| `implementation-sidebar.md` | 42 |
| `system-docs.md` | 34 |
| `project-panel.md` | 33 |
| `terminal-controls.md` | 32 |
| `prd.md` | 31 |
| `plan-browser.md` | 28 |
| `plan-switcher.md` | 27 |
| `tuning.md` | 26 |
| `agent-dashboard.md` | 26 |
| `features-tab.md` | 24 |

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

This section is mostly panel-tab documentation, which makes it the section where "the panel renders but the tab is inert" is most likely. A tab that mounts and shows a heading is not evidence that its actions work — each documented action inside each tab is its own claim.

`browser-terminals.md` is the largest file and is capability-gated: the PTY layer is fail-closed on the optional `node-pty` module. A terminal claim failing because node-pty did not load is `GATED`, not `GAP` — a materially different finding, and one the harness subtask is responsible for preventing by provisioning a host where the capability is present.

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
- **Per-action granularity, not per-tab.** Twelve files describing twelve surfaces will produce far more than twelve rows. A row reading "Tuning tab works" is not an audit result — every documented control inside it is a claim.
- **`implementation-sidebar.md` requires care.** Whether the Implementation view exists in the browser is a real question this audit answers; it must be answered from observation, **not** from `headless-switchboard.md`, which asserts it is editor-only and is stale and non-authoritative. Record what is observed.
- **Terminal claims must distinguish `GATED` from `GAP`.** Confirm the PTY layer loaded before recording any terminal verdict; if it did not, the entire file is blocked rather than failed.
- **`constitution.md`, `prd.md`, `system-docs.md`, `tuning.md` are document-authoring surfaces.** Verify the full round trip — create, edit, persist, reload — not just that an editor renders. A surface that renders and silently discards writes is the exact failure shape this audit exists to catch.
- **`plan-switcher.md` / `plan-browser.md`** involve workspace and plan selection, which historically interact with workspace-scoping state that standalone hardcodes (`bootstrap.ts:341`, `:370`). Cross-check against `standalone-workspace-selection-fields-hardcoded.md`.

## Edge-Case & Dependency Audit

**Race Conditions** — document-authoring surfaces persist asynchronously; re-observe after reload before recording `LIVE`.

**Security** — none beyond scratch-workspace handling.

**Side Effects** — this section creates and edits real documents (constitution, PRD, system docs) and may spawn terminals. Scratch workspace only.

**Dependencies & Conflicts** — terminal dispatch overlaps the browser-dispatch work already tracked elsewhere; link rather than duplicate.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — in particular its guarantee that the PTY layer is loaded.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each documented control or behaviour as its own register row.
3. Exercise it against the running standalone host.
4. For authoring surfaces, verify the create → edit → persist → reload round trip.
5. For terminal claims, confirm PTY availability first; record `GATED` if absent.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, link the covering plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `project` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Per-action rows, not per-tab; `GATED` distinguished from `GAP`; Implementation-view question answered from observation only.

## Verification Plan

1. All 12 files carry a recorded line-coverage figure, each 100%.
2. Row count materially exceeds file count — a per-tab summary is a failed audit.
3. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
4. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
5. Every authoring surface records a reload-verified round trip.
6. Terminal rows record PTY availability, and `GATED` is used where applicable rather than `GAP`.
7. The Implementation-view verdict cites observation, not `headless-switchboard.md`.
8. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The per-action granularity and the round-trip discipline are what make this section's verdicts meaningful.
