# Doc-Parity Audit — `artifacts` Section (14 files, 462 lines)

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `artifacts` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/artifacts/`) — counts verified against the tree:

| File | Lines |
|---|---|
| `docs.md` | 66 |
| `planning-artifacts.md` | 57 |
| `publishing-docs.md` | 46 |
| `stitch-html.md` | 39 |
| `stitch.md` | 38 |
| `html-previews.md` | 34 |
| `design-system.md` | 29 |
| `design-panel.md` | 28 |
| `images.md` | 27 |
| `dev-docs.md` | 22 |
| `research.md` | 21 |
| `notebooklm.md` | 20 |
| `html.md` | 18 |
| `briefs.md` | 17 |

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

Fourteen small files means many discrete surfaces and a high risk of shallow coverage — the temptation is one row per file. Several of these surfaces depend on **external integrations** (Stitch, NotebookLM, design/publishing targets), which makes them the section most likely to produce `BLOCKED` rows if the harness workspace lacks credentials. An integration claim that cannot be exercised is `BLOCKED`, never `LIVE` by inference.

Two known upstream conditions must not be misattributed to standalone:

- **Stitch changed shape externally (July 2026)** — its asset payload no longer carries the screen metadata it once did. A Stitch claim may therefore fail for reasons entirely unrelated to the browser host.
- **Linear / ClickUp attachment URLs are never hotlinkable** — they 401 and expire on roughly an hour. An image or attachment that fails to render from such a URL is upstream behaviour by design, not a standalone rendering gap, and "widen the image source policy" is never the fix.

### The false-green mechanism (verified — do not re-derive)

1. **Every verb is reachable.** `bootstrap.ts:1140`'s `default:` arm delegates to `KanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`), so a generate/create/export verb returns `{success:true}` whether or not anything renders.
2. **Both state builders fabricate the board payload** — `bootstrap.ts:404-410` and `:433-439`. Relevant here only where an artifact surface displays board-derived state.
3. **The literals are re-asserted ~40 ms later** — `schedulePushFullState()` at `:1156`, `PUSH_COALESCE_MS = 40` at `:459`.

**The transport is not dead.** The claim that `KanbanProvider.postMessage` has no sink in standalone is **false**: `bootstrap.ts:692/758/1757` wire a shared `BroadcastHub` with the API server, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`src/services/broadcastHub.ts:80-91`). Do not attribute a blank preview to a missing transport.

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
- **Fourteen files, one row each, would be a failed audit.** Each documented artifact type has its own create / view / export path; each is a claim.
- **Integration-dependent surfaces.** `stitch.md`, `stitch-html.md`, `notebooklm.md`, `publishing-docs.md` and `design-panel.md` may need external credentials or services. Without them the row is `BLOCKED` with the reason recorded — never `LIVE`.
- **Upstream breakage is not a standalone gap.** Where a surface fails because an external API changed or an attachment URL expired, record it as such with the apparent cause. Misattributing it inflates the standalone gap list and sends someone to fix the wrong thing.
- **Rendering claims need visual confirmation.** `html-previews.md`, `html.md`, `images.md` and `design-system.md` describe rendered output. A route returning `200` is not evidence that the preview renders — **look at it**. Mechanism 1 guarantees the route answers.
- **`publishing-docs.md` may perform outbound writes.** Confirm the target before exercising it — do not publish to a real destination from an audit. If the only path is outbound, record `BLOCKED` rather than publishing.
- **Design push to external design surfaces is manual-only.** Do not record an automated push as available because a button exists; verify what the button actually does.

## Edge-Case & Dependency Audit

**Race Conditions** — artifact generation may be asynchronous; allow settle time and re-observe before recording a verdict.

**Security** — integration credentials are in play. Record presence only, never values. Do not exercise outbound publishing against real destinations. The register feeds a public doc rewrite at closeout.

**Side Effects** — creates artifacts in the scratch workspace; potentially outbound calls to external services. Scratch workspace only, and see the publishing caveat above.

**Dependencies & Conflicts** — no known overlap with the **Standalone Push-Path Parity** plans; cross-check anyway before writing a new plan. That feature has **three** subtasks, not seven — five earlier plans were merged into `standalone-state-builders-delegate-to-getfullstatemessages.md` on 2026-08-07 and no longer exist as files. If a row does land on board-derived state, link the delegation plan.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — in particular its provisioning of integration credentials and its record of which are present.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each documented artifact type and action as its own register row.
3. Exercise it against the running standalone host; **look at** rendered output rather than checking status codes.
4. For integration-dependent surfaces, confirm credentials first; record `BLOCKED` with reason if absent.
5. Where a failure is caused by an external API change or a non-hotlinkable attachment URL, record that cause explicitly and do not classify it as a standalone gap.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, link a covering plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `artifacts` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Per-action rows; `BLOCKED`-not-`LIVE` for missing credentials; upstream breakage attributed correctly; no outbound publish to a real destination.

## Verification Plan

1. All 14 files carry a recorded line-coverage figure, each 100%.
2. Row count materially exceeds 14.
3. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
4. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
5. Rendering claims record visual confirmation, not a status code.
6. Every integration-dependent row records whether the relevant credential was present.
7. Any failure attributed to an upstream API change or an expiring attachment URL says so explicitly and is not counted as a standalone gap.
8. No outbound publish was performed against a real destination.
9. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
10. Every `GAP` / `PARTIAL` links an existing plan or is flagged for closeout — and no row links a merged-away plan file.

## Recommendation

Complexity 4 → **Send to Coder.** Wide but shallow; the discipline that matters is per-action rows, looking at rendered output, and not converting an upstream failure into a standalone gap.

## Review Findings

Reviewed 2026-08-10. **This section is not audited and its zero-gap result is unearned.** All 48 `LIVE` rows rest on verb presence in the catalog, the banned criterion, so items 3 and 4 fail outright. **Item 6 fails with an internal contradiction:** ART-039 to ART-045 mark the Stitch surfaces `LIVE` while REF-009 in the same register records *"no Stitch credentials in scratch workspace"* — this plan requires those rows to be `BLOCKED` with the reason, never `LIVE` by inference. **Item 5 fails:** no rendering claim was visually confirmed, because no browser was driven; `html.md`, `html-previews.md`, `images.md` and `design-system.md` were judged on verb existence alone. Item 8 passes — no outbound publish was performed. Files changed: register only, with a review-pass correction block appended to the section findings marking it for re-audit; no source code touched.
