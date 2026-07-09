# Slim the Claude/Design Integration: Delete the CLAUDE Tab, Relocate Upload + Import, Cut Artifact Download

## Goal

Remove the standalone **CLAUDE** tab from the Design panel (`design.html`) and redistribute its worthwhile capabilities to the tabs where they belong. In the same pass, **remove the artifact *download* direction entirely** — from both the Design and Planning panels — because its only justifying use case cannot actually be served. The end state:

- **Artifact upload** — a plain button (no direction toggle) living in **HTML PREVIEWS** (Design panel) and staying in the Planning panel's HTML/Artifacts tab.
- **claude.ai/design import** — moved into the **DESIGN SYSTEM** tab as a new **"Claude Design Systems"** source, and fixed to use the right tool + host-aware auth. As part of this, the tab's existing **source switcher is converted from a two-button bar into a source dropdown** (Local Docs / Stitch Design Systems / Claude Design Systems), matching the planning.html pattern (`docs-source-filter`).
- **Artifact download** — deleted everywhere.

### Problem

**1. The CLAUDE tab wastes a top-level slot.** The Design panel has 6 tabs: STITCH, **CLAUDE**, BRIEFS, **HTML PREVIEWS**, IMAGES, DESIGN SYSTEM. The CLAUDE tab ([design.html:3749](../../../src/webview/design.html#L3749)) is a **duplicate previewer** (identical tree-pane + iframe + zoom to HTML PREVIEWS) with three controls bolted on: claude.ai/design import, a "Sync to Claude Design" help modal, and artifact upload. All are **episodic** actions that don't justify a permanent per-session navigation slot. The previewer is redundant — HTML PREVIEWS ([design.html:3702](../../../src/webview/design.html#L3702)) already covers it — so deleting CLAUDE loses no preview capability.

**2. The artifact download direction is dead weight.** Its only real justification is "pull in what a teammate shared." That case cannot work:
- Teammates share via the **Share button** → `claude.ai/share/...` **share-links**, which WebFetch **403s** (there's already an `isShareLink()` guard warning exactly this at [planning.js:8153](../../../src/webview/planning.js#L8153)).
- WebFetch's only working target is `claude.ai/code/artifact/{uuid}` fetchable **via your own login** — i.e. **your** artifacts, not a teammate's.
- Even given a teammate's raw artifact URL with access, the result is **read-only** — you can't republish (the Artifact tool overwrites only artifacts you own).

So the download can't do the one thing that would make it useful. Everything the download direction drags along — the direction toggle, the direction-aware labels, the stale-label restore race, the `ARTIFACT_DOWNLOAD_PROMPT` with its false "WebFetch passes your active claude.ai session credentials" wording ([planning.js:8168](../../../src/webview/planning.js#L8168)) — exists to service a mode that shouldn't exist.

**3. Import is wired to the wrong tool + wrong command.** `CLAUDE_IMPORT_PROMPT` ([design.js:4626](../../../src/webview/design.js#L4626)) never names the authenticated **DesignSync** tool, so an agent reaches for WebFetch and **403s** on every `claude.ai/design` URL (verified live — WebFetch 403s on `claude.ai/design/...` even after design-system consent is granted). It also hardcodes `/design-login`, which is the **terminal-only** authorization command; a claude.ai-web session authorizes via `/design-consent` instead (both verified live).

**4. Inconsistent source-selection UI.** The DESIGN SYSTEM tab switches sources via a two-button bar ("Local Docs" | "Stitch Design Systems", [design.html:3628](../../../src/webview/design.html#L3628)), whereas the Planning panel switches sources via dropdowns (`docs-source-filter`, `devdocs-source-filter`). Adding Claude is the moment to harmonize on the dropdown pattern.

### Background

- The user **uses claude.ai/design** (lightly), so import is **preserved, not dropped** — moved to DESIGN SYSTEM where design-system machinery belongs.
- Artifact **upload** is design-system-agnostic (round-trips any local HTML into a shareable rendered page on claude.ai) and keeps clear standalone value — it belongs with the general HTML previewer.
- The design **import** is a genuinely useful download (there's real content on the other side to pull); only the **artifact** download is being cut.
- A prior plan — `feature_plan_20260709132137_artifact-send-button-direction-aware-labels.md` — added direction-aware labels to the Planning panel to disambiguate download vs upload. Cutting the download direction **moots that plan entirely**. This plan **supersedes** it; the direction-aware label work is not implemented — the toggle it labelled is removed instead.

### Root Cause (of the things being fixed, not just moved)

- **Import → wrong channel:** prompt omits DesignSync and hardcodes a host-specific auth command (Problem 3).
- **Download → structurally unusable:** WebFetch cannot use your interactive claude.ai session; DesignSync is the authenticated channel and it is a design-system tool, not an artifact-fetch tool; share-links and design URLs 403 anonymously (Problem 2).

## Key Constraint (shapes the Claude source panel)

The Stitch source panel populates its project dropdown from the **extension backend** (Stitch projects are known to the extension). **Claude Design projects are only reachable via the agent-only `DesignSync` tool** (`list_projects`, `get_file` — confirmed tool surface), which the VS Code extension backend cannot call directly. Therefore the Claude source panel is **prompt-driven**: it collects a project reference (or asks the agent to list projects) and emits an import prompt the agent runs with DesignSync. A live, backend-auto-populated Claude project dropdown is **not** achievable without giving the extension a way to invoke DesignSync — see Deferred.

## Metadata
- **Tags:** `ui`, `ux`, `refactor`, `frontend`
- **Complexity:** 5/10
- **Supersedes:** `feature_plan_20260709132137_artifact-send-button-direction-aware-labels.md`

> **Superseded:** Tags `design-panel`, `planning-panel`, `claude-integration`, `artifacts`, `design-sync`, `cleanup`.
> **Reason:** The improve-plan schema forbids tags outside the allowed set [frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library]. Free-form tags are dropped/ignored by the importer.
> **Replaced with:** `ui`, `ux`, `refactor`, `frontend` (the removal/relocation work is a UI refactor of two webview panels).

## User Review Required

- **None.** All open choices have defensible defaults (see Open Decisions). The import-target-folder default (workspace-root fallback) and the decision to keep backend handler names (`copyClaude*` / `sendClaude*`) are contained, reversible, and do not change product behaviour. No genuine product fork requires a user call.

## Complexity Audit

### Routine
- Deleting the CLAUDE tab button, `#claude-content` div, and `#claude-design-sync-modal` from `design.html`.
- Removing dead Claude-previewer JS from `design.js`.
- Removing the direction toggle + download prompt + direction-aware label machinery from `planning.js` / `planning.html` (net deletion).
- Adding a single upload button to the HTML PREVIEWS control strip.

### Complex / Risky
- **Converting the DESIGN SYSTEM source switcher (two buttons → dropdown) without regressing Stitch.** The `btnStitch` click handler carries side effects (refresh list, inspect-button disabling); these must migrate intact to the new `<select>` change handler.
- **Rewiring the relocated upload button to the destination tab's state.** The Claude upload button reads `activeClaudeDocName` / `activeClaudeDocFolder`. In HTML PREVIEWS it must read the shared `state.activeDocName` / `state.activeDocSourceFolder` (both confirmed set by the shared `selectDoc` handler at [design.js:1172–1245](../../../src/webview/design.js#L1172)), guarded by `state.activeSource` so it only fires on an HTML-folder selection.
- **Import relocation is also a behavior fix** (DesignSync + host-aware auth), not a pure move — and it lands in a prompt-driven Claude source panel (see Key Constraint). **This is the load-bearing part of the plan** — see Adversarial Synthesis / architecture review: relocating the button without the DesignSync rewrite just moves a 403 to a different tab.

## Proposed Changes

### A. `src/webview/design.html`

1. **Delete the tab button** at [design.html:3569](../../../src/webview/design.html#L3569) (`data-tab="claude"`).
2. **Delete the entire `#claude-content` div**, starting at [design.html:3749](../../../src/webview/design.html#L3749) through its closing `</div>` before `<!-- Images Tab -->`. (Clarification: the plan's earlier 3748 anchor was off-by-one; the div opens at 3749.)
3. **Delete `#claude-design-sync-modal`** at [design.html:4029](../../../src/webview/design.html#L4029) outright. It is a low-value static help modal (manual-upload instructions); the "Sync to Claude Design…" button that opens it is deleted too, not relocated.
4. **Add an upload-only artifact button to HTML PREVIEWS** — in `#controls-strip-html` ([design.html:3702](../../../src/webview/design.html#L3702)), after `status-html`, add: an optional redeploy URL input (`design-html-artifact-url`, placeholder `Artifact URL (optional, redeploy to existing)...`), a `Copy upload prompt` button, and a `⇨ Upload to Claude Artifacts` primary button. **No direction toggle.**
5. **Convert the DESIGN SYSTEM source switcher to a dropdown + add Claude.** Replace the two-button `.sub-tab-switcher` bar ([design.html:3628–3631](../../../src/webview/design.html#L3628), ids `btn-design-subtab-local` / `btn-design-subtab-stitch`) with a `<select id="design-source-select">` offering **Local Docs / Stitch Design Systems / Claude Design Systems** (style/behaviour mirroring planning's `docs-source-filter`). Add a new **`#design-claude-systems-panel`** peer to `#design-local-panel` ([3634](../../../src/webview/design.html#L3634)) and `#design-systems-panel` ([3670](../../../src/webview/design.html#L3670)), containing the prompt-driven import UI: the `claude-design-project` input (project URL/ID) and a `Copy import prompt` / `⇨ Import from Claude Design` button, plus a target-folder indicator/picker.

### B. `src/webview/design.js`

6. **Remove dead Claude-previewer wiring:** state fields `activeClaudeDoc*` ([17–19](../../../src/webview/design.js#L17)) + `claudeTargetFolder` ([44](../../../src/webview/design.js#L44)); `'claude'` from the refresh branch ([180](../../../src/webview/design.js#L180)) and `validTabs` ([3013](../../../src/webview/design.js#L3013)); zoom init ([369–370](../../../src/webview/design.js#L369)); workspace-dropdown wiring ([2739–2742](../../../src/webview/design.js#L2739)); folder-modal `'claude'` branches ([3216](../../../src/webview/design.js#L3216), [3772](../../../src/webview/design.js#L3772), [3783](../../../src/webview/design.js#L3783), [3865](../../../src/webview/design.js#L3865), [3979](../../../src/webview/design.js#L3979), [4086](../../../src/webview/design.js#L4086), [4106](../../../src/webview/design.js#L4106), [4737](../../../src/webview/design.js#L4737), [4777–4782](../../../src/webview/design.js#L4777)); preview-target `'claude'` branch ([1270](../../../src/webview/design.js#L1270)); Claude doc-selection handler and `createClaudeDocCard` ([4588–4623](../../../src/webview/design.js#L4588), [4705+](../../../src/webview/design.js#L4705)); `getClaudeWorkspaceRootFallback` ([4644](../../../src/webview/design.js#L4644)) if unused after import is re-parented.
7. **Convert the sub-tab switcher handlers to a dropdown.** Replace the `btnLocal` / `btnStitch` click handlers ([design.js:4169–4199+](../../../src/webview/design.js#L4169)) with a single `design-source-select` `change` handler that shows exactly one of `#design-local-panel` / `#design-systems-panel` / `#design-claude-systems-panel` and sets `state.designSystemSubTab` ∈ `{'local','stitch','claude'}`. **Migrate the existing Stitch side effects** (refresh list, inspect-button disable/enable, and any `local` re-evaluation) into the corresponding branches so nothing regresses.
8. **Relocate + fix import (prompt-driven, under the Claude source panel).** Move `CLAUDE_IMPORT_PROMPT` + the import handler ([4626–4642](../../../src/webview/design.js#L4626)) to bind to the new Claude-panel button. **Rewrite the prompt** to:
   - (a) name **DesignSync** as the fetch channel (`list_projects` to enumerate, `get_file` to read a screen), **not** WebFetch — WebFetch cannot use the interactive claude.ai session and 403s;
   - (b) give **host-aware auth** (both commands verified via live research): "run `/design-login` in the interactive terminal, or `/design-consent` on claude.ai web" to grant design-system access; `/design revoke` undoes it. Reference the **`/design-sync` skill** for the sync workflow. Note: on web, DesignSync's own unauthorized-error text misleadingly says "`/design-login` requires an interactive terminal" — the actual web command is `/design-consent`, so the prompt should state `/design-consent` explicitly rather than relying on that error message.
   - Point `folder` at a defined target (see Open Decisions), not `claudeTargetFolder`.
9. **Relocate artifact *upload* (upload only) to HTML PREVIEWS.** Move `CLAUDE_ARTIFACT_UPLOAD_PROMPT` + `buildClaudeArtifactPrompt` + the copy/send handlers ([4654–4693](../../../src/webview/design.js#L4654)) to the new HTML-tab buttons. **Rewire the source file** from `activeClaudeDoc*` to `state.activeDocName` / `state.activeDocSourceFolder`, guarded by `state.activeSource` (confirm the HTML previewer's `sourceId` value the guard must match — see Edge-Case audit). Keep the "select an HTML/Markdown file first" guard and the `.html/.htm/.md/.markdown` extension check. **Do not add any download prompt.** Note the relocated upload prompt is byte-for-byte the Planning panel's `ARTIFACT_UPLOAD_PROMPT` ([planning.js:8179](../../../src/webview/planning.js#L8179)); consider whether one shared constant is worth it (see Open Decisions — default: leave both, minimize churn).
10. **Delete the sync-help handlers** ([4696–4703](../../../src/webview/design.js#L4696)) — both the `btn-claude-design-sync-help` open handler and the `btn-close-claude-design-sync` close handler go, along with the button and modal.

### C. `src/webview/planning.html`

11. **Remove the direction toggle** button `btn-artifact-direction` ([planning.html:3647](../../../src/webview/planning.html#L3647)).
12. **Relabel the remaining controls to upload-only:** URL input placeholder ([3648](../../../src/webview/planning.html#L3648)) → `Artifact URL (optional, redeploy to existing)...`; copy button ([3649](../../../src/webview/planning.html#L3649), currently `Copy prompt`) → `Copy upload prompt`; send button ([3650](../../../src/webview/planning.html#L3650), currently `⇨ Send to Claude`) → `⇨ Upload to Claude Artifacts`.

### D. `src/webview/planning.js`

13. **Delete download machinery:** `ARTIFACT_DOWNLOAD_PROMPT` ([8155](../../../src/webview/planning.js#L8155)), `isShareLink` ([8153](../../../src/webview/planning.js#L8153)) — **confirmed used only inside `ARTIFACT_DOWNLOAD_PROMPT`** (grep: two references, both in that block), so it is safe to delete with the prompt; `artifactDirectionIsDownload` + `updateDirectionLabel` + the toggle handler + the initial `updateDirectionLabel()` call ([8200–8217](../../../src/webview/planning.js#L8200)).
14. **Simplify `buildArtifactPrompt`** ([8219–8228](../../../src/webview/planning.js#L8219)) to always build the upload prompt: drop the `artifactDirectionIsDownload` branch and the download return, keep the upload branch, and hardcode `kind: 'upload'` so the existing backend confirmation routing (`copyArtifactPrompt` / `sendArtifactPromptToTerminal`) is unchanged.
15. **Confirmation handlers `artifactPromptCopied` / `artifactPromptSent`** ([5074–5090](../../../src/webview/planning.js#L5074)) — **no change needed.**

    > **Superseded:** "Simplify the confirmation handlers … restore to the now-static upload labels; no direction-aware logic and no stale-restore race (both gone with the toggle)."
    > **Reason:** Inspection of [planning.js:5074–5090](../../../src/webview/planning.js#L5074) shows these handlers are already direction-agnostic — they save `btn.textContent` generically and restore it after 2s, with no direction-aware branch and no stale-label restore. The stale-restore race described belonged to the *superseded* direction-aware-labels plan, which was never implemented. There is nothing to simplify here.
    > **Replaced with:** Verify (don't modify) that these handlers remain generic after the toggle is removed. Buttons now have static labels, so the generic save/restore is already correct.

### E. Backend (TypeScript)

16. **Keep** `copyClaudeArtifactPrompt` / `sendClaudeArtifactPrompt` / `copyClaudeImportPrompt` ([designService.ts:58,62,170](../../../src/services/designService.ts#L58); [DesignPanelProvider.ts:69,70,97,1784](../../../src/services/DesignPanelProvider.ts#L69)) — same contract, triggered from different tabs now. **Confirmed: there is no `kind === 'download'` branch anywhere in `DesignPanelProvider.ts` / `designService.ts`** (grep returned zero hits) — `kind` is passed through as metadata only, so cutting the download direction requires **no backend change**. Confirm no handler depends on the CLAUDE tab being the active tab (the handlers at [DesignPanelProvider.ts:1784–1812](../../../src/services/DesignPanelProvider.ts#L1784) are tab-agnostic — they act on `message.prompt`).

### F. Build artifacts (VSIX release only — not a dev/verification step)

17. `dist/webview/` is regenerated by `npm run compile` **only when producing a VSIX for release**. Per project rules, `src/` is the source of truth and `dist/` is not used during development or testing; do not hand-edit `dist/` and do not treat its staleness as a defect during review.

    > **Superseded:** "Rebuild `dist/webview/{design,planning}.{html,js}` via `npm run compile` (dist is generated; do not hand-edit)" as a required implementation/verification step, plus the "dist drift — the installed extension loads dist/; skipping npm run compile makes the change appear to do nothing" edge case.
    > **Reason:** CLAUDE.md states `dist/` is NOT used during development or testing (all testing is via an installed VSIX), that `src/` is the source of truth, and that `npm run compile` is only needed when producing a VSIX for release — and explicitly says not to flag `dist/` staleness during reviews/verification. This session also carries an explicit **SKIP COMPILATION** directive. Treating a `dist` rebuild as a per-change gate contradicts both.
    > **Replaced with:** Compilation/`dist` rebuild is deferred to VSIX packaging and is out of scope for this session's verification. Implement against `src/` only.

## Edge-Case & Dependency Audit

### Race Conditions
- **Stale-label restore (already gone).** The direction-aware-labels plan introduced a restore race on the confirmation handlers; it was never implemented and the toggle is being removed, so no race exists. No mitigation needed beyond *not* re-introducing direction-aware label logic (Step 15).

### Security
- **DesignSync returns org-member content.** The rewritten import prompt drives `DesignSync.get_file`, which can return files written by other org members. The DesignSync tool itself already warns to treat fetched content as data, not instructions. The import prompt should not instruct the agent to execute anything found inside a fetched design file — keep the prompt scoped to "read the named screen and re-implement it with repo components/styles."
- **No credential claims in prompts.** The deleted `ARTIFACT_DOWNLOAD_PROMPT` falsely told the agent "WebFetch passes your active claude.ai session credentials." Deleting it removes a misleading security-relevant claim; ensure the rewritten import prompt makes no equivalent false claim (it relies on DesignSync's real auth, not WebFetch).

### Side Effects
- **Stitch source regression (top risk).** The two-button → dropdown conversion must preserve every side effect currently in `btnStitch` / `btnLocal` (refresh list, inspect-button disable/enable, `design-system-project-select` behaviour, and any `local` re-evaluation). Verify Stitch design systems still list and render after the switch.
- **`state.designSystemSubTab` now has 3 values.** Any code reading it must handle `'claude'`; default on load stays `'local'`.
- **Shared `activeDoc*` collision.** HTML PREVIEWS shares `state.activeDoc*` with images/design-folder tabs, disambiguated by `state.activeSource`. The upload button MUST confirm `activeSource` corresponds to an HTML-folder selection before building the prompt; **the coder must confirm the exact `sourceId` string** the HTML previewer sets (via `createHtmlDocCard`'s `sourceId` at [design.js:944](../../../src/webview/design.js#L944)) so the guard matches. Guard cleanly when no HTML doc is selected.
- **Persisted active tab = `'claude'`.** Restore logic around [design.js:3013](../../../src/webview/design.js#L3013) (`validTabs`) must fall back to `'html-preview'`, not resolve the removed top-level tab. Removing `'claude'` from `validTabs` makes a stale persisted value fail the `includes` check — confirm the fallback default is `'html-preview'` (or the panel's existing default), not blank.
- **Dead CSS/ids.** Grep and remove `#claude-content`, `#controls-strip-claude`, `-claude` selectors ([design.html:174,189,1921,2245](../../../src/webview/design.html#L174)); `claude-preview-frame` / `image-preview-container-claude` zoom ids; and the removed `.sub-tab-switcher` button ids.

### Dependencies & Conflicts
- **Import write target.** Old import used `claudeTargetFolder`. After removing the Claude folder picker, the Claude source panel must supply a target (workspace-root fallback or a picker). No undefined-folder import.
- **Backend `kind` contract.** `buildArtifactPrompt` must keep sending `kind: 'upload'` so `sendArtifactPromptToTerminal` / `copyArtifactPrompt` confirmations still route back. (Backend does not branch on `kind`, but the confirmation round-trip expects the field.)
- **Supersede relationship.** This plan supersedes `feature_plan_20260709132137_artifact-send-button-direction-aware-labels.md`. If that plan card is still open on the board, it should be closed/archived — implementing both is contradictory (one adds direction labels, this one removes the toggle they label).

## Dependencies
- None (no `sess_` prerequisites). This plan **supersedes** `feature_plan_20260709132137_...` rather than depending on it.

## Adversarial Synthesis

**Risk Summary:** The single load-bearing change is the **import prompt rewrite to name DesignSync** — relocating the button without it just moves a 403 to a nicer address (the plan's stated goal "fixed import" would be unmet while the tab looks cleaner). The highest *execution* risk is the **two-button → dropdown conversion silently dropping a Stitch side effect** (refresh/inspect-button state) and the **upload-button guard matching the wrong `activeSource` string**, either of which regresses a working feature. Mitigations: port every `btnStitch`/`btnLocal` side effect into the new `change` handler branch-for-branch, and confirm the HTML previewer's concrete `sourceId` before writing the upload guard. All deletions are net-negative surface (no migration risk — none of this state shipped a persisted user artifact beyond the `'claude'` active-tab value, which is handled by the `validTabs` fallback).

## Verification Plan

> Per session directives, **compilation and automated tests are skipped**. Verification is manual, against `src/`.

1. **CLAUDE tab gone:** Design panel shows only STITCH, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM; no console errors; all remaining tabs switch cleanly; a session that had `'claude'` persisted as the active tab falls back to HTML PREVIEWS.
2. **HTML PREVIEWS upload:** button reads `⇨ Upload to Claude Artifacts`; no direction toggle. Select an HTML file → the prompt is built from the **HTML tab's** selected file (`state.activeDocName` / `activeDocSourceFolder`). No HTML file selected (or a non-HTML source active) → clear guard message, no prompt.
3. **DESIGN SYSTEM source dropdown:** the source selector is a dropdown with Local Docs / Stitch Design Systems / Claude Design Systems. Switching to each shows exactly the matching panel. **Stitch still lists/refreshes and renders, and the inspect button enables/disables as before** (no regression). Local Docs unaffected.
4. **Claude import:** selecting "Claude Design Systems" shows the prompt-driven import UI; "Copy/Import" produces a prompt that names **DesignSync** (`list_projects`/`get_file`, not WebFetch) and drives auth through the tool (no false "WebFetch passes credentials" claim); import targets a defined folder. No "Sync to Claude Design…" button or modal remains anywhere.
5. **Planning panel upload-only:** no direction toggle; button reads `⇨ Upload to Claude Artifacts`, copy reads `Copy upload prompt`, placeholder = `Artifact URL (optional, redeploy to existing)...`. Upload works; confirmation flashes "Copied!" / "Sent ✓" and restores the static label.
6. **No download anywhere:** no `ARTIFACT_DOWNLOAD_PROMPT`, no "Pull from Claude", no share-link warning path reachable from the UI.
7. **No dead references:** grep `src/` for `claude-content`, `controls-strip-claude`, `activeClaudeDoc`, `claudeTargetFolder`, `claude-preview-frame`, `image-preview-container-claude`, `claude-workspace-filter`, `btn-design-subtab-local`, `btn-design-subtab-stitch`, `artifactDirectionIsDownload`, `ARTIFACT_DOWNLOAD_PROMPT`, `isShareLink`, `btn-artifact-direction`, `btn-claude-design-sync-help` → zero hits.

### Automated Tests
- None. Session directive **SKIP TESTS** is in force, and this is a webview UI refactor (HTML/JS DOM wiring) with no unit-testable pure logic added — verification is the manual checklist above. If a regression-guard is later wanted, the highest-value target is a small DOM test asserting the DESIGN SYSTEM dropdown shows exactly one panel per value and preserves the Stitch refresh side effect.

## Deferred (Not This Plan)
- **Live Claude project dropdown.** Auto-populating the Claude source panel with the user's projects would require the extension to invoke `DesignSync.list_projects` (an agent-only tool today). Revisit if the extension gains a way to call the agent.
- **Automated sync-back (local → claude.ai/design).** DesignSync has write methods (`finalize_plan` → `write_files` / `delete_files`) that could push local components *up* into a Claude Design project — a real bidirectional sync via the `/design-sync` skill. This plan intentionally does **not** build it; it only deletes the old static help modal. Revisit as its own feature if/when Claude Design becomes a heavier part of the workflow.

## Open Decisions (defaults chosen; flag if wrong)
- **Import target folder:** default to the DESIGN SYSTEM tab's workspace-root fallback; add a picker only if per-import control is wanted.
- **Backend handler names:** leave `copyClaude*` / `sendClaude*` as-is to keep the diff contained; rename only if clarity is worth the churn.
- **Shared upload prompt constant:** the relocated `CLAUDE_ARTIFACT_UPLOAD_PROMPT` is identical to planning's `ARTIFACT_UPLOAD_PROMPT`; default is to leave both copies (they live in separate webviews with no shared module) rather than introduce a shared import.

## Confirmed Facts (research resolved — no open uncertainties)
Both prior uncertainties were confirmed by live research; no further research is needed:
- **Host-aware auth is real and asymmetric.** `/design-login` = interactive terminal; `/design-consent` = claude.ai web (grants scope; verified: "Design agent access granted for your Claude Design projects"); `/design revoke` undoes it. DesignSync also surfaces an in-session consent prompt on first call. Wart: DesignSync's unauthorized-error text says "`/design-login` requires an interactive terminal" even on web — the correct web command is `/design-consent`, so the import prompt must name it explicitly.
- **WebFetch is anonymous except one URL shape.** WebFetch fetches server-side without the interactive browser session. `claude.ai/design/...` and `claude.ai/share/...` → 403 (verified live, incl. after consent). Only `claude.ai/code/artifact/{uuid}` is fetchable "via your claude.ai login" (account-level association) — which is why the old `ARTIFACT_DOWNLOAD_PROMPT` claim "WebFetch passes your active claude.ai session credentials" is **false as a general statement** (true only for code-artifact URLs), and why import **must** use DesignSync, not WebFetch.

---

**Recommendation:** Complexity 5/10 → **Send to Coder.**

---

## Completion Summary

Implemented the full plan: deleted the CLAUDE tab (button, `#claude-content`, `#claude-design-sync-modal`, all dead CSS), relocated artifact upload to HTML PREVIEWS (upload-only, guarded by `state.activeSource === 'html-folder'`), relocated claude.ai/design import to a new "Claude Design Systems" source in the DESIGN SYSTEM tab with a rewritten DesignSync-based prompt (host-aware auth, no WebFetch), converted the two-button source switcher to a dropdown, and cut the artifact download direction from both panels. Files changed: `src/webview/design.html`, `src/webview/design.js`, `src/webview/planning.html`, `src/webview/planning.js`, `src/services/DesignPanelProvider.ts` (added `sendClaudeImportPrompt` handler), `src/services/designService.ts` (added `sendClaudeImportPrompt` proxy), `src/services/TaskViewerProvider.ts` (added `claude_import` startup-command fallback). One bug found during Red Team: the HTML-folder branch of `loadDocumentPreview` did not set `state.activeDocSourceFolder` — fixed so the relocated upload button gets the correct folder. No issues remain; grep for all dead references returns zero hits across `src/`.

## Review Findings

Reviewed in-place (advanced regression analysis; SKIP COMPILATION/TESTS in force). **No CRITICAL/MAJOR findings; no code fixes required.** Verified: dropdown migrated all Stitch side effects (`refreshStitchDesignSystems` + inspect-button disable) branch-for-branch (`design.js:4014-4037`); upload guard matches the real card `sourceId` `'html-folder'`; import prompt names DesignSync with host-aware `/design-login`|`/design-consent` auth and no false WebFetch-credential claim (`design.js:4425`); backend artifact handlers error-guard on `message.error` (`DesignPanelProvider.ts:1807/1816`); all 11 new HTML ids match JS handlers; 15 dead-ref grep patterns → zero hits; `node --check` clean on both edited `.js` files; DESIGN SYSTEM panels default correctly (local visible, others hidden). Three NITs, all sanctioned by the plan's Open Decisions/fallback clause and left as-is: stale persisted `'claude'` tab falls back to the panel's DOM default STITCH (not `html-preview`, but the plan permits "the panel's existing default"); upload prompt is byte-duplicated across the two webviews (Open Decision: leave both); send handler mixes `htmlWorkspaceRootFilter` root with `activeDocSourceFolder` (backend resolves, harmless). Remaining risks: none material.
