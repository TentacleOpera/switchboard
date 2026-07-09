# Agents List Needs "Core" / "Optional" Subheaders (Kanban Agents Tab + Onboarding)

## Goal

Split the flat agent list into two labelled groups — **Core** and **Optional** — in both places it appears:

1. The kanban board's **AGENTS** tab (`src/webview/kanban.html`).
2. The first-install **onboarding** CLI-config step (`src/webview/implementation.html`).

**Core** = the six roles that ship enabled/visible at setup: **Planner, Lead Coder, Coder, Intern, Reviewer, Analyst**. **Optional** = every other role. Today both lists are a single undifferentiated column of rows, and the core roles are visually interleaved with optional ones (e.g. Analyst appears *after* the optional Acceptance Tester), which makes the list confusing to scan.

### Problem analysis

**Kanban AGENTS tab** — `src/webview/kanban.html:2834-2880`, a single `.db-subsection` titled "Agent Visibility & CLI Commands" containing 12 `.startup-row` entries in this order:

| # | Role | `data-role` | Default checked? | Group |
|---|------|-------------|------------------|-------|
| 1 | Planner | `planner` | ✅ | Core |
| 2 | Lead Coder | `lead` | ✅ | Core |
| 3 | Coder | `coder` | ✅ | Core |
| 4 | Intern | `intern` | ✅ | Core |
| 5 | Reviewer | `reviewer` | ✅ | Core |
| 6 | Acceptance Tester | `tester` | ❌ | Optional |
| 7 | Analyst | `analyst` | ✅ | Core |
| 8 | Ticket Updater | `ticket_updater` | ❌ | Optional |
| 9 | Researcher | `researcher` | ❌ | Optional |
| 10 | Jules | `jules` | ❌ | Optional |
| 11 | Claude Artifacts | `claude_artifacts` | ❌ | Optional |
| 12 | Phone-a-Friend | `phone_a_friend` | ❌ | Optional |

**Onboarding step** — `src/webview/implementation.html:1436-1489`, 8 rows in the "CONFIGURE CLI AGENTS" step (`#onboard-step-cli`):

| # | Role | `data-role` | Default checked? | Group |
|---|------|-------------|------------------|-------|
| 1 | Planner | `planner` | ✅ | Core |
| 2 | Lead Coder | `lead` | ✅ | Core |
| 3 | Coder | `coder` | ✅ | Core |
| 4 | Intern | `intern` | ✅ | Core |
| 5 | Reviewer | `reviewer` | ✅ | Core |
| 6 | Acceptance Tester | `tester` | ❌ | Optional |
| 7 | Analyst | `analyst` | ✅ | Core |
| 8 | Jules | `jules` | ❌ | Optional |

### Root cause

Purely presentational: the rows are authored as one flat list with no grouping headers, and Analyst (core, default-checked) is positioned after Acceptance Tester (optional, default-unchecked). To get clean Core/Optional sections, Analyst must be **moved up** to sit with the other core roles, and two subheaders inserted.

## Metadata

- **Tags:** agents-tab, onboarding, kanban-ui, implementation-html, layout, presentational
- **Complexity:** 3 / 10
- **Area:** `src/webview/kanban.html`, `src/webview/implementation.html`

## Complexity Audit

**Routine.** HTML reordering plus two lightweight subheader elements in each of two webview files. No JS logic, no message-protocol, no state, no backend, no migration. The only care needed: preserve every row's attributes verbatim when moving Analyst (its `data-role`, checkbox class, ids, placeholder, and adjacent `.agent-description`) so the existing visibility/command wiring keyed on `data-role` continues to work. The Planner "Terminals" pool sub-row must stay attached to Planner.

## Edge-Case & Dependency Audit

- **Wiring is keyed on `data-role`, not DOM order:** the visibility toggles (`.agents-tab-visible-toggle` in kanban, `.onboard-agent-toggle` in onboarding) and the command inputs (ids like `agents-tab-cmd-analyst`, `onboard-cli-analyst`) are selected by attribute/id, not position. Reordering rows is therefore behaviour-preserving **provided each row's inner markup is moved intact**. Do not change any `data-role`, `id`, class, `checked` state, or `placeholder`.
- **Planner pool sub-row:** in the kanban tab, Planner is followed by a `.planner-pool-row` terminal-count block (`kanban.html:2838-2851`) and its own `.agent-description`. These must remain directly under Planner inside the Core group.
- **`.agent-description` rows:** each role row in the kanban tab is followed by an `.agent-description` div; keep each description immediately after its row when moving Analyst.
- **Jules auto-sync checkboxes stay in Optional:** the kanban tab's `#agents-tab-jules-auto-sync` row (`kanban.html:2874-2877`) and onboarding's `#onboard-jules-auto-sync` row (`implementation.html:1485-1489`) belong with Jules → place them at the end of the Optional group.
- **Custom Agents section unaffected:** the separate "Custom Agents" `.db-subsection` (`kanban.html:2882-2904`) is below and out of scope.
- **Onboarding is a subset:** it only lists 6 core + Acceptance Tester + Jules. Core group = Planner, Lead Coder, Coder, Intern, Reviewer, Analyst; Optional group = Acceptance Tester, Jules (+ its auto-sync row). Roles absent from onboarding (Ticket Updater, Researcher, Claude Artifacts, Phone-a-Friend) are not added — onboarding stays intentionally minimal.
- **Styling reuse:** kanban uses `.subsection-header` for the section title (`kanban.html:2835`); onboarding uses `.section-label` (`implementation.html:1431`). For the Core/Optional *sub*-headers, use a lightweight styled label (e.g. a small mono uppercase label matching existing patterns) so they read as sub-groups, not new top-level sections. A new minimal class (e.g. `.agents-group-label`) or inline styles consistent with the file's existing small-label styling is acceptable; do not restyle the parent section header.
- **No default-state change:** grouping is visual only. Checkbox `checked` defaults are unchanged (Analyst stays `checked`; Acceptance Tester stays unchecked). "Core" is defined as "the six default-on roles" — that mapping already matches the current `checked` attributes, so no checkbox edits are required.

## Proposed Changes

### 1. `src/webview/kanban.html` — AGENTS tab (lines 2834-2880)

Within the existing `.db-subsection` (keep its "Agent Visibility & CLI Commands" header at `:2835`), restructure the rows into two labelled groups. **Move the Analyst row + its `.agent-description` (`:2862-2863`) up** to directly after the Reviewer row + description (`:2858-2859`), so Core is contiguous. Insert a "Core" sub-label before Planner and an "Optional" sub-label before Acceptance Tester.

Resulting order inside the subsection:

```html
<div class="subsection-header"><span>Agent Visibility &amp; CLI Commands</span></div>

<!-- CORE -->
<div class="agents-group-label">Core</div>
<!-- Planner row + .planner-pool-row + descriptions (unchanged markup, :2836-2851) -->
<!-- Lead Coder row + description (:2852-2853) -->
<!-- Coder row + description (:2854-2855) -->
<!-- Intern row + description (:2856-2857) -->
<!-- Reviewer row + description (:2858-2859) -->
<!-- Analyst row + description (MOVED UP from :2862-2863) -->

<!-- OPTIONAL -->
<div class="agents-group-label">Optional</div>
<!-- Acceptance Tester row + description (:2860-2861) -->
<!-- Ticket Updater row + description (:2864-2865) -->
<!-- Researcher row + description (:2866-2867) -->
<!-- Jules row + description (:2868-2869) -->
<!-- Claude Artifacts row + description (:2870-2871) -->
<!-- Phone-a-Friend row + description (:2872-2873) -->
<!-- #agents-tab-jules-auto-sync row (:2874-2877) -->
```

Add a small style for `.agents-group-label` in the kanban `<style>` block (near the other agents-tab styles at `kanban.html:1168-1253`), e.g.:

```css
.agents-group-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-secondary);
    margin: 12px 0 4px;
}
.agents-group-label:first-of-type { margin-top: 4px; }
```

**Every row's inner HTML (checkbox `data-role`/`class`/`checked`, `<label>`, command `<input>` id/placeholder, and the following `.agent-description`) is copied verbatim — only the enclosing order and the two new label divs change.**

### 2. `src/webview/implementation.html` — onboarding CLI step (lines 1436-1489)

Same treatment inside `#onboard-step-cli`. **Move the Analyst row (`:1472-1477`) up** to directly after the Reviewer row (`:1460-1465`). Insert "Core" and "Optional" sub-labels.

Resulting order:

```html
<div class="section-label" style="margin-bottom: 12px;">CONFIGURE CLI AGENTS</div>
<!-- intro paragraph (:1432-1435) unchanged -->

<!-- CORE -->
<div class="agents-group-label">Core</div>
<!-- Planner (:1436-1441) -->
<!-- Lead Coder (:1442-1447) -->
<!-- Coder (:1448-1453) -->
<!-- Intern (:1454-1459) -->
<!-- Reviewer (:1460-1465) -->
<!-- Analyst (MOVED UP from :1472-1477) -->

<!-- OPTIONAL -->
<div class="agents-group-label">Optional</div>
<!-- Acceptance Tester (:1466-1471) -->
<!-- Jules (:1478-1484) -->
<!-- #onboard-jules-auto-sync row (:1485-1489) -->

<!-- Save & Finish / Skip buttons (:1490-1500) unchanged -->
```

Add a matching `.agents-group-label` style to implementation.html's `<style>` block (reuse the same rule as above; if a `.section-label` style already exists, model the sub-label on it but smaller/secondary-coloured so it reads as a sub-group).

**All `onboard-agent-toggle` `data-role`s, `onboard-cli-*` input ids, `checked` states, and placeholders are preserved verbatim.**

## Verification Plan

1. Rebuild/reinstall the VSIX.
2. **Kanban AGENTS tab:** open it → two labelled groups appear. Core lists exactly Planner, Lead Coder, Coder, Intern, Reviewer, Analyst (in that order); Optional lists Acceptance Tester, Ticket Updater, Researcher, Jules, Claude Artifacts, Phone-a-Friend, then the Jules auto-sync checkbox.
3. Confirm the Planner "Terminals" pool controls still sit directly under Planner and function.
4. Toggle each visibility checkbox and set a command for Analyst and one Optional role → confirm the setting persists and the sidebar reflects it (proves `data-role`/id wiring survived the reorder).
5. **Onboarding:** trigger the first-install flow (or reset onboarding state) → the CLI-config step shows Core (Planner, Lead Coder, Coder, Intern, Reviewer, Analyst) then Optional (Acceptance Tester, Jules + auto-sync). Save & Finish persists the same commands/toggles as before.
6. Visual check: the "Core"/"Optional" sub-labels read as sub-groups (smaller/secondary) and are visually subordinate to the section header, in both Afterburner and Claudify themes.
7. Regression: no role rows were dropped or duplicated; checkbox default states are unchanged from before (Analyst on, Acceptance Tester off, etc.).
