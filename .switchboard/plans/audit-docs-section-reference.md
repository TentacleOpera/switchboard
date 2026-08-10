# Doc-Parity Audit — `reference` Section (6 files, 788 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `reference` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. This is the largest section and the one densest in concrete, testable assertions.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/reference/`) — counts verified against the tree:

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

This section is unusually high-yield and unusually easy to get wrong. `settings-commands.md` enumerates settings and commands one by one — each is a discrete testable claim, and a command that exists in the palette but does nothing in the browser is exactly the false-green this audit is built to catch. `local-api-server.md` documents HTTP endpoints, which are the **one** area where checking reachability is legitimate evidence, because the endpoint response *is* the user-facing behaviour — but a documented endpoint that returns fabricated state is a `GAP`, not `LIVE`, so responses must be judged on content, not status.

### The false-green mechanism (verified — do not re-derive)

Three mechanisms compose in standalone; the harness subtask documents them in full. In short:

1. **Every verb is reachable.** `bootstrap.ts:1140`'s `default:` arm delegates to `KanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`), so every write lands.
2. **Both state builders fabricate the board payload** — `bootstrap.ts:404-410` (`pushFullState`) and `:433-439` (`getFullState`): `updateColumns` → `DEFAULT_KANBAN_COLUMNS`; `updateWorkspaceSelection` → `activeFilter: null`, `controlPlaneMode: 'none'`, `repoScopeFilter: null`, `projectContextEnabled: false`; `cliTriggersState` → `enabled: false`; `switchboardThemeNameSetting` → `theme: 'afterburner'`; `updateBoard` → `routingConfig: {}`.
3. **The literals are re-asserted ~40 ms later** — `schedulePushFullState()` at `:1156` for every non-read-only verb, `PUSH_COALESCE_MS = 40` at `:459`.

**The transport is not dead.** The claim that `KanbanProvider.postMessage` has no sink in standalone is **false**: `bootstrap.ts:692/758/1757` wire a shared `BroadcastHub` with the API server, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`src/services/broadcastHub.ts:80-91`). Do not attribute stale UI to a missing transport.

### Predicted high-yield rows in this section

These are *hypotheses to test*, not verdicts. Each names an exact fabricated field it collides with:

- **`theme-status-bar.md`** — every theme claim collides head-on with `switchboardThemeNameSetting: theme: 'afterburner'` (`bootstrap.ts:408`/`:437`). A theme change is the cleanest demonstration of the 40 ms revert in the whole corpus. Expect the browser to snap back to Afterburner.
- **`settings-commands.md`** — any setting whose effect surfaces through columns, routing, CLI triggers, theme, repo scope or control-plane mode will save successfully and revert. Settings whose effect is DB-only and never re-pushed will appear to work.
- **`local-api-server.md`** — a `/kanban/state`-shaped endpoint returning `routingConfig: {}` or the raw `DEFAULT_KANBAN_COLUMNS` set is a `GAP` despite a `200`.
- **`setup-panel.md`** — per-host divergence: the docs state secret entry is **live** under `npx switchboard` and **disabled** under "Open in Browser". Both are documented behaviour; a row per host.

### Evidence rules (binding — the register header is the authoritative copy)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- **Settle-and-reload:** re-observe any board-displayed state after ~1 s and after a page reload before recording `LIVE`.
- **Attribute observations, not causes.** Record what was seen; never write a root cause into a row unless it was independently confirmed against the tree at audit time.
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
- **`settings-commands.md` is an enumeration, not prose.** Every listed setting and command is its own row. Summarising the list into a handful of rows defeats the audit — this file alone likely produces the most rows in the whole feature.
- **Commands must be executed, not located.** Presence in a palette or a registry is not evidence. Note that mechanism 1 guarantees the command *runs*; the question is whether its effect is visible and durable in the browser.
- **Endpoint responses must be inspected for content.** `local-api-server.md` claims are only `LIVE` if the response carries real state. Compare the body against the fabricated-field table above before recording a verdict.
- **A setting that reverts is `GAP`, not `PARTIAL`.** The settle-and-reload rule decides this, and for this section it is the difference between the audit working and repeating its predecessors' error.
- **`architecture.md` may describe internals with no user-facing surface.** Those rows are `N/A` — but mark them explicitly rather than skipping, or line coverage is unverifiable.
- **`troubleshooting.md` describes failure paths.** Verifying them means inducing the failure; where that is impractical, record `N/A` with the reason rather than a speculative `LIVE`.

## Edge-Case & Dependency Audit

**Race Conditions** — the 40 ms coalesced push. Settle-and-reload before every state-changing verdict; this section's settings and theme claims are where it bites hardest.

**Security** — `setup-panel.md` and `local-api-server.md` touch credentials and auth tokens. Record presence and behaviour only, never values. Do not record the one-time token or session cookie.

**Side Effects** — exercising documented commands and settings mutates the scratch board. Expected; must be a scratch workspace.

**Dependencies & Conflicts** — overlaps the **Standalone Push-Path Parity** feature. Use this mapping rather than writing duplicates:

| Observed gap touches | Link this plan |
|---|---|
| columns / visibility / ordering, routing config, CLI triggers, theme, repo scope, control-plane mode, workspace-selection fields | `standalone-state-builders-delegate-to-getfullstatemessages.md` |
| unbounded growth / messages never delivered to a bound webview | `restore-backlog-view-to-standalone-host.md` |
| absence of a CI number for a parity class | `standalone-push-parity-guard.md` |

**Note:** the Push-Path Parity feature has **three** subtasks, not seven. Five earlier plans (including `standalone-theme-hardcoded-afterburner.md` and `standalone-routing-config-hardcoded-empty.md`) were merged into the delegation plan on 2026-08-07 and **no longer exist as files** — link the delegation plan instead.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — the register, evidence rules, audited builds for both hosts, and provisioned hosts must exist first.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each user-facing feature or behaviour claim as a register row.
3. Exercise it against the running standalone host; record verdict and evidence class.
4. For `local-api-server.md`, call each documented endpoint and inspect the **body** against the fabricated-field table before judging.
5. For `settings-commands.md`, execute each command and change each setting, then **re-observe after ~1 s and after reload** — a value that snaps back is `GAP`.
6. For `setup-panel.md`, record secret-entry claims per host.
7. Record the line-coverage figure.
8. For each `GAP` / `PARTIAL`, apply the link mapping above, or flag for the closeout subtask.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `reference` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Enumerated settings/commands each get a row; endpoint verdicts judged on response content; reverting settings recorded as `GAP`; secret-entry rows per host.

## Verification Plan

1. All 6 files carry a recorded line-coverage figure, each 100%.
2. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
3. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
4. Every documented command and setting in `settings-commands.md` has its own row — count rows against the file's enumeration.
5. Every state-changing row records that it was re-observed post-settle and post-reload.
6. Every documented endpoint in `local-api-server.md` has a verdict judged on response content, with the relevant body field quoted in the note.
7. `setup-panel.md` secret-entry claims carry a row per host, with the host named.
8. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
9. Every `GAP` / `PARTIAL` links a plan via the mapping above or is flagged for closeout — and no row links a merged-away plan file.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The largest section, and the one where the enumerated-claim discipline and the settle-and-reload rule together decide whether the audit is real.
