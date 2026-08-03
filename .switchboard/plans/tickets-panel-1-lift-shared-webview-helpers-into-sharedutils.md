# Lift the helpers Tickets shares with DOCS/HTML out of planning.js into sharedUtils.js

## Goal

Move the generic helper functions that the TICKETS tab shares with the other Artifacts tabs out of `src/webview/planning.js` and into `src/webview/sharedUtils.js`, so that a future Tickets panel can consume them without either duplicating them or dragging the rest of `planning.js` along. **No user-visible behaviour changes in this plan.**

### Problem and background

The TICKETS tab is being extracted into its own panel (see the sibling plans in this set). The blocker is not the ticket code itself — it is that ticket code calls a set of generic helpers that live in the middle of `planning.js` and are shared with the DOCS and HTML tabs.

A call-graph trace over `planning.js` (12,982 lines — verified) found that ticket code occupies roughly 4,600 lines spread across **8 non-contiguous regions**, and that it reaches outward to a small set of non-ticket helpers. If the Tickets panel is cut without addressing these first, there are only two outcomes, both bad:

- **Copy the helpers** into `tickets.js` — now two divergent copies of escaping, overflow-menu and folder-picker logic. Escaping helpers in particular are a security-relevant thing to fork.
- **Import `planning.js` wholesale** into the new panel — defeats the entire point of the extraction and keeps the 13k-line file on the critical path of both panels.

### Root cause

`planning.js` grew as a single script for a single panel, so there was never a reason to distinguish "helper the whole panel uses" from "helper this tab uses". `sharedUtils.js` (486 lines) exists and already holds exactly this category of function (`toAgentRef` `:7`, `escapeAttr` `:12`, `sanitizeUrl` `:16`, `renderInlineMarkdown` `:31`, `renderMarkdown` `:99`, `renderJsonTree` `:389`, and the `initSbClickFlash` IIFE at the tail) and is already injected into both the planning and design panels in **both** hosts:

- Editor host: `PlanningPanelProvider.ts:720-723` and `:1672-1675`, `DesignPanelProvider.ts:943-946` — `{{SHARED_UTILS_URI}}` placeholder substitution.
- Standalone host: `headlessPanelHtml.ts:242/244` (planning), `:278/282` (design), `:315/320` (setup) — served from `/static/webview/sharedUtils.js` as the **first** `<script>`.

The helpers below simply never got promoted into it.

### Scoping reality that governs this whole plan (verified, load-bearing)

`sharedUtils.js` declares its functions at **module top level**, so they land on the global scope. `planning.js` and `design.js` are each wrapped in a `(function() { … })()` IIFE (`planning.js:1`, `design.js:1`), so **any same-named function declared inside those files shadows the shared one**. Three consequences the original inventory did not account for:

1. **`planning.js` already defines `escapeAttr` at `:1718`, shadowing `sharedUtils.js:12`.** They are not equivalent:
   - `sharedUtils.js:12` → `String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;')` — escapes quote **and** apostrophe; `escapeAttr(null)` returns `"null"`.
   - `planning.js:1718` → `String(value || '').replace(/"/g,'&quot;')` — escapes quote **only**; `escapeAttr(null)` returns `""`.

   Every call site in `planning.js` today runs the weaker `:1718` version. Deleting it to "use the shared one" is a **behaviour change**, not a pure move — apostrophes start being escaped in attribute contexts and nullish values start rendering the literal string `null`.

2. **`escapeHtml` is defined TWICE inside `planning.js`** — `:627` ("Helper functions for tickets tab") and `:8384` ("Helper functions") — in the same IIFE scope, with different bodies:
   - `:627` → `String(value || '')…'` → `&#39;` — null-safe, coerces non-strings.
   - `:8384` → `if (!str) return ''; str.replace(…)` → `&#039;` — **throws `TypeError` on a number** (`(123).replace` is not a function) and returns `''` for `0`.

   Because function declarations hoist and the later one wins in a shared scope, **`:8384` is the definition every caller in `planning.js` currently executes, including all the ticket code**, despite `:627` being the one labelled "for tickets tab". `:627` is dead. Picking the wrong body to promote silently changes escaping output (`&#39;` vs `&#039;`) and null/number handling across the entire panel.

3. **`design.js` carries its own private copies** of several candidates — `escapeHtml:594`, `persistTab:152`, `populateWorkspaceDropdown:113`, `getCurrentFolderPaths:655`, `renderFolderListModal:4289`. Since `sharedUtils.js` is injected into the design panel too, promoting these creates a global that design's locals shadow. Promotion therefore **does not de-duplicate design** unless design's locals are also deleted — which is a separate behaviour-risk decision, not a free consequence.

### Candidate helpers

Confirmed shared (ticket code calls them; they are not ticket-specific) — verified definition sites:

| Helper | Site in `planning.js` | Note |
|---|---|---|
| `escapeHtml` | `:627` (dead) and `:8384` (live) | Two bodies — see decision D1 below |
| `escapeAttr` | `:1718` (shadows `sharedUtils.js:12`) | See decision D2 below |
| `htmlToMarkdown` | `:12439` | Single definition, no design copy |
| `flashIconBtn` | `:12463` | DOM-touching |
| `initOverflowMenus` | `:2389` | DOM-touching |
| `_closeAllOverflowPopovers` | `:2361` | Private to the overflow trio |
| `_recomputeAllOverflowTriggers` | `:2384` | Private to the overflow trio |
| `persistTab` | `:146` (design copy `:152`) | Debounced; posts `persistTabState` |
| `populateWorkspaceDropdown` | `:2525` (design copy `:113`) | |
| `getCurrentFolderPaths` | `:3656` (design copy `:655`) | Signatures differ: `(map, filter)` vs design's `(folderPathsByRoot, filterRoot)` |
| `renderFolderListModal` | `:3699` (design copy `:4289`) | Bodies are **not** interchangeable — design's renders design folders |

**Judgement calls — now RESOLVED by call-site trace (do not re-derive; see Resolved Assumptions):**

- **Comment helpers → TICKET-ONLY.** `renderCommentManager:1799`, `formatCommentDate:1918`, `commentAuthorName:1935`, `commentBodyText:1939`, `commentDateRaw:1942`, `optimisticInsertComment:2018`, `rollbackOptimisticComment:2040`, `mergeOptimisticReplies:2080`. Every consumer is inside a ticket region: the comment-manager block itself (`:1877`, `:1906`, `:2037`, `:2050`), the ticket message handlers (`:6437`, `:6451`, `:6462`, `:6475`), and three ticket detail renderers emitting `tickets-comment-author` / `tickets-comment-date` / `tickets-comment-body` markup (`:10788-10790`, `:11649-11651`, `:12288-12290`). `design.js` references them **zero** times. → They move to `tickets.js` in plan 2, **not** into `sharedUtils.js` here.
  > **Superseded:** "Determine whether the comment surface is genuinely shared with DOCS or is ticket-only."
  > **Reason:** Left as an open question the implementer would have to re-derive. The call-site trace answers it definitively — all consumers are ticket code and `design.js` has none.
  > **Replaced with:** Resolved as ticket-only. Recorded in `## Resolved Assumptions`; plan 2 takes them.

  Note `submitComment` is a **verb** (present in `PLANNING_VERBS`), not a function in `planning.js` — there is no `function submitComment` to move. Drop it from the inventory.

- **Mention autocomplete → TICKET-ONLY.** `extractMentionsFromText:2162`, `handleMentionAutocomplete:2182`, `handleMentionKeydown:2248`, `closeMentionDropdown:2298`. Wired exclusively to comment textareas (`:1841-1842`, `:1965-1966`, `:10073-10074`) and the comment submit path (`:1993`, `:10037`). Zero references in `design.js`. → Move to `tickets.js` in plan 2.
  > **Superseded:** "Same question — shared or ticket-only."
  > **Reason:** Same as above; the trace resolves it.
  > **Replaced with:** Resolved as ticket-only.

- **`renderHtmlFolderList:9215` / `renderPlanningHtmlDocs:9086` → LEAVE IN `planning.js`.** These are HTML-tab renderers. If a ticket call path reaches them, break the call rather than promote tab-specific rendering into shared code, and record the call site so plan 2 can rewire it.

The inventory above is a starting point derived from static call-graph analysis, not a contract. Verify each function's actual callers before moving it, and prefer leaving something in `planning.js` over promoting a tab-specific renderer into shared code.

## Metadata

**Tags:** refactor, frontend, security
**Complexity:** 5

> **Superseded:** **Complexity:** 4
> **Reason:** The original score assumed a mechanical lift. The verified duplicate-definition and shadowing hazards (two `escapeHtml` bodies where the dead one is the ticket-labelled one; a `planning.js` `escapeAttr` silently overriding a stricter shared one; three design.js copies with divergent signatures) make this a security-relevant reconciliation with real behaviour-change risk, not a pure move.
> **Replaced with:** **Complexity:** 5 — still Coder-tier, but it now carries named escaping-behaviour decisions.

## User Review Required

Two decisions must be made explicitly and recorded in the completion notes. Both change output, so neither can be made silently under the "no behaviour change" banner:

- **D1 — Which `escapeHtml` body ships?** Recommendation: promote the **`:627`** body (null-safe, coerces non-strings, `&#39;`) and delete **`:8384`**, because `:8384` throws on numeric input and `:627` matches both `design.js:594` and `sharedUtils.js`'s existing `&#39;` convention in `escapeAttr`. This *is* a behaviour change for current callers (`&#039;` → `&#39;`, and numbers stop throwing). Both encodings are valid HTML and render identically; the change is invisible on screen but visible in snapshot diffs.
- **D2 — Does `planning.js:1718`'s `escapeAttr` get deleted in favour of `sharedUtils.js:12`?** Recommendation: **yes**, delete the local. The shared one is strictly safer (escapes `'` as well as `"`). Accept the two behaviour deltas: apostrophes get escaped in attributes, and nullish values render `"null"` instead of `""`. Grep every `escapeAttr(` call site in `planning.js` first and confirm none passes a nullish value into user-visible copy; if any does, wrap it at the call site rather than weakening the shared helper.
- **D3 — Do `design.js`'s private copies get deleted?** Recommendation: **no, not in this plan.** Leave them shadowing. Deleting them is a design-panel behaviour change with no bearing on the Tickets extraction, and `getCurrentFolderPaths` / `renderFolderListModal` have genuinely different bodies between the two files. Record it as follow-up debt.

## Complexity Audit

### Routine

- Cut-and-paste of single-definition, no-conflict helpers (`htmlToMarkdown`, `flashIconBtn`, the overflow trio) from one file to another.
- Both injection paths already exist; no new `<script>` wiring, no new URI placeholder, no host changes.
- No verb, payload-shape or storage changes — `catalog:check` must come back byte-identical.

### Complex / Risky

- **Two divergent `escapeHtml` bodies in one scope, where the live one is not the one labelled for tickets.** Promoting the wrong body silently changes escaping output panel-wide.
- **`planning.js:1718` `escapeAttr` shadows a stricter shared implementation.** Removing the shadow tightens escaping — safe direction, but not a no-op.
- **Shadowing means "promotion" does not equal "de-duplication."** `design.js` keeps five private copies unless separately deleted; the tree will still show two definitions of several names after this plan lands, which will read as a failed move to a reviewer who is grepping.
- `persistTab` is debounced (300ms, keyed `tabKey::workspaceRoot`) and closes over a module-level `_debounceTimers` map. Moving it moves that state to the global scope, shared with design's copy if design's local is ever removed. Keep the timer map co-located with the function.
- `initOverflowMenus` / `flashIconBtn` touch the DOM and must survive a double-load in a panel that injects `sharedUtils.js` once but may re-render.

## Edge-Case & Dependency Audit

**Race Conditions**
- `sharedUtils.js` is injected as the **first** script in the standalone host (`headlessPanelHtml.ts:244/282/320`), before `transport.js` and before the panel's own JS. Anything promoted must therefore not reference `vscode`, `acquireVsCodeApi()`, or any panel global at *load* time. `persistTab` calls `vscode.postMessage` **inside** its body only — safe. Verify no promoted helper captures a panel binding at definition time.
- The `initSbClickFlash` IIFE at the tail of `sharedUtils.js` already guards on `window.__sbClickFlashInit`. Any new DOM-touching initialiser must follow the same idempotency pattern.

**Security**
- Escaping helpers are the security surface of this plan. `escapeHtml` and `escapeAttr` guard every interpolated ticket title, comment body, author name and tag label. A silent downgrade here is an XSS vector, not a cosmetic diff. Decisions D1/D2 exist precisely so the choice is deliberate and reviewable.
- `sanitizeUrl` already lives in `sharedUtils.js`; do not fork or bypass it.
- After the move, assert **exactly one** definition of each promoted name is reachable from `planning.js`'s scope chain — a leftover local silently wins over the shared one and re-opens the divergence.

**Side Effects**
- `sharedUtils.js` is loaded by the **setup** panel too (`headlessPanelHtml.ts:315/320`), not just planning and design. Anything promoted ships to Setup as well. It must not assume `planning.html` DOM ids exist.
- Promoted functions become globals. Confirm no name collides with an existing global in `setup.html`'s inline script.

**Dependencies & Conflicts**
- Blocks plan 2 (Tickets panel extraction) — plan 2 consumes this plan's classification directly.
- Conflicts with nothing else in the feature set: plan 3 touches only providers and `setup.html`; plan 4 has not started. No shared file with either.
- Merge-order note: plan 2 rewrites large regions of `planning.js`. Landing plan 1 first keeps that diff readable; landing them concurrently guarantees conflicts.

## Dependencies

- No prior research sessions — nothing to reference in `sess_…` form.
- **Plan dependency:** none upstream. This plan is a leaf; it may start immediately and in parallel with plan 3.
- **Downstream:** plan 2 (`tickets-panel-2-extract-tickets-tab-into-standalone-panel.md`) requires this plan's completion notes.

## Adversarial Synthesis

**Risk Summary.** The headline risk is that this reads as a mechanical file move while actually being an escaping-semantics reconciliation: `planning.js` holds two divergent `escapeHtml` bodies (the *live* one is the one **not** labelled for tickets, and it throws on numbers) and an `escapeAttr` that silently overrides a stricter shared version. Mitigation is to force D1/D2 as explicit, recorded decisions rather than side effects of a cut-and-paste, and to grep every affected call site before deleting a local. Secondary risk: because `sharedUtils.js` functions are globals and `planning.js`/`design.js` are IIFEs, "promoting" a helper does not remove design's private copy — the plan must state that leftover duplicates in `design.js` are intentional (D3) so a reviewer does not read them as an incomplete move.

## Proposed Changes

### `src/webview/sharedUtils.js`

- **Context:** 486 lines, module-top-level function declarations, loaded first in every host path for planning / design / setup. Already owns `toAgentRef`, `escapeAttr`, `sanitizeUrl`, `renderInlineMarkdown`, `renderMarkdown`, `renderJsonTree`, `initSbClickFlash`.
- **Logic:** Receive the **shared** set only. Co-locate `escapeHtml` immediately after the existing `escapeAttr:12` so the escaping pair reads as one unit.
- **Implementation:** Append/insert `escapeHtml` (body per D1), `htmlToMarkdown`, `flashIconBtn`, `initOverflowMenus` + `_closeAllOverflowPopovers` + `_recomputeAllOverflowTriggers` (move as a unit — the two underscore helpers are private to `initOverflowMenus`), `persistTab` + its `_debounceTimers` map, `populateWorkspaceDropdown`, `getCurrentFolderPaths`, `renderFolderListModal`. Preserve bodies byte-for-byte apart from the D1/D2 decisions.
- **Edge Cases:** No `vscode` / `acquireVsCodeApi` reference at load time. DOM-touching initialisers guard on a `window.__sb…Init` flag like `initSbClickFlash` does. No assumption that `planning.html` ids exist — Setup loads this file too.

### `src/webview/planning.js`

- **Context:** 12,982 lines, single IIFE. Holds the originals plus the two duplicate-definition hazards.
- **Logic:** Delete the promoted originals so the global versions resolve. Delete the dead `escapeHtml:627` **or** `:8384` per D1 (exactly one survives, and it moves out). Delete `escapeAttr:1718` per D2.
- **Implementation:** Remove definitions at `:627`/`:8384`, `:1718`, `:2361`, `:2384`, `:2389`, `:2525`, `:3656`, `:3699`, `:12439`, `:12463`, and `persistTab:146` (keep `window.persistTab = persistTab;` at `:163` working — after promotion the global already exists, so either drop the assignment or keep it as a no-op alias; pick one and be consistent).
- **Edge Cases:** `window.persistTab` / `window.registerWorkspaceDropdown` / `window.getRestoredState` are explicitly published at `:163-168`. Confirm each still resolves after the move. Confirm `planning.js` resolves every promoted name at load — a `ReferenceError` here blanks the whole panel.

### `src/webview/design.js` (no edit — decision only)

- **Context:** Private copies at `escapeHtml:594`, `persistTab:152`, `populateWorkspaceDropdown:113`, `getCurrentFolderPaths:655`, `renderFolderListModal:4289`.
- **Logic:** Leave untouched (D3). They shadow the new globals; the design panel's behaviour is unchanged.
- **Edge Cases:** Record as follow-up debt so a later reader does not treat the surviving duplicates as evidence this plan failed.

## Verification Plan

### Automated Tests

- `npm run lint` clean.
- `npm run test:contract:rendermarkdown` — guards the existing `sharedUtils.js` surface against regression from the additions.
- `npm run catalog:check` — must be **unchanged**; this plan touches no verbs, so any drift means something moved that should not have.
- `npm run icons:parity` — `sharedUtils.js` is reachable from panel CSS icon-class scanning (`scripts/check-icon-parity.js` follows `{{X_JS_URI}}` companions); confirm no rule-coverage change.
- Duplicate-definition assertion: for each promoted name, grep the tree and confirm the count matches the expected post-move state — one definition in `sharedUtils.js`, zero in `planning.js`, and (per D3) the known surviving `design.js` locals. Write the expected counts down before running so a surprise is visible.

### Manual

- Load the Artifacts panel in the **VS Code host** from an installed VSIX (not `dist/`) and exercise every tab: DOCS (source filters, folder modal), HTML (previewer, inspect mode), TICKETS (list, detail, comments, overflow menus), RESEARCH, WEB AGENTS. All must behave exactly as before.
- Load `/planning` in the **standalone browser host** and repeat the same sweep. Both hosts inject `sharedUtils.js` through different code paths (`PlanningPanelProvider.ts:720` vs `headlessPanelHtml.ts:242`), so passing in one proves nothing about the other.
- Load `/design` in the browser host and confirm the design panel still functions — it shares `sharedUtils.js` and is the most likely collateral damage.
- Load `/setup` in the browser host — it also loads `sharedUtils.js` (`headlessPanelHtml.ts:315`) and is the injection path the original inventory overlooked.
- **Escaping spot-check (D1/D2 evidence).** With a ticket whose title contains `' " < > &` and an author name containing an apostrophe, confirm the rendered output is escaped and the raw markup shows the expected entity form. Repeat for a numeric field to confirm the `:8384` `TypeError` path is gone.

## Resolved Assumptions

Settled this pass by direct call-site trace — do **not** re-open these, and do not send them to research:

- Comment helpers (`renderCommentManager`, `formatCommentDate`, `commentAuthorName`, `commentBodyText`, `commentDateRaw`, `optimisticInsertComment`, `rollbackOptimisticComment`, `mergeOptimisticReplies`) are **ticket-only**. Zero `design.js` references. → `tickets.js` in plan 2.
- Mention autocomplete (`extractMentionsFromText`, `handleMentionAutocomplete`, `handleMentionKeydown`, `closeMentionDropdown`) is **ticket-only**. Zero `design.js` references. → `tickets.js` in plan 2.
- `submitComment` is a verb in `PLANNING_VERBS`, not a `planning.js` function. Nothing to move.
- `sharedUtils.js` is injected into **three** panels in the standalone host — planning, design **and setup** (`headlessPanelHtml.ts:242/278/315`).
- All named `npm run` gates in this plan exist in `package.json`.

## Recommendation

**Complexity 5 → Send to Coder.** Ready to execute once D1/D2/D3 are answered. Record the final shared / ticket-only / tab-specific classification and the D1/D2/D3 answers in the completion notes — plan 2 consumes them directly.

## Completion Report

Promoted generic shared helpers (`escapeHtml` per D1, `escapeAttr` per D2, `htmlToMarkdown`, `flashIconBtn`, `initOverflowMenus` + helpers, `persistTab`, `populateWorkspaceDropdown`, `getCurrentFolderPaths`, `renderFolderListModal`) from `src/webview/planning.js` to `src/webview/sharedUtils.js`. Removed shadowed definitions in `planning.js`. Left `design.js` private copies intact per D3. No issues encountered.

