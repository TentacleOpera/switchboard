# Doc-Parity Audit — `artifacts` Section (14 files, 462 lines)

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `artifacts` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/artifacts/`):

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

Fourteen small files means many discrete surfaces and a high risk of shallow coverage — the temptation is one row per file. Several of these surfaces depend on **external integrations** (Stitch, NotebookLM, design/publishing targets), which makes them the section most likely to produce untestable rows if the harness workspace lacks credentials. An integration claim that cannot be exercised is blocked, never `LIVE` by inference.

Stitch in particular is known to have changed shape externally (its asset payload no longer carries the metadata it once did), so a Stitch claim may fail for reasons unrelated to standalone. Record the observed failure and its apparent cause; do not attribute an upstream API change to a standalone gap.

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
- **Fourteen files, one row each, would be a failed audit.** Each documented artifact type has its own create/view/export path; each is a claim.
- **Integration-dependent surfaces.** `stitch.md`, `stitch-html.md`, `notebooklm.md`, `publishing-docs.md` and `design-panel.md` may need external credentials or services. Without them the verdict is blocked, with the reason recorded — never `LIVE`.
- **Upstream breakage is not a standalone gap.** Where a surface fails because an external API changed, record it as such. Misattributing it inflates the standalone gap list and sends someone to fix the wrong thing.
- **Rendering claims need visual confirmation.** `html-previews.md`, `html.md`, `images.md` and `design-system.md` describe rendered output. A route returning 200 is not evidence that the preview renders; look at it.
- **`publishing-docs.md` may perform outbound writes.** Confirm the target before exercising it — do not publish to a real destination from an audit. If the only path is outbound, record it as blocked rather than publishing.

## Edge-Case & Dependency Audit

**Race Conditions** — artifact generation may be asynchronous; allow settle time and re-observe.

**Security** — integration credentials are in play. Record presence only, never values. Do not exercise outbound publishing against real destinations.

**Side Effects** — creates artifacts in the scratch workspace; potentially outbound calls to external services. Scratch workspace only, and see the publishing caveat above.

**Dependencies & Conflicts** — none known against the Standalone Push-Path Parity plans; cross-check anyway before writing a new plan.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — in particular its provisioning of integration credentials.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each documented artifact type and action as its own register row.
3. Exercise it against the running standalone host; **look at** rendered output rather than checking status codes.
4. For integration-dependent surfaces, confirm credentials first; record blocked with reason if absent.
5. Where a failure is caused by an external API change, record the cause explicitly.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, link the covering plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `artifacts` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Per-action rows; blocked-not-`LIVE` for missing credentials; upstream breakage attributed correctly.

## Verification Plan

1. All 14 files carry a recorded line-coverage figure, each 100%.
2. Row count materially exceeds 14.
3. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
4. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
5. Rendering claims record visual confirmation, not a status code.
6. Every integration-dependent row records whether credentials were present.
7. No outbound publish was performed against a real destination.
8. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.

## Recommendation

Complexity 4 → **Send to Coder.** Wide but shallow; the discipline that matters is per-action rows and not inferring `LIVE` for surfaces that could not be exercised.
