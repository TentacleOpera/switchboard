# Redistribute project.html Tabs to Reduce Overload

## Goal

Reduce the `project.html` webview from **10 top-level tabs to 6** by relocating three feature areas to homes where they thematically belong, and by demoting the Architect tab to a per-tab button.

**Problem / context.** `project.html` has accreted 10 tabs (Kanban Plans, Epics, Projects, Constitution, Dev Docs, System, Tuning, Architect, NotebookLM, Remote). Two of them were previously *moved into* this file — code comments record NotebookLM as "relocated from planning.html" and Remote as "relocated from kanban.html" — but the tab bar was never rebalanced afterward, so the view became a catch‑all. The tab bar now overflows horizontally.

**Root cause.** Three of the tabs are not "project browsing" surfaces at all:
- **Remote** is *connection config* — it configures the same Linear/Notion/ClickUp providers that `setup.html` already has dedicated tabs for. It is duplicated conceptually with Setup.
- **NotebookLM** is a *tooling on-ramp* (bundle code → upload → import) and **Dev Docs** is an *authored-doc store*; both are thematically "research / online docs", which is exactly what `planning.html` already hosts (its DOCS tab has online doc providers, its RESEARCH tab has research docs).
- **Architect** is a *meta action* over the governance docs, not a browsable surface of its own — it's a terminal launcher + prompt copier.

**Target end state — `project.html` tabs:** Kanban Plans · Epics · Projects · Constitution · System · Tuning (6).

The three moves:
1. **Remote → `setup.html`** (new "Remote" config tab beside ClickUp/Linear/Notion).
2. **Architect → a button**, not a tab. The two Architect actions (Open Architect Terminal, Copy Architect Prompt) appear as buttons in the controls-strip of the **Projects, Constitution, and System** tabs only (not Tuning, not the relocated Dev Docs).
3. **NotebookLM + Dev Docs → `planning.html`** (added to its research tab bar).

## Metadata
- **Plan ID:** 6A46C1BC-AB5F-453F-B063-4508BE3AC8F1
- **Tags:** [frontend, ui, ux, refactor]
- **Complexity:** 6

## User Review Required
- **Architect button placement confirmed:** Projects, Constitution, System tabs only. (Decided.)
- **Remote command routing:** Move 1 changes *which provider serves* the Remote UI. Setup's `SetupPanelProvider` already holds a `_kanbanProvider` reference (`SetupPanelProvider.ts:24,38`), so the new Setup handlers can delegate to the existing `KanbanProvider.remote*` methods directly. Confirm we route through KanbanProvider rather than duplicating remote logic in SetupPanelProvider.
- **Dead host code:** After the moves, the Remote and Architect-list handlers in `PlanningPanelProvider._handleMessage` become unreferenced. Plan removes the Remote cases and the Architect *doc-list/preview* cases, but **keeps** `openArchitectTerminal` / `copyArchitectPrompt` (still used by the new buttons). Confirm removal vs. leaving them as no-ops.

## Complexity Audit

### Routine
- **NotebookLM + Dev Docs move to planning.html is UI-only.** `project.html` and `planning.html` are served by the **same** provider (`PlanningPanelProvider.ts`) through the **same** `_handleMessage` router. The host cases (`loadDevDocs`/`readDevDoc`/`saveDevDoc`/`createDevDoc`/`deleteDevDoc`; `airlock_export`/`airlock_openNotebookLM`/`airlock_openFolder`/`importNotebookLMPlans`/`notebookDefaultRoot`) already reply to whichever panel sent the message (`isProject ? _projectPanel : _panel`). So **no host handler moves** — only the tab markup and the webview-side listeners move from `project.html`/`project.js` into `planning.html`/`planning.js`.
- **Architect demotion.** Removing the tab and adding three buttons that post the existing `openArchitectTerminal` / `copyArchitectPrompt` commands. Host handlers unchanged.
- Deleting tab buttons + panes and their CSS selector entries.

### Complex / Risky
- **Remote → Setup is cross-provider.** The Remote UI currently posts to `PlanningPanelProvider` (which delegates to `KanbanProvider`). Moving the UI into `setup.html` means `SetupPanelProvider` must grow new message cases that call the **same** `KanbanProvider.remote*` methods and post replies back to the *Setup* webview. This spans `setup.html` (markup), setup's inline `<script>`, and `SetupPanelProvider.ts` (router).
- **The `setProjectContextSyncEnabled` naming trap.** The Remote tab owns the *sync* trio `getProjectContextSyncStatus` / `setProjectContextSyncEnabled` / `projectContextSyncNow` (these move with Remote). The **Projects** tab owns a *different, similarly-named* toggle `setProjectContextEnabled` / `projectContextEnabled` (PRD injection — this **stays**). Do not conflate them; only the `*Sync*` trio migrates.
- **Shared CSS selector lists.** `#devdocs-preview-content` (and friends) are baked into dozens of grouped selectors in `project.html`'s `<style>` (markdown preview, cyber theme, claudify theme). Those entries must be ported to `planning.html` and removed from `project.html` without breaking the remaining selectors in each comma-group.

## Edge-Case & Dependency Audit

- **Persisted state / migrations (published extension, ~4k installs):** These are UI relocations; none change *storage*. Remote config lives in `KanbanProvider`/`RemoteControlService` (unchanged). Dev docs remain files under `.switchboard/devdocs/*.md` (unchanged). No destructive migration is required. **One low-risk carryover:** the NotebookLM `notebook.root` default is persisted per-webview-state; because the planning panel is a different webview than the project panel, a user's previously-remembered root won't auto-populate in the new location — it re-derives from the workspace filter on first use. This is a convenience default, not user data; acceptable, but note it.
- **Race / duplication:** `KanbanProvider` already has a duplicate remote case-block (~`KanbanProvider.ts:6318`). Do not add a third path; Setup delegates to the existing `remote*` methods.
- **Reply routing:** For the planning.html moves, confirm replies land on the planning panel (they will, since `isProject=false` when the planning panel is the sender). For Setup, replies must target the Setup webview, not the project panel.
- **Button ID collisions:** `btn-open-architect` currently appears once. Placing the action in 3 tabs needs unique IDs or a shared class + delegation (plan uses a `.btn-open-architect` / `.btn-copy-architect-prompt` class with a per-strip workspace lookup).

## Dependencies
- None external. All within the `switchboard` extension webviews + providers.
- Ordering suggestion: do Move 3 (NotebookLM+DevDocs → planning) and Move 2 (Architect button) first — they are low-risk and self-contained — then Move 1 (Remote → Setup) which is the cross-provider change.

## Adversarial Synthesis
Key risks: (1) the sync trio's enable toggle (`setProjectContextSyncEnabled` → `projectContextSetEnabled`, `KanbanProvider.ts:2087`) was missing from the Setup delegation list — without it the sync-enable button is dead in Setup (now added); (2) migrating the wrong project-context command (`setProjectContextEnabled` stays vs `setProjectContextSyncEnabled` moves — differ by one word); (3) CSS comma-group surgery on `#devdocs-preview-content`/`#remote-content` selectors can leave dangling commas or strip siblings; (4) Remote replies posting to the wrong webview (Setup handlers must use their own `postMessage`, not `_projectPanel`). Mitigations: audit checklist in Edge-Case section, grep both command names before deleting, edit each CSS group surgically, and use the Setup panel's own postMessage for all Remote replies.

## Proposed Changes

### Move 3 — NotebookLM + Dev Docs → `planning.html` (do first)

**`src/webview/project.html`**
- Remove tab buttons `data-tab="notebook"` (line ~1675) and `data-tab="devdocs"` (line ~1671).
- Remove panes `#notebook-content` (~1901–1943) and `#devdocs-content` (~1869–1898).
- Port the NotebookLM/Dev Docs CSS to planning.html and strip it here: `#notebook-content` rules (`~1654`, `#notebook-content.active` at `~1650`, claudify `#notebook-content` at `~1656`), and every occurrence of `#devdocs-preview-content` / `#devdocs-content` inside the grouped markdown/cyber/claudify selector lists (throughout `~272`–`~1175`). Remove only the devdocs/notebook tokens from each comma-group; keep the rest.

**`src/webview/project.js`**
- Remove Dev Docs element refs (`~410–417`) and NotebookLM listeners (`~3881–3928`), plus their inbound message cases (`devDocsList`/`devDocContent`/`devDocSaved`/`devDocCreated`/`devDocDeleted`; `notebookDefaultRoot`/`importNotebookLMPlansResult`/`airlock_exportComplete`; `webai-status` updates at `~1304–1318`).

**`src/webview/planning.html`**
- Add `NOTEBOOKLM` and `DEV DOCS` buttons to the research tab bar `#research-tab-bar` (line ~3437) and add the two panes (cloned from the removed project.html markup, ids unchanged so JS matches).
- Paste the ported CSS from project.html.

**`src/webview/planning.js`**
- Add the moved element refs, listeners, and inbound message cases (identical logic to what was removed from project.js).

**`src/services/PlanningPanelProvider.ts`**
- **No changes** to `_handleMessage` — the DevDocs/NotebookLM cases (`~2372`, `~2473–2551`, `~3109–3136`) already serve the planning panel via the shared router.

### Move 2 — Architect tab → button on Projects / Constitution / System

**`src/webview/project.html`**
- Remove tab button `data-tab="architect"` (line ~1674) and pane `#architect-content` (~2113–2149).
- In each of the three controls-strips — Projects (`~1724`), Constitution (`~1793`), System (`~1838`) — add two buttons using a shared class:
  ```html
  <button class="strip-btn btn-open-architect" title="Open a guided Architect terminal">Architect</button>
  <button class="strip-btn btn-copy-architect-prompt" title="Copy the Architect prompt">Copy Architect Prompt</button>
  ```

**`src/webview/project.js`**
- Replace the single-ID architect listeners with class-based delegation: for each `.btn-open-architect` post `{ type: 'openArchitectTerminal', workspaceRoot }`; for each `.btn-copy-architect-prompt` post `{ type: 'copyArchitectPrompt', workspaceRoot }`, deriving `workspaceRoot` from the active tab's workspace filter.
- Remove the architect doc-list/preview wiring (`architect-doc-list`, `loadArchitectDocStatus`, `readArchitectDoc`, inbound `architectDocStatus`/`architectDocContent`).

**`src/services/PlanningPanelProvider.ts`**
- **Keep** `openArchitectTerminal` (`~4391`) and `copyArchitectPrompt` (`~4415`) and their helper `buildArchitectPrompt`.
- Remove now-orphaned `loadArchitectDocStatus` (`~4396`), `readArchitectDoc` (`~4406`), and `gatherArchitectDocStatus` (`~1160`). **Confirmed safe to remove:** grep shows `gatherArchitectDocStatus` has exactly one call site (line 4401, inside the `loadArchitectDocStatus` case being deleted) — no other references exist in the codebase.

### Move 1 — Remote tab → `setup.html` (do last)

**`src/webview/project.html`**
- Remove tab button `data-tab="remote"` (line ~1676) and pane `#remote-content` (~1946–2079), plus its CSS (`#remote-content.active` at ~1650, claudify `#remote-content` at ~1656).

**`src/webview/project.js`**
- Remove remote wiring: init posts at lines `61,63`; the config block at `~3619` and `~3796–3849`; refs `remote-provider`/`remote-subsection-title`; the **sync trio** senders (`getProjectContextSyncStatus`/`setProjectContextSyncEnabled`/`projectContextSyncNow`) and inbound cases (`remoteControlState`/`notionRemoteSetupResult`/`linearAgentSkillText`/`projectContextSyncRunning`/`projectContextSyncStatus`).
- **Do NOT touch** `btn-project-context` / `setProjectContextEnabled` / `projectContextEnabled` (Projects-tab PRD toggle — stays).

**`src/webview/setup.html`**
- Add `<button class="shared-tab-btn" data-tab="remote" role="tab" aria-selected="false">Remote</button>` after the Notion button (~line 570).
- Add `<div class="shared-tab-content" data-tab-content="remote" id="remote-fields">…</div>` following the `#notion-fields` pattern, containing the provider select + config fields + health readout + Linear agent-skill button + the project-context-sync section (markup cloned from the removed project.html pane, restyled to Setup's field conventions).
- The shared `data-tab`/`data-tab-content` script activates it automatically (no tab-switch code needed).

**`src/webview/setup.html` inline `<script>` (line ~1570)**
- Add posting logic for `getRemoteConfig`/`setRemoteConfig`/`runNotionRemoteSetup`/`startRemoteControl`/`stopRemoteControl`/`getRemoteHealth`/`copyLinearAgentSkill` + the sync trio, and inbound handlers for their replies — targeting the Setup webview.

**`src/services/SetupPanelProvider.ts`**
- In the `switch (message.type)` (starts `~125`), add cases for the commands above, each delegating to the existing KanbanProvider methods via `this._kanbanProvider`: `remoteGetConfigPayload` (`KanbanProvider.ts:1911`), `remoteSetConfig` (`1920`), `remoteRunNotionSetup` (`1931`), `remoteStart` (`1951`), `remoteStop` (`1985`), `remoteGetHealthPayload` (`2008`), `remoteBuildLinearAgentSkillText` (`2027`), `projectContextGetStatus` (`2076`), `projectContextSetEnabled` (`2087` — **the sync-enable toggle; do not omit**), `projectContextSyncNow` (`2104`). Post results back to the Setup panel.

**`src/services/PlanningPanelProvider.ts`**
- Remove the now-unused Remote cases (`~2392–2470`), including the sync trio. Leave `KanbanProvider`'s methods intact (Setup now calls them).

## Verification Plan

### Automated Tests
- No automated tests run for this plan (session directive: skip compilation, skip tests). All verification is manual via an installed VSIX.

### Manual Verification (installed VSIX)
1. **project.html** shows exactly 6 tabs: Kanban Plans, Epics, Projects, Constitution, System, Tuning. No horizontal overflow.
2. **Architect button** appears on Projects, Constitution, System (not Tuning). Clicking "Architect" opens the guided terminal / dispatches to the planner role; "Copy Architect Prompt" copies the prompt. Both use the active tab's workspace.
3. **planning.html** shows NotebookLM and Dev Docs tabs. Bundle/Open/Copy-Sprint/Import all work; Dev Docs create/edit/save/delete round-trips to `.switchboard/devdocs/*.md`; preview markdown renders correctly under cyber + claudify themes (confirms CSS ported).
4. **setup.html** shows a Remote tab beside Notion. Provider switch, save config, start/stop remote control, health readout, copy Linear agent skill, and project-context-sync enable/run all function — driving the same underlying `KanbanProvider` state as before (verify a config set in Setup is reflected in board behavior).
5. **Regression:** Projects tab's "PROJECT CONTEXT: ON/OFF" toggle still works (proves `setProjectContextEnabled` was not disturbed by the sync-trio move).
6. **Theme check:** cyber + claudify themes render correctly on the moved panes in their new homes and on the remaining project.html tabs (no dangling CSS from removed selectors).

---

**Recommendation:** Complexity 6 → Send to Coder. Sequence the moves (3 → 2 → 1); Move 1 (Remote → Setup) is the cross-provider change and carries the most risk.
