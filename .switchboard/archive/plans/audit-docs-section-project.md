# Doc-Parity Audit — `project` Section (12 files, 480 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `project` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. This section documents the Project panel's tabs and the browser terminal fleet.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/project/`) — counts verified against the tree:

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

`browser-terminals.md` is the largest file and is capability-gated: the PTY layer is fail-closed on the optional `node-pty` module, and the docs claim the Terminals entry appears only on macOS and Windows. A terminal claim failing because node-pty did not load is `GATED`, not `GAP` — a materially different finding, and one the harness subtask is responsible for preventing by provisioning a host where the capability is present.

### The false-green mechanism (verified — do not re-derive)

1. **Every verb is reachable.** `bootstrap.ts:1140`'s `default:` arm delegates to `KanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`), so every write lands and returns `{success:true}`. For an authoring surface this means a **save can report success and still be invisible** — the write is real, the read-back may not be.
2. **Both state builders fabricate the board payload** — `bootstrap.ts:404-410` and `:433-439`: `DEFAULT_KANBAN_COLUMNS` (`:405`/`:434`); `activeFilter: null`, `controlPlaneMode: 'none'`, `repoScopeFilter: null`, `projectContextEnabled: false` (`:406`/`:435`); `cliTriggersState.enabled: false` (`:407`/`:436`); `theme: 'afterburner'` (`:408`/`:437`); `routingConfig: {}` (`:409`/`:438`).
3. **The literals are re-asserted ~40 ms later** — `schedulePushFullState()` at `:1156`, `PUSH_COALESCE_MS = 40` at `:459`.

**The transport is not dead.** The claim that `KanbanProvider.postMessage` has no sink in standalone is **false**: `bootstrap.ts:692/758/1757` wire a shared `BroadcastHub` with the API server, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`src/services/broadcastHub.ts:80-91`). Do not attribute an inert tab to a missing transport.

### Evidence rules (binding — the register header is the authoritative copy)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- **Settle-and-reload:** re-observe any board-displayed or persisted state after ~1 s and after a page reload before recording `LIVE`.
- **Attribute observations, not causes.** Record what was seen; never write a root cause into a row unless independently confirmed against the tree at audit time.
- Record a line-coverage figure per file; under 100% means unfinished.
- `getting-started/headless-switchboard.md` contributes no requirements — it may not justify, excuse or close a gap on any page here.
- `BLOCKED` is not a verdict; resolve or escalate it, never count it as audited.

Where this restatement differs from the register header, the header wins.

## User Review Required

None.

## Complexity Audit

### Routine
- Reading each file and extracting claims.

### Complex / Risky
- **Per-action granularity, not per-tab.** Twelve files describing twelve surfaces will produce far more than twelve rows. A row reading "Tuning tab works" is not an audit result — every documented control inside it is a claim.
- **`implementation-sidebar.md` requires care.** Whether the Implementation view exists in the browser is a real question this audit answers. `headless-switchboard.md` asserts it has no rail entry, and that page contributes no requirements — so this is **answered from observation only**. Record what is seen. If the view is genuinely absent, that is a finding to reconcile at closeout (intentional scope vs gap), not a pass.
- **Terminal claims must distinguish `GATED` from `GAP`.** Confirm the PTY layer loaded before recording any terminal verdict; if it did not, the entire file is `BLOCKED` rather than failed. The documented macOS/Windows-only restriction is itself a claim — record the platform the audit ran on.
- **`constitution.md`, `prd.md`, `system-docs.md`, `tuning.md` are document-authoring surfaces.** Verify the full round trip — create → edit → persist → **reload** — not just that an editor renders. Mechanism 1 makes this essential: the save verb reaches the provider and the write lands, so a "saved" toast proves nothing about whether the browser can read it back. A surface that renders and silently discards, or saves and cannot re-display, is the exact failure shape this audit exists to catch.
- **`plan-switcher.md` / `plan-browser.md`** involve workspace and plan selection, which interact directly with the workspace-scoping fields standalone hardcodes at `bootstrap.ts:406`/`:435` (`activeFilter`, `repoScopeFilter`, the single synthesised workspace item). Cross-check against `standalone-state-builders-delegate-to-getfullstatemessages.md`.
- **`agent-dashboard.md` and `terminal-controls.md` depend on live PTY state.** Their verdicts inherit the terminal gating — record PTY availability on each.

## Edge-Case & Dependency Audit

**Race Conditions** — document-authoring surfaces persist asynchronously; re-observe after reload before recording `LIVE`. Anything board-derived is additionally subject to the 40 ms coalesced push.

**Security** — none beyond scratch-workspace handling.

**Side Effects** — this section creates and edits real documents (constitution, PRD, system docs) and may spawn terminals that run real shells in the workspace. Scratch workspace only; kill spawned terminals on completion.

**Dependencies & Conflicts** — terminal dispatch overlaps the browser-dispatch work tracked elsewhere; link rather than duplicate. The **Standalone Push-Path Parity** feature has **three** subtasks, not seven — `standalone-workspace-selection-fields-hardcoded.md` was cited by the first draft of this plan and **no longer exists** (merged into the delegation plan on 2026-08-07). Use this mapping:

| Observed gap touches | Link this plan |
|---|---|
| workspace selection / plan scoping, repo scope, columns, routing config, CLI triggers, theme, control-plane mode | `standalone-state-builders-delegate-to-getfullstatemessages.md` |
| unbounded queue growth / messages never delivered to a bound webview | `restore-backlog-view-to-standalone-host.md` |
| absence of a CI number for a parity class | `standalone-push-parity-guard.md` |

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — in particular its guarantee that the PTY layer is loaded and its record of the audit platform.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each documented control or behaviour as its own register row.
3. Exercise it against the running standalone host.
4. For authoring surfaces, verify the create → edit → persist → **reload** round trip, and record the post-reload observation explicitly.
5. For terminal claims, confirm PTY availability first; record `GATED` if the capability is absent, `BLOCKED` if it could not be established.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, apply the link mapping above, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `project` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Per-action rows, not per-tab; `GATED` distinguished from `GAP` and from `BLOCKED`; Implementation-view question answered from observation only; authoring surfaces require a post-reload observation.

## Verification Plan

1. All 12 files carry a recorded line-coverage figure, each 100%.
2. Row count materially exceeds file count — a per-tab summary is a failed audit.
3. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
4. Zero rows cite verb reachability, `{success:true}`, or a landed DB write. In particular, no authoring-surface row rests on a save returning success.
5. Every authoring surface records a reload-verified round trip, with the post-reload observation stated.
6. Terminal rows record PTY availability and the audit platform, and `GATED` is used where applicable rather than `GAP`.
7. The Implementation-view verdict cites observation, not `headless-switchboard.md`.
8. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
9. Every `GAP` / `PARTIAL` links an existing plan or is flagged for closeout — and no row links a merged-away plan file.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The per-action granularity and the round-trip discipline are what make this section's verdicts meaningful; mechanism 1 makes a "saved" toast actively misleading here.

## Review Findings

Reviewed 2026-08-10. **Item 7 fails against this plan's most explicit instruction.** The plan states the Implementation-view question is *"answered from observation only… If the view is genuinely absent, that is a finding to reconcile at closeout, not a pass"* — PRJ-027 through PRJ-038 mark it and the Plan Switcher, Agent Dashboard and Terminal Controls `N/A-ext`, which is a pass; those 9 rows are flagged in the register for re-decision at closeout. **Items 4 and 5 fail:** the authoring surfaces (`constitution.md`, `prd.md`, `system-docs.md`, `tuning.md`) are `LIVE` on *"verb available"* with no create → edit → persist → **reload** round trip recorded, which is precisely the failure shape this plan calls essential to catch. **Item 6 partially passes:** PTY availability and platform are recorded, but 8 of the 14 `browser-terminals.md` rows are `BLOCKED-visual` because no browser was driven. PRJ-012's `GAP` was reclassified on re-check — `planAutoFetch` exists nowhere in `src/`, so it is a doc defect spanning both hosts, not a standalone verb-surface gap. Files changed: register only; no source code touched.
