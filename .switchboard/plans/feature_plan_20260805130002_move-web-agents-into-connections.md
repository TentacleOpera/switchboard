# Move the WEB AGENTS Tab out of Artifacts and into Connections

## Goal

Move the existing WEB AGENTS surface from the Artifacts (planning) panel into the Connections panel, where it belongs alongside the other external-AI hand-offs, without changing what it does.

### Problem & background

**WEB AGENTS is already an external-AI hand-off — it is just filed under the wrong panel.** `src/webview/planning.html:3668` declares the tab (`data-tab="create-plans"`, labelled `WEB AGENTS`) and `:3862-3922` holds its content. Read the intro copy and the shape is unmistakable:

> *"Point an agent at your docs and get back a **high-level plan** — user flows and logic, not code. Paste the plan below and it lands on the board."*

It offers three ways to get docs to an external agent — zip a folder, a public link, or a platform reference read via that platform's MCP (`:3871-3877`) — **Copy planning prompt** buttons for the link and platform paths, a paste-back textarea that turns the returned markdown into a board card, and an optional *"Improve my docs with an agent"* prompt. That is the same copy-a-prompt-to-an-external-AI pattern this feature is built around, shipped and working, sitting in the panel for docs and artifacts.

**Why the misfiling matters more now.** Once Connections exists, a user looking for "how do I get an external AI to do work for me" has two places to look and no way to know there are two. The Artifacts panel keeps a hand-off surface that the Connections panel does not know about, and the Connections panel's Hand-offs tab looks incomplete because the oldest, most-developed hand-off is somewhere else.

**Root cause: it was built before there was a home for it.** The tab id is still `create-plans` while the label reads `WEB AGENTS` — a rename that stopped at the label because there was nowhere better to put the thing. This plan finishes that move.

**What this plan does not do.** It does not change behaviour, rewrite the paste-back flow, or convert it to filesystem write-back. Those are separate questions — see Scope note below.

---

## Metadata
**Complexity:** 4
**Tags:** ui, ux, refactor, frontend
**Project:** browser-switchboard

---

## User Review Required

**None.**

---

## Complexity Audit
* **Score:** 4 / 10

### Routine
* Moving a tab button and its content block between two panel HTML files.
* Moving the corresponding listener block in the webview script.

### Complex / Risky
* **Six live verbs cross a panel boundary.** `createPlansPickFolder`, `createPlansDownloadZip`, `createPlansCopyPrompt`, `createPlansPasteBack`, `createPlansImproveSource` and `createPlansInit` are all in `PLANNING_VERBS` (`src/generated/verbAllowlist.ts`). The allowlist is **generated** — it must be regenerated from source via `npm run catalog:generate`, never hand-edited.
* **Shipped UI on ~4,000 installs.** The whole surface works today. A move that drops one listener produces a tab that renders perfectly and has a dead button — the exact failure mode this feature exists to eliminate.
* **The folder picker is host-dependent.** `createPlansPickFolder` opens a native folder dialog, which is a seam call. Under the standalone host that seam behaves differently, so the tab's availability must be honest in each host rather than assumed.

---

## Edge-Case & Dependency Audit

### Race Conditions
* None. Static UI relocation; no new timers, polling, or concurrent writers.

### Security
* Unchanged. The zip path is documented as *"Docs only, never code"* (`planning.html:3872`) — preserve that guarantee and its copy verbatim. If the move touches the zip builder at all, re-verify the docs-only filter still holds; it is the entire security story of that path.

### Side Effects
* Users who know this surface as a tab in Artifacts will not find it there. Leave a signpost row in the Artifacts tab strip pointing at Connections for at least one release, the same treatment plan 1 gives the Setup panel's Remote tab.
* The Artifacts panel loses a tab, so its strip re-flows: DOCS / HTML / RESEARCH remain.

### Dependencies & Conflicts
* **Hard dependency on the Connections panel plan** — there is nowhere to move this until that panel and its sub-tab structure exist.
* Tab button — `src/webview/planning.html:3668`. Content — `:3862-3922`.
* Listeners — `src/webview/planning.js:1907-1962` (`cp-*` element handles and the six `postMessage` calls).
* Verb arms — `PlanningPanelProvider`, reachable at `POST /planning/verb/<name>`.
* Generated allowlist — `src/generated/verbAllowlist.ts`; regenerate, do not hand-edit.
* **Routing decision, corrected (code review 2026-08-05):** the earlier reconciliation — "no new route; the Connections webview addresses the rail that owns each verb directly" — rested on a false premise about the transport shim and has been reversed. `transport.js:26` derives **one** route prefix per panel from `data-panel`, at script load, with no per-call override, so a `data-panel="connections"` page can only ever post to `/connections/verb/…`. That route now exists (`LocalApiServer.ts:3532`) and dispatches by generated allowlist — `SETUP_VERBS` first, then `PLANNING_VERBS`. The six `createPlans*` arms still stay in `PlanningPanelProvider`; only the door changed.

---

## Dependencies
* Connections Panel — Rename Remote Control and Give It a Rail Entry. Blocking.

---

## Adversarial Synthesis

Key risks: (1) **a dead button after the move** — six live verbs and a dozen element handles cross a panel boundary, and a missed listener yields a tab that renders correctly and does nothing, which looks identical to success until clicked; (2) **verb-routing confusion** — the Connections panel routes to the Setup provider while these arms live in the Planning provider, so the move must decide deliberately how one UI reaches two providers rather than discovering the mismatch at runtime; (3) **regenerating the allowlist by hand** — it is a generated file and hand-editing it drifts from `protocol-catalog.json`. Mitigations: click every control after the move as an explicit verification step rather than trusting a render check; keep the arms where they are and let the panel address both verb rails, which is the smaller change; regenerate via `npm run catalog:generate`.

---

## Proposed Changes

### 1. Verb routing — keep the arms, move only the UI

**Context:** the six arms are Planning verbs and work today. Plan 1 now creates `/connections/verb/<name>` (`LocalApiServer.ts:3532`), which dispatches by generated allowlist — `SETUP_VERBS` first, then `PLANNING_VERBS`.

**Implementation:** **do not move the arms between providers.** Post from the Connections webview exactly as any panel does — `vscode.postMessage({type: 'createPlansCopyPrompt', …})` — and let the shim's single `data-panel`-derived prefix carry it to `/connections/verb/createPlansCopyPrompt`, where the server routes it to `PlanningPanelProvider`. Nothing in the moved listener block changes; only the prefix it lands on differs.

> **Superseded:** "Have the Connections webview address the rail that owns each verb — `/setup/verb/<name>` … `/planning/verb/<name>`. The transport shim already targets a route per call."
> **Reason:** it does not. `transport.js:26` computes one `routePrefix` at script load from `data-panel` and `:280` uses it for every call; there is no per-message override, so a Connections page cannot reach either of those prefixes.
> **Replaced with:** the single `/connections/verb/` route above.

**Logic:** moving six working arms between providers means new allowlist blocks, new schema entries, and a changed return-contract baseline for two providers — all risk, no user-visible benefit. The UI needs to live in Connections; the arms do not need to move with it. There is precedent for the inverse already: `/project/verb/` and `/memo/verb/` both route to `planningVerb`.

**Edge cases:** if a later plan consolidates the arms, it does so deliberately with its own ratchet update. Record that as a possible follow-up, not a requirement.

### 2. `src/webview/planning.html` → `src/webview/connections.html`

**Implementation:** move the tab button (`:3668`) and the `#create-plans-content` block (`:3862-3922`) into the Connections panel as a **Web Agents** sub-tab. Take the `cp-*` CSS with it — verify the class rules (`cp-wrap`, `cp-intro`, `cp-section`, `cp-label`, `cp-radio`, `cp-row`, `cp-input`, `cp-textarea`, `cp-hint`, `cp-optional`) resolve in the new panel rather than assuming they are global.

Rename the tab id from `create-plans` to `web-agents` so the id matches the label at last. This is internal — check nothing keys on the old string before changing it.

Leave a signpost row in the Artifacts strip pointing at Connections.

**Edge cases:** a hand-written "equivalent" of this markup will get the palette and fonts wrong even when every gate passes. Port the existing markup and CSS wholesale; do not rewrite it.

### 3. `src/webview/planning.js` → the Connections script

**Implementation:** move the listener block (`:1907-1962`) verbatim — all `cp-*` element handles, the `cp-source` radio switching that shows and hides the zip / link / platform rows, the enable-disable logic on each button, and the six `postMessage` calls.

**Edge cases:** the buttons start `disabled` with explanatory `title` attributes and are enabled by input handlers. Move the enabling logic together with the buttons, or the tab ships permanently disabled — a failure that looks like a deliberate capability gate rather than a bug.

### 4. Capability honesty per host

**Implementation:** `createPlansPickFolder` opens a native folder dialog through the UI seam. Confirm its behaviour under the standalone host; where the dialog is unavailable, **disable the zip option with a stated reason** and leave the link and platform paths working. Do not present a folder picker that cannot open one.

**Edge cases:** the zip path is the default-checked radio (`planning.html:3873`). If it is unavailable in a host, default the selection to the link option there rather than opening on a disabled section.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* A markup test asserting the six `cp-*` control ids exist in `connections.html` and no longer in `planning.html`.
* A regeneration check that `createPlans*` verbs remain in `PLANNING_VERBS` after `npm run catalog:generate` — the move must not silently drop them from the catalog.

### Manual Verification
1. **Every control, clicked.** Choose folder, download zip, copy prompt (link), copy prompt (platform), paste back and create a card, improve docs. Six verbs, six clicks — a render check is not sufficient and is the specific way this move fails.
2. **Radio switching:** selecting zip / link / platform shows the right row and hides the others.
3. **Disabled-state logic:** buttons start disabled with their tooltips, and enable when their input is filled.
4. **Paste-back end to end:** paste a markdown plan, confirm a card appears on the board.
5. **Styling is ported, not reimplemented:** the tab looks identical to how it looked in Artifacts — same palette, fonts and spacing.
6. **Artifacts panel:** WEB AGENTS is gone from its strip, the remaining tabs re-flow cleanly, and the signpost points at Connections.
7. **Both hosts:** works in the extension and under `npx switchboard`; where the folder dialog is unavailable, the zip option is disabled with a reason and the other two paths still work.
8. **Byte-compat:** `npm run parity:check` and `push-routing:check` stay green; no change to the return-contract baseline for either provider.
9. **Plan import:** confirm the importer registers this plan on the board.

---

## Scope note — the paste-back flow stays as it is

The rest of this feature uses **filesystem write-back**: the external agent writes into `.switchboard/` and a watcher imports it. WEB AGENTS uses **manual paste-back**: the user copies the returned markdown into a textarea.

Do not "modernise" it here. The two return paths serve different surfaces. Write-back needs the agent to have folder access to the workspace — true for Spark's Connected Folders and Cowork, false for claude.ai, ChatGPT, and any browser-only chat. Paste-back is the only path that works for those, and it is the reason this surface can point at *any* web agent rather than only ones with a filesystem.

Offering both, clearly labelled, is the correct end state. If write-back is ever added here it is an additional option beside paste-back, never a replacement, and it is a separate plan.

---

## Recommendation

Complexity 4 → **Send to Coder.**

---

## Review Findings

**The surface was deleted, not moved — fixed in this pass.** `planning.html:3668` (tab button) and `:3862-3922` (the whole `cp-*` block) were removed, and `connections.html` received an empty `<div id="web-agents-container">` in their place, so a shipped, working feature vanished on ~4,000 installs; `planning.js:1898-1962` still holds every `cp-*` handle and all six `postMessage` calls, saved from throwing only by its `if (!rows.zip || !btnZip) return;` guard, which made the loss silent. `src/webview/planning.html` is now restored byte-exact to its pre-feature state, so WEB AGENTS works again where it always did; `connections.html`'s Web Agents sub-tab carries an honest pointer instead of an empty container. MAJOR, now resolved: the move had been blocked by this plan's premise that "the transport shim already targets a route per call" — it does not (`transport.js:26` derives one prefix per panel at script load, `:280` uses it for every call), so the six `createPlans*` Planning verbs were unreachable from a `data-panel="connections"` page. `/connections/verb/<name>` now exists (`LocalApiServer.ts:3532`) and dispatches by generated allowlist; all six verbs were verified to resolve to `planningVerb`, so the move is ordinary work again — the arms still do not move, only the markup and listeners do. **Outstanding for the next coding pass:** move `planning.html:3862-3922` and `planning.js:1898-1962` verbatim with the `cp-*` CSS, click all six controls (a render check is precisely how this failed), and leave the Artifacts signpost. Validation: `tsc --noEmit`, `npm run lint`, `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `icons:parity` and 13 request-chain contract suites (including `panel-scrollbars`, previously 4 red) all pass.
