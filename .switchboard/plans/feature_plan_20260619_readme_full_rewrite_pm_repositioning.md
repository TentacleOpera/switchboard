# Reposition & Rewrite the Switchboard README as a Full-Lifecycle AI Agent Platform Landing Page + Startup Guide

## Goal

Full rewrite of `README.md` to reposition Switchboard as a **full-lifecycle AI-agent platform** first and a quota optimiser second, documenting the entire shipped surface and doubling as both the marketplace landing page and the de-facto startup guide. Paired with a full restructure of `docs/how_to_use_switchboard.md` to the same lifecycle-first spine, and removal of the defensive ToS-compliance positioning (relocating the genuine privacy/trust points).

**Core problem / root cause:** The product was pitched in the credit-pricing era ("10 plans for the price of 1") and the current README still leads with that economics, while the features that now carry the value — Constitution (spec-driven governance), Multi-repo / Control Plane, Design (Stitch), Projects/Epics, PM-tool sync — are absent or buried. The doc no longer describes the product. (Full thesis, narrative, inventory, IA, and acceptance criteria are preserved verbatim in §1–§9 below — do not drop them.)

## Metadata
**Tags:** docs, refactor, ux
**Complexity:** 5

## User Review Required

The plan resolves all of §7's open questions, but the following should be confirmed by the requester before the writer ships:

1. **Section order (§4 IA).** Proposed and accepted as a default, but explicitly "open to adjustment before writing." Confirm the lifecycle-leads / quota-demoted ordering is final.
2. **`/archive` and `/export` command surface.** These are NOT workflow files (only `accuracy.md`, `improve-plan.md`, `switchboard-chat.md` exist in `.agent/workflows/`). `/export` is wired to the conversation archive (`src/services/archiveSchema.sql`), `/archive` queries the DuckDB plan archive. Confirm both are user-reachable today before documenting them as first-class chat commands equal to `/improve-plan`.
3. **"Document everything" boundary.** Confirm the 12 manifest settings not named in §3's inventory (see Edge-Case Audit → Dependencies) should all be documented, or whether internal/operational ones (`security.strictInboxAuth`, `polling.*`, `terminal.clearBeforePrompt*`, `autoSelectFirstWorkspace`) are out of scope for a landing page.

## Complexity Audit

### Routine
- Documentation-only change; no source or behaviour edits (§9 out-of-scope is firm).
- Prose editing in two Markdown files (`README.md`, `docs/how_to_use_switchboard.md`) reusing the existing house voice.
- Removing a stale section + link (ToS), correcting deprecated-setting references, inserting marked image placeholders.

### Complex / Risky
- **Accuracy at landing-page scale.** "Document everything" across ~40+ commands/settings/panels with a high cost of error (public marketplace page). The §3 inventory is incomplete vs. `package.json`, so the writer must reconcile against the live manifest, not the plan.
- **Constitution mis-documentation risk.** Constitution is project/DB-stored (configured in the Project panel), NOT a VS Code setting — the writer must not present `constitutionEnabled`/`constitutionContent`/`constitutionLink` as `settings.json` keys.
- **Don't-regress-the-good-parts.** A "full rewrite" must re-home, not silently lose, already-accurate existing sections (chat-command table, pair-programming matrix, Airlock steps, Live Sync detail).

## Edge-Case & Dependency Audit

**Race Conditions**
- None — documentation-only, no concurrent execution paths. (The features *described* include sync race-handling, but documenting them introduces no races.)

**Security**
- The Privacy & licence section is the security-relevant deliverable: it must accurately state that ClickUp/Linear/Notion API tokens are held in VS Code **SecretStorage** and nothing is proxied off-machine. Do not overstate ("no API keys") now that sync features require keys — the old blanket "no API keys" line (README:7, 319) is now partially false and must be qualified, not copied verbatim.
- Verified present: `switchboard.security.strictInboxAuth` (default true, session-token auth for inbox dispatch). Optional to document, but do not contradict it by implying coordination is unauthenticated.

**Side Effects**
- `docs/ToS_COMPLIANCE.md` stays on disk (still externally linkable); only the README section + in-README link are removed (§6).
- Image placeholders (`![…](docs/TODO_*.png)`) will render as broken images until the requester supplies assets — accepted interim per Q6; mark them unmistakably so they are trivially swapped.
- Removing the "Integration test suite" block (current README:244-248) and the "Plan Ingestion Folder" framing (README:179, 215) — confirm no external doc deep-links to those anchors.

**Dependencies & Conflicts**
- **Single source of truth = `package.json` manifest** (`contributes.commands`, `contributes.configuration`) + `src/services/*`, reconciled at write time. Verified during this review (v1.7.3):
  - **Confirmed accurate in the plan:** auto-pull intervals `5|15|30|60` (`IntegrationAutoPullService.ts:1`); Control Plane commands (`scaffoldMultiRepo`, `setupControlPlane`, `clearControlPlaneCache`, `reconcileKanbanDbs`, `resetKanbanDb`, `kanban.controlPlaneRoot`); ClickUp/Linear/Notion token + import commands; `jules.autoSync`; Stitch settings; themes enum `afterburner`/`claudify`; deprecated `workspaceDatabaseMappings` and `theme.cyberPanel`; Constitution injection (`agentPromptBuilder.ts:532, 1344, 1346`).
  - **Correction — Constitution config location:** NOT in `package.json`. Configured via the Project panel; stored as project/DB fields. Verbatim injected header is `PROJECT CONSTITUTION:\nThe following are inviolate rules and invariants for this project:`. Document the *panel*, not a setting key.
  - **§3 inventory gaps (manifest settings the plan does not name; reconcile/decide per User Review #3):** `cli.command/args/yolo/yoloFlags`, `polling.initialWait/interval`, `terminal.clearBeforePrompt/clearBeforePromptDelay`, `plans.defaultOpenMode`, `review.autoRefresh`, `security.strictInboxAuth`, `kanban.completedLimit`, `kanban.dbPath`, `excludeReviewedBacklogFromDropdown`, `autoSelectFirstWorkspace`, `persistPanels`, `controlPlane.onboardingDismissed`, `defaultMode`, `planWatcher.periodicScanEnabled/scanIntervalMs`.
  - **Chat-command provenance:** `/switchboard-chat` and `/improve-plan` map to real files in `.agent/workflows/`; `/archive` and `/export` do not — verify their actual invocation path before presenting all four as equals.

## Dependencies

- None. No upstream session dependencies (`sess_…`) — this is a self-contained documentation change.

## Adversarial Synthesis

**Risk Summary:** The dominant risk is accuracy drift on a public landing page — an incomplete §3 inventory, Constitution mis-documented as a VS Code setting, and a "full rewrite" silently dropping already-correct prose. Mitigations: reconcile every command/setting against the live `package.json` manifest (not this plan) before shipping; document Constitution as a Project-panel feature with its verbatim injected string; explicitly salvage the accurate existing sections; qualify the now-partially-false "no API keys" claim with the SecretStorage reality. Voice-vs-governance tension and image placeholders are non-issues (house style already mixes registers; placeholders are the agreed Q6 interim).

## Proposed Changes

### `README.md` (full rewrite)
- **Context:** 340-line doc currently leading with credit-era economics (lines 5, 13-17), stale "multi-repo database on Google Drive" framing (lines 28, 80, 328), a "Plan Ingestion Folder" section superseded by Plan Scanner (lines 179, 215), an "Integration test suite" block to cut (lines 244-248), and a defensive ToS section + link to drop (lines 317-321). Already-accurate sections to **salvage and re-home**: chat-command table (162-171), pair-programming mode matrix (132-138), Airlock steps (194-202), Live Sync detail (268-293), operation modes (250-266).
- **Logic:** Re-sequence to the §4 IA — repositioned tagline → drag-and-drop hero → How it works → **The full lifecycle (Constitution / Multi-repo / Design lead)** → Getting started → AUTOBAN → PM & sync → Core workflows → Planning tools → Panels → Quota economics (demoted) → Grumpy Engineer → Privacy & licence → Architecture → Links.
- **Implementation:** New lead lifecycle section introducing Projects → Constitution → Epics → Plans; replace Google-Drive framing with Control Plane; replace "Plan Ingestion Folder" with Plan Scanner presets (antigravity / windsurf-Devin / cursor / claudeCode / custom / chat destinations); add missing panels (Project, Design/Stitch, Research/Local Docs, status-bar hub, diagrams, themes); demote savings story/screenshot to a "also saves money" feature; remove ToS section, relocate trust points to Privacy & licence with the SecretStorage qualification; insert marked image placeholders for Project/Design/Research panels; update Architecture (drop Local API server, reflect Control Plane + DuckDB); assert v1.7.3.
- **Edge Cases:** Do not document `LocalApiServer` or `npm run test:integration:*` (excluded per Q2/Q4). Constitution = Project panel, not a setting. Qualify "no API keys." Reconcile every documented setting against the manifest.

### `docs/how_to_use_switchboard.md` (full restructure)
- **Context:** Six sections, five of which are credit-economy framing (§5).
- **Logic / Implementation:** Lifecycle-first onboarding flow (define project + Constitution → epics/plans → board routing → multi-repo execution → review → sync/archive); fold the design-doc-first workflow into "set up your Constitution and design doc"; demote batching / Opus-Sonnet split / pair programming / Airlock into a single "save quota" tactics section; remove or clearly mark the credit figures ("69% saving", "7 vs 30 credits") as illustrative of the old pricing model. Keep the voice.
- **Edge Cases:** Keep figures only if explicitly labelled illustrative; otherwise remove.

### `docs/ToS_COMPLIANCE.md`
- **Context / Implementation:** Leave the file on disk untouched; only remove the in-README section and link (§6). No code references it beyond the README link.

## Verification Plan

> Per session directives: do NOT run project compilation, and do NOT run automated tests — the user runs the suite separately. The checks below are the acceptance gate; execute the manual/reconciliation ones, leave test execution to the user.

### Automated Tests
- No automated tests cover README/guide *content* (docs-only change); no new tests required.
- Existing regression suites are documentation-adjacent at most and are **not** to be run in this session. If the writer alters anything the suites reference (they should not — docs only), the user's separate test run is the gate.

### Manual / reconciliation checks (the real acceptance gate)
- [ ] Cross-check every documented command/setting against `package.json` (`contributes.commands`, `contributes.configuration`) at write time — no invented keys, no omitted shipped settings (or omissions are deliberate per User Review #3).
- [ ] Constitution documented as a Project-panel feature with its verbatim injected string; NOT presented as a `settings.json` key.
- [ ] Deprecated items removed/corrected: `workspaceDatabaseMappings`, `theme.cyberPanel`, "Google-Drive-only" sync framing.
- [ ] ToS section + `docs/ToS_COMPLIANCE.md` link removed from README; file left on disk; trust points (incl. SecretStorage reassurance) relocated to Privacy & licence.
- [ ] `LocalApiServer` and `npm run test:integration:*` absent from the user-facing README.
- [ ] All internal doc links resolve; version stated as v1.7.3.
- [ ] Marked image placeholders present for Project / Design / Research panels.
- [ ] Original voice preserved (beer line, savings story retained as colour).
- [ ] Full §8 acceptance-criteria checklist (below) satisfied.

---

## 1. Why this work exists (the thesis)

Switchboard was conceived in the **credit-based pricing era**, when the headline value was *batching tasks into single prompts to maximise per-prompt credit value*. That era has faded, and so has that pitch. The product has since grown into a **full-lifecycle platform for running AI agent teams** — covering the entire arc from idea and governing spec, through planning, multi-repo execution, review, PM-tool sync, and archive.

The strongest differentiators are no longer about cost. They are about **owning the whole lifecycle**:
- **Constitution** — project-level inviolate rules and invariants, injected into agent prompts so every plan respects the project's spec/governance (spec-driven development, built in).
- **Multi-repo / Control Plane** — one board orchestrating agents across many repos, with a shared control plane rather than per-repo files.
- **Design** — Google Stitch UI generation inside the Design panel, so design artifacts live in the same lifecycle as plans and code.
- Plus the project structure (Projects → Constitution → Epics → Plans) and PM-tool sync that turn it into a genuine delivery tool, not a prompt launcher.

The current README still leads with the old economics ("10 plans for the price of 1", the savings screenshot) and omits most of the platform surface that now carries the value. The `docs/how_to_use_switchboard.md` guide is even more dated — five of its six sections are pure credit-economy framing.

**Goal:** A full rewrite of `README.md` that (a) re-frames Switchboard as a full-lifecycle agent platform first and a quota optimiser second, (b) documents *every* shipped feature, and (c) doubles as both the marketplace landing page and the startup guide. Plus a matching refresh of `how_to_use_switchboard.md` and removal of the now-unnecessary ToS-compliance positioning.

**Non-negotiables from the requester:**
1. Audience = marketplace landing page for users **and** the de-facto startup guide.
2. Full rewrite (not a section patch) — the *value proposition* has changed, not just the feature list.
3. Document **everything in the extension**.
4. **Keep the existing voice** (punchy, irreverent — "drink a beer", the savings story stays as a feature, not the headline).
5. `how_to_use_switchboard.md` needs updating; ToS-compliance content is no longer needed (4000+ downloads, zero bans) — drop the defensive framing.

---

## 2. Repositioning narrative (the new spine)

The rewrite should tell this story, in this order:

1. **What it is now** — a **drag-and-drop** board that *runs* your agent team across the whole delivery lifecycle, not just tracks it. Moving a card dispatches real work. The drag-and-drop model is a primary value prop, not legacy framing: you manage the whole project by moving cards instead of typing into chat — which is what makes it practical to multitask across several agents at once. Lead with this in the hero.
2. **Why it's different** — no orchestration agent, no gateway, no API keys; pure VS Code API automation of agents you already run. Works across CLI *and* IDE/chat agents.
3. **The full lifecycle** — idea → **Constitution** (governing spec) → Projects/Epics → plans → **multi-repo** execution → review → PM-tool sync → archive, with **Design** (Stitch) in the loop. This is the spine, and it leads with the three differentiators: Constitution, Multi-repo, Design.
4. **The agent pipeline** — AUTOBAN, roles, routing, automation.
5. **Quota economics as a feature, not the pitch** — batching, pair programming, Airlock, Jules. Kept, but demoted from headline to "and it also saves you money."

The savings screenshot and "while drinking a beer" voice survive — they move from *thesis* to *colour*.

---

## 3. Source-of-truth feature inventory (everything to be documented)

The writer must document the full surface. Authoritative sources: `package.json` (`contributes.commands`, `contributes.configuration`) and `src/services/*`. Inventory below; the writer must reconcile against the manifest at write time and add anything new.

### Surfaces / panels
- Sidebar (`switchboard-view` webview)
- AUTOBAN / Kanban panel (`openKanban`)
- Setup panel (`openSetupPanel`)
- Planning panel (`openPlanningPanel`, `PlanningPanelProvider`)
- Project panel (`openProjectPanel`) — projects = mini-workspaces; hosts three lists: Kanban, **Epics**, and **Constitution** files
- Design panel (`openDesignPanel`, `DesignPanelProvider`, Google Stitch)
- Research / LOCAL DOCS panel (`LocalFolderService`, `ResearchImportService`; local docs, HTML previews, design-system files, Antigravity Brain artifacts)
- Status bar hub (`openHub`, `switchboard.statusBar.*`, compact mode)

### Kanban / orchestration core
- Drag-and-drop triggering; column controls (Move Selected / Move All / Copy Prompt Selected / Copy Prompt All)
- Routing modes: CLI Triggers (`terminal.sendText`) vs Prompt/clipboard mode
- Complexity routing: High→Lead Coder, Low→Coder, Dynamic threshold, Team Lead cutoff + board-position override
- AUTOBAN automation: per-column agent count, timing interval, batch size
- Roles: Planner, Team Lead, Lead Coder, Coder, Intern, Reviewer (Grumpy Principal Engineer), Acceptance Tester, Analyst, + Custom Agents
- Pair programming: CLI Parallel / Hybrid / Full Clipboard; Aggressive mode
- Batching; Plan review comments; Code mapping (Code Map); Report & send back; Cross-IDE copy workflows

### Lifecycle & project management (new lead emphasis)
- **Constitution** — project-level inviolate rules/invariants (`constitutionEnabled`/`constitutionContent`/`constitutionLink`), injected verbatim into planner and agent prompts as "PROJECT CONSTITUTION: inviolate rules and invariants". This is spec-driven governance and a headline differentiator — give it real estate.
- **Epics** — grouping above plans; worktree dispatch routing is epic-only today (projects do not yet route to worktrees — state this accurately, don't over-claim)
- Projects (mini-workspaces; distinct from epics)
- ClickUp integration (sync, import, automation polling)
- Linear integration (sync, import, automation polling)
- Notion design-doc integration (fetch + cache as Design Doc/PRD source)
- Operation modes: Coding Mode (default, live bidirectional sync) vs Board Management Mode (source→result)
- Live Sync Mode (30s configurable, sync-status indicators, conflict detection, termination/idle rules)
- Auto-pull timers (5/15/30/60 min; off by default)
- Structured DB enabling PM-tool sync generally

### Planning tools
- IDE chat commands: `/switchboard-chat`, `/improve-plan`, `/archive`, `/export`
- Plan file convention: `.switchboard/plans/` at workspace root
- Plan Scanner (`PlanScannerPresets`): auto-detect Antigravity / Windsurf-Devin / Cursor / Claude Code, custom sources, chat plan destinations — this supersedes the README's "Plan Ingestion Folder" framing
- Collaborative planning workflow

### Advanced / platform
- NotebookLM Airlock (bundle code → NotebookLM → import plans)
- DuckDB plan archive (`/archive`, auto-archive on COMPLETED)
- Google Jules integration (`switchboard.jules.autoSync`)
- Multi-repo / Control Plane (`scaffoldMultiRepo`, `setupControlPlane`, `reconcileKanbanDbs`, `clearControlPlaneCache`, `controlPlaneRoot`, `WorkspaceIdentityService`, `ControlPlaneMigrationService`) — replaces the thin "Google Drive sync" story
- Diagram generation (`DiagramRenderer`, `MermaidGenerator`, `DiagramTemplates`)
- Design Doc / PRD attachment + Design System Doc attachment (separate settings)
- Prompt controls / Default Prompt Overrides: accurate coding, Lead Coder inline challenge, advanced reviewer mode, aggressive pair programming, append design doc, unified `team.strictPrompts`
- Git ignore management strategies (targetedGitignore / localExclude / custom / none)
- Prevent agent file opening
- Themes: Afterburner, Claudify (`switchboard.theme.name`, disable cyber animation)

**Explicitly excluded from documentation (resolved):**
- Local API server (`LocalApiServer`) — internal plumbing, largely superseded by the real ClickUp integration; possibly slated for removal. Do **not** document.
- Integration test commands (`npm run test:integration:*`) — cut from the user-facing README (Q4 resolved).

### Trust / privacy
- Completely local, no telemetry, no external servers, MIT license

### Known stale items to drop or correct
- `workspaceDatabaseMappings` (deprecated — mappings now in DB)
- `theme.cyberPanel` (deprecated — always on)
- "multi-repo database on Google Drive" framing → Control Plane model
- ToS-compliance section + link to `docs/ToS_COMPLIANCE.md` (remove — see §6)

---

## 4. Proposed README information architecture

1. **Title + one-line repositioned tagline** (full-lifecycle agent platform)
2. **Hero paragraph** — lead with the drag-and-drop interaction model (manage the whole lifecycle by moving cards, not chatting — ideal when multitasking across agents), then the "no orchestration agent / no API keys / one hand free" hook (voice preserved)
3. **How it works** — bullet summary, reordered to lead with lifecycle/board value
4. **The full lifecycle** *(new lead section — the three differentiators)* — Constitution (governing spec), Multi-repo / Control Plane, Design (Stitch); framed as "Switchboard owns the whole arc from spec to ship". Introduce the Projects → Constitution → Epics → Plans structure here.
5. **Getting started (the startup-guide spine)** — Install → Set up agent team & roles → Create plans → Run pipeline. Onboarding path; kept prominent since the README is also the startup guide.
6. **The AUTOBAN** — column controls, routing modes, complexity routing, automation
7. **Project management & sync** — Projects/Epics, ClickUp/Linear/Notion, operation modes, live sync, auto-pull, archive
8. **Core workflows** — batching, pair programming, plan review comments, code mapping, report & send back, cross-IDE
9. **Planning tools** — chat commands, plan convention, Plan Scanner, collaborative planning
10. **Panels** — Planning, Project, Design (Stitch), Research/Local Docs, status bar hub, diagrams, themes
11. **Quota economics** *(demoted)* — Airlock, Jules, the savings story/screenshot reframed as "also saves money"
12. **The Grumpy Principal Engineer** — keep (it's on-voice and memorable)
13. **Privacy & licence** — local-only, no telemetry, MIT; explicitly reassures users who must enter API keys for ClickUp/Linear/Notion that keys stay in VS Code SecretStorage and nothing leaves the machine (absorbs the worthwhile parts of the old Trust section *without* the defensive ToS framing)
14. **Architecture** — updated to reflect Control Plane, panels, DuckDB (no Local API server)
15. **Links** — GitHub, updated How to Use guide

*(Section order is a proposal — open to adjustment before writing. Hard requirements: the lifecycle/Constitution/multi-repo/Design differentiators lead, and quota economics is demoted.)*

---

## 5. `how_to_use_switchboard.md` refresh

**Resolved: full restructure** (not an in-place patch). Current guide is six sections, five of which are credit-economy framing. New structure mirrors the README's lifecycle spine:
- **New lead flow:** lifecycle-first onboarding — define a project + Constitution → break into epics/plans → route through the board → multi-repo execution → review → sync results back to your PM tool / archive.
- **Keep & reframe:** Design-doc-first workflow (old §1) folds into "set up your Constitution and design doc" — still strong, not credit-specific.
- **Demote into a "save quota" section:** batching, Opus/Sonnet split, pair programming, unlimited-model spreading, Airlock — kept as tactics, no longer the structure of the whole guide.
- **Tone:** same voice; remove the precise-but-now-misleading credit figures ("69% saving", "7 vs 30 credits") or clearly mark them as illustrative of the old credit-pricing model.

---

## 6. ToS-compliance handling

The requester considers ToS-compliance messaging unnecessary (4000+ downloads, zero bans). **Resolved approach:**
- **Remove** the "Trust, account safety and the ToS" section's *defensive* framing and the link to `docs/ToS_COMPLIANCE.md`.
- **Keep** the genuinely valuable trust points (completely local, official VS Code API, no proxy/keys, no telemetry) — relocated into a positive **Privacy & licence** section. This is *important*, not optional: users must enter API keys (ClickUp/Linear/Notion) to use sync features, so the README must reassure them keys stay in VS Code SecretStorage and nothing is proxied off-machine.
- **`docs/ToS_COMPLIANCE.md` file:** leave on disk (harmless, still linkable externally). No code references it beyond the README link.

---

## 7. Risks, edge cases, and open questions

- **Over-claiming.** "Document everything" risks advertising half-finished surfaces (Stitch/Design panel, Project panel, Local API server). Mitigation: writer verifies each feature is actually wired/reachable before giving it landing-page real estate; anything experimental gets a lighter touch or a "preview" note. **(Confirm none should be hidden — requester said document everything, so default is to include all.)**
- **Length.** A full-surface README that's also a landing page can balloon. Mitigation: landing-page scannability up top (hero + bullets + getting-started), deep feature docs below; push contributor/test detail to the bottom or to a separate doc.
- **Screenshots.** New panels (Design, Project, Research) have no screenshots in `docs/`. **Resolved:** images *will* be added, but the requester will capture them. The writer should insert clearly-marked image placeholders (e.g. `![Project panel — Constitution](docs/TODO_project_panel.png)`) at the right spots so they're trivially swapped in later. Ship text-complete now; images land after.
- **Accuracy drift.** The manifest is the source of truth; the writer must reconcile every documented setting/command against `package.json` at write time, not against this plan.

### Open questions — all resolved
- **Q1 (section order):** Accepted, with lifecycle/Constitution/multi-repo/Design promoted to lead (§4 updated).
- **Q2 (Local API server):** Plumbing — excluded from docs.
- **Q3 (`how_to_use`):** Full restructure to mirror the README spine.
- **Q4 (test commands):** Cut from the user-facing README.
- **Q5 (ToS):** Remove section + link, relocate privacy points (incl. API-key/SecretStorage reassurance), leave the file on disk.
- **Q6 (screenshots):** Add later; insert marked placeholders now, requester supplies images.

---

## 8. Acceptance criteria

- [ ] `README.md` fully rewritten; opens by positioning Switchboard as a full-lifecycle agent platform, leading with Constitution / multi-repo / Design, with quota-batching demoted to a feature.
- [ ] Every shipped feature in §3 is represented (reconciled against `package.json` + `src/services` at write time), including Constitution and Epics; Local API server and test commands excluded.
- [ ] Getting-started/startup flow is intact and prominent (README serves double duty as onboarding).
- [ ] Original voice preserved (punchy, the beer line, the savings story retained as colour).
- [ ] Deprecated items (`workspaceDatabaseMappings`, `theme.cyberPanel`, Google-Drive-only sync framing) removed or corrected.
- [ ] ToS-compliance section + link removed; trust points (incl. API-key/SecretStorage reassurance) relocated to Privacy & licence; `docs/ToS_COMPLIANCE.md` left on disk.
- [ ] `how_to_use_switchboard.md` fully restructured to the lifecycle-first positioning with credit-economy figures removed or marked illustrative.
- [ ] Marked image placeholders inserted for new-panel screenshots (Design, Project, Research) for the requester to fill.
- [ ] All internal doc links resolve; version/architecture statements match current state (v1.7.3).
- [ ] No code or behaviour changes — documentation only.

---

## 9. Out of scope
- Any source-code or behaviour changes.
- New screenshots/asset production unless Q6 says otherwise.
- Marketplace metadata (`displayName`, `description`, keywords in `package.json`) — flag if it should change to match, but not part of this plan unless requested.

---

## 10. Recommendation

**Complexity: 5 → Send to Coder.** Documentation-only and mechanically routine, but the surface is large and accuracy on a public landing page is unforgiving — needs an agent that will reconcile against the live manifest and salvage the existing good prose, not an Intern that copies the plan verbatim.
