# Retire the bundled user manual/guide; redirect docs affordances to the online site

## Goal

Delete the outdated bundled docs (`docs/switchboard_user_manual.md`, `docs/how_to_use_switchboard.md`) and repoint every "open docs" / "tutorial" affordance in the extension to the online documentation site, so there is a single source of truth.

### Problem Analysis

The extension ships two local markdown docs that have drifted stale now that the canonical documentation lives online at `https://tentacleopera.github.io/switchboard-site/docs/`. Several UI affordances still point at the local manual:

- **`SetupPanelProvider._openDocs()`** (`src/services/SetupPanelProvider.ts` L1540–L1557) opens `docs/switchboard_user_manual.md` in a markdown preview, falling back to `README.md`.
- **setup.html "Switchboard guide" section** (L644–L648) contains a **COPY TUTORIAL PROMPT** button (`btn-copy-tutorial-prompt`) whose handler (L3484–L3499) builds a prompt instructing the agent to read `docs/switchboard_user_manual.md` (sections 2/3/5).
- **setup.html `btn-open-docs`** (L3506) → posts an `openDocs` message handled at `SetupPanelProvider.ts` L642–L644.
- **`TaskViewerProvider`** also handles an `openDocs` case (`src/services/TaskViewerProvider.ts` L11425–L11434) — currently opens `README.md` in preview; confirm and repoint to the online site.
- **`.vscodeignore` L50–L52** explicitly keeps both bundled docs in the packaged VSIX (`!docs/how_to_use_switchboard.md`, `!docs/switchboard_user_manual.md`). These exceptions become dead config once the files are deleted.

**Root cause:** The bundled docs were the original in-extension documentation surface; the online docs site was added later as the canonical home, but the extension's affordances and packaging were never repointed. The result is two stale local files plus a third stale link in the README, all contradicting the online site.

Leaving these pointed at soon-deleted/stale files gives users wrong or missing guidance, and leaving the `.vscodeignore` exceptions dangling leaves dead packaging config.

## Dependencies

Pairs with the README-rewrite plan (`_openDocs`'s README fallback and the online site are the replacement targets; the README also removes its own L401–L402 links to the deleted files). Land together or after it.

## Metadata

**Tags:** docs, frontend, backend
**Complexity:** 3

## Non-Goals / Hard Constraints

- **DO NOT delete or modify `.agents/rules/how_to_plan.md`, and DO NOT touch the reference to it in implementation.html (L3309–3310).** That prompt tells the *planner agent* to read the internal planning framework — it is not a user tutorial and is explicitly out of scope. Only the two user-facing docs named in "Delete" below are removed. If discovery surfaces other `how_to_plan.md` references, leave every one of them untouched.
- **DO NOT touch the sibling README plan's work.** `README.md` L401–L402 links to both bundled docs; those links are removed by `rewrite-readme-match-online-docs.md`, not by this plan. This plan's DoD covers `src/` and `.vscodeignore` only; the README link cleanup is the sibling plan's responsibility.

## User Review Required

None — the scope is fixed above. (Only the two bundled user-facing docs are deleted; `how_to_plan.md` and all planning-framework references stay.)

## Complexity Audit

### Routine
- Delete two markdown files from `docs/`.
- Replace one method body (`SetupPanelProvider._openDocs`, ~17 lines) with a single `openExternal` call.
- Replace one `TaskViewerProvider` `openDocs` case body (~9 lines) with the same `openExternal` call.
- Rewrite one string literal (the copied tutorial prompt in `setup.html` L3485) to reference the online URL.
- Remove two lines from `.vscodeignore` (L51–L52) and adjust the `docs/**` exclusion (L50) accordingly.

### Complex / Risky
- Discovery completeness: missing one affordance silently breaks the "single source of truth" goal. Mitigated by Step 0 grep over both webviews and providers before editing.
- Cross-plan boundary: the README links at L401–L402 are out of scope here but must be cleaned by the sibling plan; if the sibling plan doesn't land, a dangling README link remains. Flagged in Dependencies and DoD.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — affordance handlers are single-call, no shared mutable state.
- **Security:** The replacement URL is a hardcoded `https://` literal to a GitHub Pages site we control. `TaskViewerProvider`'s existing `openExternalUrl` case already validates `https://` scheme (L11419); the new `openDocs` path should use `vscode.env.openExternal` with a hardcoded `vscode.Uri.parse(...)` literal, not a webview-supplied string, so no new attack surface is introduced.
- **Side Effects:**
  - Published extension: the two deleted docs stop shipping in the VSIX (after `.vscodeignore` cleanup). Existing installed users who somehow had the old files open in a preview tab will see the file vanish on next update — acceptable, no user data at risk.
  - Offline users: external-URL docs need a browser/network. Acceptable per the plan's existing stance; the sibling README plan carries a minimal offline orient if needed.
- **Dependencies & Conflicts:**
  - **Pairs with:** `rewrite-readme-match-online-docs.md` (README link removal + optional offline fallback).
  - **Conflicts:** None. The `how_to_plan.md` reference in `implementation.html` is explicitly preserved.

## Adversarial Synthesis

**Risk Summary:** Key risk is an incomplete sweep — a missed affordance silently leaves a stale pointer, defeating the "single source of truth" goal while passing a superficial "I changed the obvious spots" check. Mitigation: Step 0 grep must cover both webviews and both providers, and the DoD must include `.vscodeignore`. Second risk is the cross-plan README boundary: if the sibling README plan doesn't land, `README.md` L401–L402 dangles; mitigate by landing both together and verifying both in the same PR.

## Proposed Changes

### Step 0 — Discovery (do first, before any edit)

Grep **both webviews** (`src/webview/setup.html`, `src/webview/implementation.html`, and any other webview HTML) **and** their providers (`SetupPanelProvider.ts`, `TaskViewerProvider.ts`, and any other provider) for every reference to:
- the two deleted basenames: `switchboard_user_manual`, `how_to_use_switchboard`;
- the affordance terms: `tutorial`, `guide`, `manual`, `openDocs`, `btn-open-docs`, `btn-copy-tutorial-prompt`.

Also grep `.vscodeignore` and `package.json` for `docs/` references. List every hit before editing so none is missed. Confirm `how_to_plan.md` references are present and explicitly excluded from the edit set.

### `docs/switchboard_user_manual.md` (delete)

**Context:** Bundled user manual, drifted stale vs. online site.

**Logic:** Remove the file.

**Implementation:** `git rm docs/switchboard_user_manual.md`.

**Edge Cases:** Confirm no non-doc, non-README reference loads it at runtime (Step 0 grep covers this).

### `docs/how_to_use_switchboard.md` (delete)

**Context:** Bundled detailed guide, drifted stale vs. online site.

**Logic:** Remove the file.

**Implementation:** `git rm docs/how_to_use_switchboard.md`.

**Edge Cases:** Same as above.

### `src/services/SetupPanelProvider.ts` — `_openDocs()` (L1540–L1557)

**Context:** Currently stats `docs/switchboard_user_manual.md`, opens it in a markdown preview, and falls back to `README.md` on stat failure.

**Logic:** Replace the entire method body with a single external open to the online docs installation page.

**Implementation:**
```ts
private async _openDocs(): Promise<void> {
    const docsUrl = 'https://tentacleopera.github.io/switchboard-site/docs/getting-started/installation';
    await this._seams().ui.openExternal(vscode.Uri.parse(docsUrl));
}
```
Remove the now-dead `manualPath`/`readmePath` stat/preview logic and the "Plugin documentation not found." error branch (the URL is a literal; there is no not-found case to handle beyond `openExternal`'s own failure, which the seams layer already surfaces).

**Edge Cases:**
- If `openExternal` rejects (e.g., no browser handler registered), let the seams layer surface the error; do not add a fallback to the deleted manual.
- The `case 'openDocs'` dispatch at L642–L644 stays unchanged — it already calls `_openDocs()`.

### `src/services/TaskViewerProvider.ts` — `openDocs` case (L11425–L11434)

**Context:** Currently stats `README.md` and opens it in a markdown preview, with a "Plugin README.md not found." error branch.

**Logic:** Repoint to the same online docs URL as `SetupPanelProvider._openDocs()` so both affordances behave identically.

**Implementation:** Replace the case body with:
```ts
case 'openDocs': {
    const docsUrl = 'https://tentacleopera.github.io/switchboard-site/docs/getting-started/installation';
    this._seams().ui.openExternal(vscode.Uri.parse(docsUrl));
    break;
}
```
Remove the `readmePath`/`stat`/`markdown.showPreview` logic and the "Plugin README.md not found." error branch.

**Edge Cases:**
- The existing `openExternalUrl` case at L11418–L11423 validates `https://` for webview-supplied URLs; this hardcoded-literal path needs no such check, but use `vscode.env.openExternal` (or the seams equivalent) consistently with `SetupPanelProvider`.
- Coordinate the URL constant: ideally both providers reference a single shared constant (Clarification: introduce `SWITCHBOARD_DOCS_URL` in a shared constants module if one already exists; otherwise inline the literal in both and leave deduplication for a later refactor — do not invent a new module just for this).

### `src/webview/setup.html` — COPY TUTORIAL PROMPT handler (L3484–L3499)

**Context:** The copied prompt currently instructs the agent to read `docs/switchboard_user_manual.md` sections 2/3/5.

**Logic:** Rewrite the copied prompt string to reference the online docs instead.

**Implementation:** Replace the `prompt` string literal at L3485 with:
```
Read the Switchboard docs at https://tentacleopera.github.io/switchboard-site/docs/getting-started/ (Installation, Agents, Planning) and walk me through setup as a numbered list; ask which step I want help with first.
```
Keep the button label (`COPY TUTORIAL PROMPT`) and the clipboard/copy-feedback logic unchanged.

**Edge Cases:** None — the button's mechanics are unchanged; only the copied string changes.

### `.vscodeignore` (L50–L52)

**Context:** Currently excludes `docs/**` then re-includes the two bundled docs so they ship in the VSIX.

**Logic:** Once the two files are deleted, the re-include lines are dead config. Remove them so the `docs/**` exclusion is clean and future docs additions don't accidentally ship.

**Implementation:** Remove L51 (`!docs/how_to_use_switchboard.md`) and L52 (`!docs/switchboard_user_manual.md`). Leave L50 (`docs/**`) as the blanket exclusion. Verify no other `!docs/...` re-include lines exist for the deleted files.

**Edge Cases:** If other `docs/*.md` files are intentionally shipped (e.g., `TECHNICAL_DOC.md`), confirm whether they have their own `!docs/...` lines and leave those untouched — this edit only removes the two lines re-including the deleted files.

### Repo
switchboard (extension).

## Verification Plan

### Automated Tests
- None. No automated test covers docs-affordance redirection; the existing test suite does not exercise `_openDocs` or the tutorial-prompt string.

### Manual Verification
- `grep -rn "switchboard_user_manual\|how_to_use_switchboard" src/ .vscodeignore package.json` returns no matches.
- `grep -rn "openDocs" src/` shows both `SetupPanelProvider._openDocs` and the `TaskViewerProvider` `openDocs` case calling `openExternal` with the online docs URL.
- `grep -n "switchboard_user_manual" src/webview/setup.html` returns no matches (the tutorial prompt now references the online URL).
- `grep -n "tentacleopera.github.io/switchboard-site" src/services/SetupPanelProvider.ts src/services/TaskViewerProvider.ts src/webview/setup.html` returns matches in all three.
- Confirm `docs/switchboard_user_manual.md` and `docs/how_to_use_switchboard.md` no longer exist on disk.
- Confirm `.agents/rules/how_to_plan.md` still exists and `implementation.html` L3309–L3310 still references it unchanged.
- (Skip compilation — per session directive. Skip automated tests — per session directive.)
- Cross-plan check: confirm `README.md` L401–L402 bundled-manual links are removed by the sibling `rewrite-readme-match-online-docs.md` plan; if that plan has not landed, flag the dangling README link in chat rather than fixing it here (out of scope per Non-Goals).

## Definition of Done

Both files gone; every open-docs/tutorial affordance in `src/` opens or references the online site; `.vscodeignore` no longer re-includes the deleted files; no dangling references to the deleted files anywhere in `src/` or `.vscodeignore`; `how_to_plan.md` and its `implementation.html` reference untouched. The `README.md` L401–L402 link cleanup is owned by the sibling plan and verified there, not here.

**Recommendation:** Complexity 3 → Send to Intern.

## Review Findings

Reviewed against plan + feature goal. Plan-scoped changes (src/, .vscodeignore) verified clean: both docs deleted, `_openDocs`/`openDocs`/tutorial-prompt repointed to the online site, `.vscodeignore` re-includes removed, `how_to_plan.md` and its `implementation.html` reference untouched. **CRITICAL regression found outside the plan's stated DoD but inside the feature's "single source of truth" goal:** `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md` still told agents to read the deleted files in Guided Setup (4 steps) and Hard Rule 11 — fixed by repointing both blocks to existing online docs pages (installation, agentic-coding-apps, quick-start, board/kanban-board, project/constitution, project/features-tab, control-plane, integrations/remote-control). Files changed in review: `.agents/workflows/switchboard.md`, `.claude/skills/switchboard/SKILL.md`. Verification: `grep -rn "switchboard_user_manual\|how_to_use_switchboard" src/ .vscodeignore .agents/workflows/ .claude/skills/` → zero hits; online URL present in both agent files; `how_to_plan.md` ref in `implementation.html:3312` unchanged. **Remaining risks:** (1) a separate plan `switchboard-docs-4-content-reference.md` cites `switchboard_user_manual.md` as its content source and is now broken at execution time — out of this feature's scope; (2) NIT: `TaskViewerProvider` `openExternal` call is not awaited while `SetupPanelProvider` awaits its equivalent — matches the plan snippet, no functional impact, deferred.
