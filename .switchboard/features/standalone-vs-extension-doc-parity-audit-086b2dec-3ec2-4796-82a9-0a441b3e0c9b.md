# Standalone vs Extension Doc-Parity Audit

**Complexity:** 5

## Goal

Read every line of the switchboard-site documentation — which documents the extension feature set, i.e. the full product — and check each documented feature against what the standalone browser host actually delivers at runtime. Every mismatch is a standalone defect to fix. The output is a complete claim register with a verdict and evidence class per feature, and a plan for every confirmed gap.

Standalone parity has been declared complete several times and has not been, because the checks used were structurally incapable of failing: the bootstrap default arm delegates every verb to the provider, so every verb is reachable and every DB write lands even when the feature is entirely dead in the browser. This audit therefore bans verb reachability, success responses, landed DB writes and handler presence as evidence. Runtime observation in a running browser host is required for any live verdict on a user-facing feature.

The headless-switchboard page **contributes no requirements** — it may never justify, excuse or close a gap on any other page. But it *is* audited, in the `getting-started` subtask, and it is rewritten from the register in the closeout subtask. It is both an input of claims and an output.

## Prior art — this is the third parity audit, and the first two were declared complete

Two standalone parity efforts already shipped and are marked CODE REVIEWED: the `standalone-board-parity-aa872dcc` feature (which wired the `bootstrap.ts` `default:` verb fallthrough) and `browser-cockpit-editor-parity-concurrency-85f62bab`. Both declared parity. Backlog, the column structure, routing config, the theme and the workspace-selection fields were dead in the browser throughout.

The reason is recorded in this repo already, in the Problem section of `standalone-kanban-column-parity-audit.md`: *"The parity feature's triage classified these as 'works' because they return `{success: true}` — the divergence is behavioral, not functional."*

That is the whole failure mode, written down before this feature existed. This audit is therefore not justified by being more thorough than its predecessors — thoroughness was never the issue. It is justified only by two things its predecessors lacked: **a driver that is not a developer's memory** (the published doc set, read line by line), and **an evidence standard that bans the criterion the previous audits passed on**. If either is relaxed during execution, this feature produces another worthless completion claim and should be abandoned rather than finished.

## Corrections applied 2026-08-09 (improve-feature pass)

This feature's first draft carried factual errors of exactly the class it exists to eliminate. All eight subtasks were corrected against the tree. The material ones:

1. **The stated root cause was false.** Every subtask asserted that `KanbanProvider.postMessage` "has no sink in standalone — neither `_broadcaster` nor `_panel` is set." It is not true: `bootstrap.ts:692` constructs a shared `BroadcastHub`, `:758` assigns it to the Kanban provider, `:1757` forwards the API server into it, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`broadcastHub.ts:80-91`). **Provider pushes reach the browser.** The sibling Push-Path Parity feature had already corrected this on 2026-08-07; this feature was still propagating the superseded version. An auditor briefed on a dead transport would have misattributed every stale-UI observation and produced the wrong plans.

2. **Every code citation was stale.** `bootstrap.ts:341-346`/`:370-375` → actually `:404-410` and `:433-439`; `:395` → `:459`; `:1062-1087` → `:1140`; `KanbanProvider.ts:2105-2120` → `:2161`; `:7261-7291` → `:7365`. Re-derived and corrected throughout, with the five fabricated payload fields now named per line.

3. **`standalone-workspace-selection-fields-hardcoded.md` does not exist.** Two subtasks instructed the auditor to link it. It was merged into `standalone-state-builders-delegate-to-getfullstatemessages.md` on 2026-08-07, along with four others. Every subtask now carries an explicit gap → plan link mapping.

4. **"The seven plans under Standalone Push-Path Parity" — there are three.** Corrected everywhere.

5. **`headless-switchboard.md` was wrongly excluded.** Justified as stale; it was revised 2026-08-01 and its error is over-confidence, not obsolescence. 106 lines of unverified standalone-specific claims are now audited in `getting-started` (which rises to 9 files / 594 lines, complexity 4 → 5) under an audited-but-never-cited rule.

6. **The closeout gate was unfalsifiable** — it required 62 files to carry coverage while the sections covered 60. The corpus is 61 markdown files / 3555 lines plus `index.astro` as one `N/A` row; per-section totals now reconcile exactly.

**Reconciled: `standalone-kanban-column-parity-audit.md` is linked, not folded in.** It is in CREATED at complexity 6 and covers `getNextKanbanColumn` — a hardcoded next-column map in `bootstrap.ts` duplicating the extension's `_getNextColumnId` without visibility awareness. It is a **code-fix plan**, not a doc audit: its deliverable is a shared resolver plus a drift gate, while the `board` subtask's deliverable is register rows. They share subject matter, not output. The `board` subtask therefore links it wherever a documented advance/move fails on wrong-next-column, and does not re-plan or execute it. It also carries its own unresolved design decision (extract the shared resolver vs thread state into the standalone map), which is not this feature's to settle.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone Doc-Parity Audit — Harness, Claim Register and Evidence Rules](../plans/audit-standalone-against-extension-docs.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — `reference` Section (6 files, 788 lines)](../plans/audit-docs-section-reference.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — `board` Section (11 files, 775 lines)](../plans/audit-docs-section-board.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — `getting-started` Section (9 files, 594 lines)](../plans/audit-docs-section-getting-started.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — `project` Section (12 files, 480 lines)](../plans/audit-docs-section-project.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — `artifacts` Section (14 files, 462 lines)](../plans/audit-docs-section-artifacts.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — `pm-tools`, `integrations` and `agents` Sections (9 files, 456 lines)](../plans/audit-docs-section-pm-tools-integrations-agents.md) — **PLAN REVIEWED**
- [ ] [Doc-Parity Audit — Closeout: Convert Gaps to Plans and Rewrite the Standalone Doc](../plans/audit-docs-closeout-gaps-to-plans-and-doc-rewrite.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## How the Subtasks Achieve This

- **Harness, Claim Register and Evidence Rules**: Builds and installs **both** artefacts from one commit — `npx switchboard` runs `dist/standalone/cli.js` while "Open in Browser" runs the installed VSIX, so rebuilding one and not the other audits half the verdicts against a stale build. Provisions a scratch workspace carrying representative state (a custom column and a hidden role are mandatory, or the highest-yield defect is invisible), launches both browser hosts within the single-writer constraint, confirms the PTY layer loaded, and creates the register with the binding evidence rules in its header. Produces no verdicts — it produces the instrument and the rules everything else records into.
- **`reference` (6 files, 788 lines)**: The largest and most claim-dense section. `settings-commands.md` is an enumeration where every setting and command is its own row, and `local-api-server.md` is the one place endpoint responses are legitimate evidence — provided the body is inspected for real versus fabricated state, since a `200` carrying the hardcoded literals is a gap, not a pass.
- **`board` (11 files, 775 lines)**: Highest false-green risk, because the board is where the fabricated-payload defect lives (not a transport defect — see Corrections). Its defining rule is that every state-changing claim must be re-observed after settle and after reload, since the coalesced push re-asserts the hardcoded literals roughly 40 ms after any click. It also requires a workspace carrying a real custom column and a hidden role, without which `updateColumns → DEFAULT_KANBAN_COLUMNS` is indistinguishable from correct behaviour.
- **`getting-started` (9 files, 594 lines)**: The onboarding path, where a gap is most visible to a new user — plus the standalone product page itself. Documented launcher commands and flags are run literally rather than read. `headless-switchboard.md` is audited here under the audited-but-never-cited rule: its 106 lines carry the densest concentration of standalone-specific claims in the corpus, and every one is a row to test while none may be the basis for a verdict anywhere.
- **`project` (12 files, 480 lines)**: Panel-tab documentation, where "the tab mounts but its actions are inert" is most likely. Rows are per documented control, not per tab, and authoring surfaces must show a full create → edit → persist → reload round trip.
- **`artifacts` (14 files, 462 lines)**: Fourteen small surfaces, several depending on external integrations. Rendering claims require looking at the output rather than checking a status code, and an upstream API change must be recorded as such rather than misattributed to a standalone gap.
- **`pm-tools` + `integrations` + `agents` (9 files, 456 lines)**: Smallest by line count, highest risk in practice — live credentials for three providers, documented outbound writes, and a ticket-import path with known destructive pruning. Disposable remote objects only.
- **Closeout**: Runs the quality gate over the finished register *before* any planning, sending failed sections back for re-audit; reconciles the corpus arithmetic (61 markdown files / 3555 lines, plus `index.astro` as one `N/A` row); deduplicates every gap against existing plans — the **three** under Standalone Push-Path Parity plus `standalone-kanban-column-parity-audit.md`; writes plans for the residual; and rewrites the headless page from its own audited rows so every claim traces to a `LIVE` row.

## Dependencies & sequencing

**Before this feature starts:** land **all three** subtasks of the **Standalone Push-Path Parity** feature — `standalone-push-parity-guard.md`, `standalone-state-builders-delegate-to-getfullstatemessages.md`, and `restore-backlog-view-to-standalone-host.md`.

The first draft named only the guard and the backlog plan. That was an ordering error: **the guard fixes nothing** (it turns the gap into a CI number) and the backlog plan owns a queue-retention defect. The plan that actually removes the fabricated payload — `DEFAULT_KANBAN_COLUMNS`, the null workspace-selection fields, `cliTriggersState: false`, `theme: 'afterburner'`, `routingConfig: {}` — is the **delegation** plan, and it was omitted. Auditing before it lands means spending the budget re-finding one defect class page by page, in a corpus of 61 files where it touches columns, routing, triggers, theme, repo scope and control-plane mode.

Two human parity audits have already been run and declared complete; a third human audit is the same bet with better rules. The mechanical guard is the one intervention never tried — it fails in CI and cannot be talked out of a verdict. Land the guard, then the delegation, then audit the residual.

**Within the feature:**

1. **Harness** is a hard prerequisite for all six section subtasks. A stale build or a thin scratch workspace silently converts real gaps into untestable rows, so nothing starts until its checklist passes.
2. **The six section subtasks run in parallel** — they share only the register, appending disjoint row sets across 61 disjoint files. Three coordination constraints: `npx switchboard` is an **exclusive** single writer and refuses to start against a workspace the extension already serves, so concurrent sections cannot each stand up their own host on one workspace; `getting-started` is the most disruptive neighbour, since it exercises the launcher, its flags and its exclusivity claim — starting, stopping and re-pointing hosts; and `pm-tools`/`integrations`/`agents` performs the only outbound writes and the only destructive import, so it should not overlap a section mid-observation.
3. **Closeout** requires all six sections complete. It is the last place a false "parity is complete" could enter, which is why its quality gate runs before any plan is written rather than after.

**Reconciled — `standalone-kanban-column-parity-audit.md` is linked, not folded in.** See the Corrections section above: it is a code-fix plan whose deliverable is a shared next-column resolver plus a drift gate, not register rows. The `board` subtask links it wherever a documented advance/move fails on wrong-next-column, and neither re-plans nor executes it.

**Overlap by design:** many `board`, `getting-started`, `reference` and `project` findings will map onto the **three** Standalone Push-Path Parity plans. Those are linked, never re-planned; the closeout dedupe step is where that is enforced. Note that five plans merged into the delegation plan on 2026-08-07 and no longer exist as files — a row linking one of them is a stale link to repair, not a plan to open. Each section subtask carries the gap → plan link mapping inline.
