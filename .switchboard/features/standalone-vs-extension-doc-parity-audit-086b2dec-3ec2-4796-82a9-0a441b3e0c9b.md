# Standalone vs Extension Doc-Parity Audit

**Complexity:** 5

## Goal

Read every line of the switchboard-site documentation — which documents the extension feature set, i.e. the full product — and check each documented feature against what the standalone browser host actually delivers at runtime. Every mismatch is a standalone defect to fix. The output is a complete claim register with a verdict and evidence class per feature, and a plan for every confirmed gap.

Standalone parity has been declared complete several times and has not been, because the checks used were structurally incapable of failing: the bootstrap default arm delegates every verb to the provider, so every verb is reachable and every DB write lands even when the feature is entirely dead in the browser. This audit therefore bans verb reachability, success responses, landed DB writes and handler presence as evidence. Runtime observation in a running browser host is required for any live verdict on a user-facing feature.

The headless-switchboard page contributes no requirements. It was written when standalone was thinner and describes limits that no longer hold. It is an output, rewritten from the register in the closeout subtask.

## Prior art — this is the third parity audit, and the first two were declared complete

Two standalone parity efforts already shipped and are marked CODE REVIEWED: the `standalone-board-parity-aa872dcc` feature (which wired the `bootstrap.ts` `default:` verb fallthrough) and `browser-cockpit-editor-parity-concurrency-85f62bab`. Both declared parity. Backlog, the column structure, routing config, the theme and the workspace-selection fields were dead in the browser throughout.

The reason is recorded in this repo already, in the Problem section of `standalone-kanban-column-parity-audit.md`: *"The parity feature's triage classified these as 'works' because they return `{success: true}` — the divergence is behavioral, not functional."*

That is the whole failure mode, written down before this feature existed. This audit is therefore not justified by being more thorough than its predecessors — thoroughness was never the issue. It is justified only by two things its predecessors lacked: **a driver that is not a developer's memory** (the published doc set, read line by line), and **an evidence standard that bans the criterion the previous audits passed on**. If either is relaxed during execution, this feature produces another worthless completion claim and should be abandoned rather than finished.

`standalone-kanban-column-parity-audit.md` (complexity 6) is still in CREATED and overlaps the `board` subtask. Reconcile before starting that subtask: either fold it in, or execute it and mark the overlapping rows as covered.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone Doc-Parity Audit — Harness, Claim Register and Evidence Rules](../plans/audit-standalone-against-extension-docs.md) — **CREATED**
- [ ] [Doc-Parity Audit — `reference` Section (6 files, 788 lines)](../plans/audit-docs-section-reference.md) — **CREATED**
- [ ] [Doc-Parity Audit — `board` Section (11 files, 775 lines)](../plans/audit-docs-section-board.md) — **CREATED**
- [ ] [Doc-Parity Audit — `getting-started` Section (8 files, 488 lines)](../plans/audit-docs-section-getting-started.md) — **CREATED**
- [ ] [Doc-Parity Audit — `project` Section (12 files, 480 lines)](../plans/audit-docs-section-project.md) — **CREATED**
- [ ] [Doc-Parity Audit — `artifacts` Section (14 files, 462 lines)](../plans/audit-docs-section-artifacts.md) — **CREATED**
- [ ] [Doc-Parity Audit — `pm-tools`, `integrations` and `agents` Sections (9 files, 456 lines)](../plans/audit-docs-section-pm-tools-integrations-agents.md) — **CREATED**
- [ ] [Doc-Parity Audit — Closeout: Convert Gaps to Plans and Rewrite the Standalone Doc](../plans/audit-docs-closeout-gaps-to-plans-and-doc-rewrite.md) — **CREATED**
<!-- END SUBTASKS -->

## How the Subtasks Achieve This

- **Harness, Claim Register and Evidence Rules**: Builds and installs from current `src` (standalone serves the packaged build, so auditing without this measures whatever was last packaged), provisions a scratch workspace carrying representative state, launches both browser hosts, confirms the PTY layer loaded, and creates the register with the binding evidence rules in its header. Produces no verdicts — it produces the instrument and the rules everything else records into.
- **`reference` (6 files, 788 lines)**: The largest and most claim-dense section. `settings-commands.md` is an enumeration where every setting and command is its own row, and `local-api-server.md` is the one place endpoint responses are legitimate evidence — provided the body is inspected for real versus fabricated state, since a `200` carrying the hardcoded literals is a gap, not a pass.
- **`board` (11 files, 775 lines)**: Highest false-green risk, because the board is where the transport defect lives. Its defining rule is that every state-changing claim must be re-observed after settle and after reload, since the coalesced push re-asserts fabricated payload values roughly 40 ms after any click.
- **`getting-started` (8 files, 488 lines)**: The onboarding path, where a gap is most visible to a new user. Documented launcher commands and flags are run literally rather than read. Excludes the stale headless page by design.
- **`project` (12 files, 480 lines)**: Panel-tab documentation, where "the tab mounts but its actions are inert" is most likely. Rows are per documented control, not per tab, and authoring surfaces must show a full create → edit → persist → reload round trip.
- **`artifacts` (14 files, 462 lines)**: Fourteen small surfaces, several depending on external integrations. Rendering claims require looking at the output rather than checking a status code, and an upstream API change must be recorded as such rather than misattributed to a standalone gap.
- **`pm-tools` + `integrations` + `agents` (9 files, 456 lines)**: Smallest by line count, highest risk in practice — live credentials for three providers, documented outbound writes, and a ticket-import path with known destructive pruning. Disposable remote objects only.
- **Closeout**: Runs the quality gate over the finished register *before* any planning, sending failed sections back for re-audit; deduplicates every gap against existing plans (especially the seven under Standalone Push-Path Parity); writes plans for the residual; and rewrites the stale headless page so every claim in it traces to a `LIVE` row.

## Dependencies & sequencing

**Before this feature starts:** land `standalone-push-parity-guard.md` and `restore-backlog-view-to-standalone-host.md` from the **Standalone Push-Path Parity** feature. Two human parity audits have already been run and declared complete; a third human audit is the same bet with better rules. The mechanical guard is the one intervention never tried — it fails in CI and cannot be talked out of a verdict. Landing it first also means this audit checks a much smaller residual instead of spending its budget re-finding the transport class one doc page at a time.

**Within the feature:**

1. **Harness** is a hard prerequisite for all six section subtasks. A stale build or a thin scratch workspace silently converts real gaps into untestable rows, so nothing starts until its checklist passes.
2. **The six section subtasks run in parallel** — they share only the register, appending disjoint row sets. Two coordination constraints: standalone is a single writer, so concurrent sections must not each start their own host against the same workspace; and `getting-started` exercises the launcher, which starts and stops hosts.
3. **Closeout** requires all six sections complete. It is the last place a false "parity is complete" could enter, which is why its quality gate runs before any plan is written rather than after.

**Reconcile before the `board` subtask:** `standalone-kanban-column-parity-audit.md` is in CREATED and covers overlapping verb/column divergence. Fold it in or execute it and mark the overlapping rows covered — do not audit the same ground twice.

**Overlap by design:** many `board` and `getting-started` findings will map onto the seven Standalone Push-Path Parity plans. Those are linked, never re-planned; the closeout dedupe step is where that is enforced.
