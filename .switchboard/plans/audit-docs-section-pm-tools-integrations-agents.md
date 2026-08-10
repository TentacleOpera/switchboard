# Doc-Parity Audit — `pm-tools`, `integrations` and `agents` Sections (9 files, 456 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the three smallest documentation sections against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. Combined into one subtask because together they are comparable in size to a single large section.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/`) — counts verified against the tree:

| File | Lines |
|---|---|
| `integrations/remote-boards.md` | 74 |
| `integrations/cloud-agents.md` | 71 |
| `pm-tools/working-with-tickets.md` | 69 |
| `pm-tools/to-board.md` | 54 |
| `pm-tools/browsing.md` | 51 |
| `agents/memo-capture.md` | 43 |
| `pm-tools/overview.md` | 42 |
| `integrations/remote-control.md` | 30 |
| `pm-tools/notion.md` | 22 |

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

This is the most **credential-dependent** group in the whole audit — nearly every claim touches ClickUp, Linear or Notion. Without configured integrations almost every row is `BLOCKED`, so the harness subtask's credential provisioning is a hard prerequisite rather than a convenience. An integration claim that could not be exercised is `BLOCKED` with its reason recorded, never `LIVE` by inference.

It is also the most **destructive** group. Three known conditions shape the method:

- **Ticket import has previously pruned local state on a short fetch** — a fetch returning fewer items than the remote holds has destroyed local rows. Exercise import against a scratch workspace and disposable remote items only, never against a real board.
- **Ticket sync is initial-load-then-delta by design.** A burst of API calls on first load is the intended shape, not a defect — do not record it as one. The delta engine is not fully built, so gaps in incremental behaviour are real findings while the initial burst is not.
- **Remote control and bug triage are two intended-exclusive modes, and the exclusivity is not enforced in code.** `integrations/remote-control.md` must be audited against observed behaviour, not against an assumption that the modes are separate. If both can be active at once, that is a finding.

### The false-green mechanism (verified — do not re-derive)

1. **Every verb is reachable.** `bootstrap.ts:1140`'s `default:` arm delegates to `KanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`), so an import / push / sync verb returns `{success:true}` and lands its DB write whether or not the browser can show the result.
2. **Both state builders fabricate the board payload** — `bootstrap.ts:404-410` and `:433-439`. Relevant here wherever a ticket lands on the board and the board's own state is displayed.
3. **The literals are re-asserted ~40 ms later** — `schedulePushFullState()` at `:1156`, `PUSH_COALESCE_MS = 40` at `:459`. `to-board.md` claims in particular land a card and then trigger this push.

**The transport is not dead.** The claim that `KanbanProvider.postMessage` has no sink in standalone is **false**: `bootstrap.ts:692/758/1757` wire a shared `BroadcastHub` with the API server, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`src/services/broadcastHub.ts:80-91`). Do not attribute a missing ticket to a missing transport.

### Evidence rules (binding — the register header is the authoritative copy)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- **Settle-and-reload:** re-observe persisted or board-derived state after ~1 s and after a page reload before recording `LIVE`.
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
- **Credential dependency is near-total.** Confirm ClickUp, Linear and Notion are all configured before starting. If any is absent, that provider's rows are `BLOCKED` — and a section reported as audited with most rows `BLOCKED` is not an audited section. Escalate rather than proceeding.
- **Ticket-import claims involve a destructive sync path.** See the short-fetch prune above. Disposable remote items only; verify local row counts before and after.
- **Outbound writes.** `to-board.md`, `notion.md` and `remote-control.md` describe pushing to external trackers. Use disposable remote objects. Do not create or modify real tickets from an audit.
- **`cloud-agents.md` may describe behaviour requiring remote infrastructure.** If it cannot be exercised locally, record `BLOCKED` with the reason — do not infer.
- **`memo-capture.md`** describes a first-class panel in the browser; verify the full capture → process round trip, including that entries **persist across reload**, not merely that the panel mounts. Mechanism 1 means the append verb succeeds regardless.
- **Two hosts differ here, materially.** The docs state secret entry is **live** under `npx switchboard` (its own machine-global encrypted store, plus a `secrets set/list/delete` CLI) and **disabled** under "Open in Browser" (the fields are greyed and defer to the editor). Any claim about entering keys needs a **row per host**, with the host named — and the disabled state under "Open in Browser" is documented intended behaviour, not a gap.
- **Attachment URLs from Linear / ClickUp are never hotlinkable** — they 401 and expire. An attachment that fails to display from such a URL is upstream behaviour, not a standalone rendering gap.

## Edge-Case & Dependency Audit

**Race Conditions** — ticket sync is asynchronous with a delta-sync design; allow settle time and re-observe before recording a verdict. Board-landed tickets are additionally subject to the 40 ms coalesced push.

**Security** — this group handles live API credentials for three providers. Record presence only, never values. Prefer read-only operations; where a write is documented, use a disposable target. The register feeds a public doc rewrite at closeout.

**Side Effects** — potential outbound writes to real trackers, and potential destructive local pruning on ticket import. **The most dangerous group in the audit**; scratch workspace and disposable remote objects are mandatory, and local row counts should be captured before and after any import.

**Dependencies & Conflicts** — cross-check any finding against existing tickets-related plans (including the `tickets-panel-attachments-sync-badges-and-push-fidelity` feature) before writing a new one. The **Standalone Push-Path Parity** feature has **three** subtasks, not seven; where a row lands on board-derived state, link `standalone-state-builders-delegate-to-getfullstatemessages.md` rather than one of the five files merged away on 2026-08-07.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — specifically its provisioning of all three provider credentials and its record of which are present.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each documented feature or behaviour as its own register row.
3. Confirm the relevant provider credential is present; if absent, record `BLOCKED` with reason and move on.
4. Exercise against the running standalone host using **disposable remote objects only**; capture local row counts before and after any import.
5. For secret-entry claims, record a row per host, naming the host, and treat the documented disabled state under "Open in Browser" as intended behaviour.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, link a covering plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `pm-tools`, `integrations` and `agents` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** `BLOCKED`-not-`LIVE` for missing credentials; per-host rows for secret entry; disposable remote targets only; the initial ticket-sync burst is not a defect.

## Verification Plan

1. All 9 files carry a recorded line-coverage figure, each 100%.
2. Every row records whether the relevant provider credential was present.
3. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
4. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
5. Secret-entry claims carry a row per host, with the host named, and the "Open in Browser" disabled state is recorded as intended rather than as a gap.
6. No real ticket or tracker object was created or modified — confirm the disposable targets used.
7. Ticket-import rows record local row counts before and after, and no destructive prune went unrecorded.
8. `memo-capture.md` rows record persistence across reload, not merely that the panel mounts.
9. If more than a small minority of rows are `BLOCKED`, the section is escalated rather than reported as audited.
10. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.

## Recommendation

Complexity 5 → **Send to Lead Coder.** Smallest by line count but the highest-risk group: live credentials, outbound writes, a known destructive import path, and a per-host divergence that is intended behaviour rather than a defect.
