# Doc-Parity Audit — `pm-tools`, `integrations` and `agents` Sections (9 files, 456 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the three smallest documentation sections against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. Combined into one subtask because together they are comparable in size to a single large section.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/`):

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

This is the most **credential-dependent** group in the whole audit — nearly every claim touches ClickUp, Linear or Notion. Without configured integrations almost every row is untestable, so the harness subtask's credential provisioning is a hard prerequisite rather than a convenience. An integration claim that could not be exercised is blocked with its reason recorded, never `LIVE` by inference.

`integrations/remote-control.md` needs particular care: remote control and bug triage are two intended-exclusive modes, and that exclusivity is not enforced in code. Record what the documentation claims and what standalone actually does, without assuming the modes behave as separate.

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
- **Credential dependency is near-total.** Confirm ClickUp, Linear and Notion are all configured before starting. If any is absent, that provider's rows are blocked — and a section reported as audited with most rows blocked is not an audited section. Escalate rather than proceeding.
- **Ticket-import claims involve destructive sync paths.** Ticket import has previously pruned local state on a short fetch. Exercise these against a scratch workspace and disposable remote items only; never against a real board.
- **Outbound writes.** `to-board.md`, `notion.md` and `remote-control.md` describe pushing to external trackers. Use disposable remote objects. Do not create or modify real tickets from an audit.
- **`cloud-agents.md` may describe behaviour requiring remote infrastructure.** If it cannot be exercised locally, record blocked with the reason — do not infer.
- **`memo-capture.md`** describes a first-class panel in the browser; verify the full capture → process round trip, including that entries persist, not merely that the panel mounts.
- **Two hosts differ here.** Secret entry behaves differently between `npx switchboard` and "Open in Browser" — the standalone process has its own store while the editor-served host defers to the editor. Any claim about entering keys must record which host it was observed in, and likely needs a row per host.

## Edge-Case & Dependency Audit

**Race Conditions** — ticket sync is asynchronous and has a delta-sync design; allow settle time and re-observe before recording a verdict.

**Security** — this group handles live API credentials for three providers. Record presence only, never values. Prefer read-only operations; where a write is documented, use a disposable target.

**Side Effects** — potential outbound writes to real trackers, and potential destructive local pruning on ticket import. The most dangerous group in the audit; scratch workspace and disposable remote objects are mandatory.

**Dependencies & Conflicts** — cross-check any finding against existing tickets-related plans before writing a new one.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — specifically its provisioning of all three provider credentials.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each documented feature or behaviour as its own register row.
3. Confirm the relevant provider credential is present; if absent, record blocked with reason and move on.
4. Exercise against the running standalone host using disposable remote objects only.
5. For secret-entry claims, record a row per host.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, link the covering plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `pm-tools`, `integrations` and `agents` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Blocked-not-`LIVE` for missing credentials; per-host rows for secret entry; disposable remote targets only.

## Verification Plan

1. All 9 files carry a recorded line-coverage figure, each 100%.
2. Every row records whether the relevant provider credential was present.
3. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
4. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
5. Secret-entry claims carry a row per host, with the host named.
6. No real ticket or tracker object was created or modified — confirm the disposable targets used.
7. If more than a small minority of rows are blocked, the section is escalated rather than reported as audited.
8. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.

## Recommendation

Complexity 5 → **Send to Lead Coder.** Smallest by line count but the highest-risk group: live credentials, outbound writes, and a known destructive import path.
