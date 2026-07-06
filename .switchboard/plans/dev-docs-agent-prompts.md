# Dev Docs — Agent-Assist Prompts

**Plan ID:** 8b1e4d90-6c2a-47f3-a5e1-2d9f0c7b3a11

## Goal

Define the "Draft/Improve with agent" prompts for the Dev Docs tab (fix 4 of the Dev Docs in-place fixes) and how they are wired in. This is the authoring hand-off: a per-doc button copies a ready-to-paste prompt to the clipboard so an agent can write or improve the doc and write it back to disk.

### Problem & background

The Dev Docs tab has no way to ask an agent for help writing a doc. Switchboard already has ~15 "copy prompt → paste into agent" hand-offs (e.g. refine-ticket at `PlanningPanelProvider.ts:6032-6035`, refine-feature at `:6087-6090`, diagram at `:5904-5905`), all following the same shape: *"You are …"* → `##` context sections → write-to-path instruction → *"report back"*. The hand-off idiom is `await vscode.env.clipboard.writeText(prompt)` + `showTemporaryNotification('… prompt copied to clipboard')` (refine at `:6034-6035`). These prompts adopt that house style so the behaviour is consistent with the rest of the extension.

### Root cause

Dev Docs shipped without any agent hand-off, despite the rest of the extension standardizing on copy-prompt-to-clipboard. The gap is a missing instance of an existing pattern, not a new capability — so the fix is to add one more hand-off that reuses the exact refine-flow shape.

## Metadata

**Complexity:** 2
**Tags:** frontend, ux, agent-assist

## User Review Required

Yes — minimal. The prompt copy is product wording that an agent will act on verbatim, so a human should eyeball the two prompt templates (Draft and Improve) before they ship, to confirm the write-to-path instruction and the "preserve YAML frontmatter" directive match the project's agent conventions. No architectural or behavior change needs sign-off beyond the wording.

## Complexity Audit

### Routine
- Two static prompt templates (Draft / Improve) — product copy, no logic.
- One new strip button in the Dev Docs controls strip (`planning.html:3818`).
- One new webview message handler + one new backend case that calls `clipboard.writeText` + `showTemporaryNotification` — a direct copy of the refine flow (`:6034-6035`).
- Label toggle ("Draft with agent" vs "Improve with agent") driven by whether the selected doc has content — a simple length check.
- 200 KB guard on the Improve prompt's inlined content — reuses the same threshold already present at `PlanningPanelProvider.ts:8385`.

### Complex / Risky
- None for this plan in isolation. The only coordination is reading the `<Type>` token from the fix-3 source dropdown owned by the companion plan `dev-docs-tab-in-place-fixes.md` — a string read, not a coupling risk.

## The prompts

Two variants, chosen by whether the selected doc already has content.

### Draft — new / empty doc

```
You are writing a developer document for the project at <workspaceRoot>.

## Document
- **Title:** <title>
- **Type:** <Docs | README>
- **File path (write the finished doc here):** <docPath>

The file is currently empty (or contains only a title heading). Research the
codebase as needed to write an accurate, useful developer doc for this topic.
Write the finished markdown directly to the file path above. Report back with a
short summary of what you covered.
```

### Improve — existing doc

```
You are improving an existing developer document for the project at <workspaceRoot>.

## Document
- **Title:** <title>
- **Type:** <Docs | README>
- **File path (write the improved doc back here):** <docPath>

## Current content
<current markdown>

Read the current content above and the relevant parts of the codebase. Fill
gaps, correct anything out of date, and improve clarity and structure without
discarding accurate existing material. Write the improved markdown back to the
file path, preserving any YAML frontmatter. Report back with a summary of what
you changed.
```

## Wiring

- Add a per-doc strip button (e.g. "Draft with agent" / "Improve with agent", label toggled by whether the doc has content) to the Dev Docs controls strip (`planning.html:3818`). (The button element is also referenced in the companion plan's `planning.html` Proposed Changes; the two plans agree on `id="btn-agent-devdoc"`.)
- On click, the webview posts a message with the selected doc's path, title, source type, and (for Improve) a content-length flag; the backend builds the appropriate prompt and calls `vscode.env.clipboard.writeText(prompt)` + `showTemporaryNotification(...)`, mirroring the refine flow (`PlanningPanelProvider.ts:6034-6035`).
- The `<Type>` token is the source type from the fix-3 dropdown (Docs / README) owned by the companion plan.
- All source types are writable, so the button applies to every type — no read-only exclusion. (Wiki was a candidate source type but has been cut from current scope; if re-added later, the button applies to it unchanged — wiki clones are writable via commit/push.)

## Edge-Case & Dependency Audit

**Race Conditions**
- Clicking the button while content is still loading (between `selectDevDoc` at `planning.js:10746` and the `devDocContent` reply at `:3901`) — the backend should treat a missing/empty current-content as Draft, not Improve, so a half-loaded state defaults to the safe variant.

**Security**
- The prompt embeds `<docPath>` and `<current markdown>` from webview input. The path must be the already-guarded `_devDocSelected.path` (validated by `_resolveDevDocPath` in the companion plan) — do not trust a raw webview path string for the write-back instruction. No new traversal surface is introduced because the path is the same one the read/save flows already validate.

**Side Effects**
- Copying to the clipboard overwrites whatever the user had there. Matches every other Switchboard hand-off (refine, diagram, architect) — accepted, with the `showTemporaryNotification` confirming the overwrite.

**Dependencies & Conflicts**
- **Depends on the companion plan `dev-docs-tab-in-place-fixes.md`** for: the fix-3 source dropdown (provides the `<Type>` token), the `_devDocSelected` path that has already passed `_resolveDevDocPath`, and the `btn-agent-devdoc` element in the controls strip. This plan must land after the companion plan's fixes 2 and 3.
- No cross-feature dependencies.

## Edge cases

- **Large docs:** the Improve prompt inlines current content; apply the same 200 KB guard already used by clipboard import (`PlanningPanelProvider.ts:8385`) so the clipboard payload stays sane. If the doc exceeds 200 KB, copy a truncated Improve prompt that references the path and instructs the agent to read the file directly rather than inlining it.
- **No doc selected:** the button is disabled until a doc is selected (same gating as Edit/Delete at `planning.js:3908-3909`).
- **YAML frontmatter:** the Improve prompt explicitly tells the agent to preserve frontmatter, matching the refine-ticket instruction.
- **Empty/whitespace-only content:** treat as Draft (label "Draft with agent"), even if the file technically exists — avoids an Improve prompt with an empty `## Current content` block.

## Dependencies

- `dev-docs-tab-in-place-fixes.md` (Plan ID `3f2a9c7e-1b4d-4e6a-9c2f-8d5b6a1e0f42`) — owns the fix-3 source dropdown (`<Type>` token), the `_devDocSelected` path + `_resolveDevDocPath` guard, and the `btn-agent-devdoc` element. This plan lands after the companion's fixes 2 and 3.
- No cross-feature dependencies. Single internal ordering constraint: companion's fix 3 → this plan.

## Adversarial Synthesis

Key risks: (1) trusting a raw webview path in the write-back instruction instead of the already-guarded `_devDocSelected.path` — mitigation: use only the validated path; (2) Improve fired on a half-loaded doc producing an empty-content prompt — mitigation: default to Draft when content is missing/empty. Both are cheap guards on an otherwise routine copy-prompt hand-off; no architectural risk.

## Proposed Changes

### `src/webview/planning.html`
- **Context:** Dev Docs controls strip at `:3818-3827`; Edit/Delete buttons gated on selection at `:3823`/`:3826`.
- **Logic:** Add `<button id="btn-agent-devdoc" class="strip-btn" disabled>Draft with agent</button>` to the strip, after the Import button. (Agrees with the companion plan's `planning.html` change.)
- **Edge Cases:** `disabled` until a doc is selected (parity with `btn-edit-devdocs` at `:3823`).

### `src/webview/planning.js`
- **Context:** devdocs DOM refs at `:10685-10694`; `selectDevDoc` at `:10746`; `devDocContent` handler sets `state.editOriginalContent.devdocs` at `:3907`; selection gating toggles buttons at `:3908-3909`.
- **Logic:**
  1. Add `const btnAgentDevdoc = document.getElementById('btn-agent-devdoc');` to the refs block (`:10689` area).
  2. In the `devDocContent` handler (`:3901`), after enabling Edit/Delete, enable `btnAgentDevdoc` and set its label: `btnAgentDevdoc.textContent = (msg.content && msg.content.trim()) ? 'Improve with agent' : 'Draft with agent';`.
  3. Add click handler: `vscode.postMessage({ type: 'draftImproveDevDoc', path: _devDocSelected.path, workspaceRoot: _devDocSelected.workspaceRoot, title: _devDocSelected.title, sourceType: _devDocsSourceFilter, hasContent: !!(state.editOriginalContent.devdocs && state.editOriginalContent.devdocs.trim()) });`.
  4. Disable `btnAgentDevdoc` when no doc is selected (mirror the deselect block at `:3932-3935`).
- **Edge Cases:** Content not yet loaded → `hasContent=false` → Draft (safe default). Source type unset → default `Docs`.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Refine flow template at `:6032-6035` (`clipboard.writeText` + `showTemporaryNotification('Refine prompt copied to clipboard')`); 200 KB threshold at `:8385`.
- **Logic:** Add a new message case `draftImproveDevDoc`:
  1. Resolve the doc path via `_resolveDevDocPath(allRoots, msg.path)` — reject if null (do not build a prompt for an untrusted path).
  2. Read current content from disk (or use a content blob if the webview sent it; prefer reading server-side to avoid trusting webview-supplied content for the write-back target).
  3. If `hasContent` and content length ≤ 200 KB → build the Improve template, inlining content. If > 200 KB → build a truncated Improve variant that says "read the file at <docPath>" instead of inlining.
  4. If `!hasContent` → build the Draft template.
  5. Substitute `<workspaceRoot>`, `<title>`, `<Type>` (from `msg.sourceType`, default `Docs`), `<docPath>`, `<current markdown>`.
  6. `await vscode.env.clipboard.writeText(prompt); showTemporaryNotification('Dev doc prompt copied to clipboard');` — mirror `:6034-6035`.
- **Edge Cases:** Untrusted path → no-op + error toast (never embed an unguarded path in the write-back instruction). Missing file on disk at prompt-build time → fall back to Draft. README type → the path is the root README; the same prompt works (the agent writes back to `<root>/README.md`).

## Verification Plan

### Automated Tests
**Out of scope for this session** per session directives (SKIP TESTS, SKIP COMPILATION). No automated test run or `npm run compile` is executed here. A follow-up may add a unit test for the prompt builder (Draft vs Improve vs >200 KB truncated variant), but it is not run in this pass.

### Manual Verification (no compile, no test run)
1. **Draft:** Select an empty `docs/<slug>.md` → button reads "Draft with agent" → click → clipboard contains the Draft template with the correct `<docPath>`, `<title>`, `<Type>=Docs`; notification "Dev doc prompt copied to clipboard" appears.
2. **Improve:** Select a doc with content → button reads "Improve with agent" → click → clipboard contains the Improve template with inlined current content and the "preserve YAML frontmatter" line.
3. **README type:** With source = README, select the root README → Improve prompt's `<Type>=README` and `<docPath>` is the root README path.
4. **200 KB guard:** Select a >200 KB doc → Improve prompt does NOT inline content; instead instructs the agent to read the file at the path. Clipboard payload stays small.
5. **No selection:** With no doc selected → button disabled (no click, no prompt).
6. **Untrusted path:** From webview devtools, post `draftImproveDevDoc` with `path: '../../etc/passwd'` → no prompt built; error toast; nothing written to clipboard.
7. **Half-loaded state:** Click immediately after selecting (before `devDocContent` replies) → `hasContent=false` → Draft (no empty Improve prompt).
8. **Frontmatter preserved:** The Improve template text includes the "preserving any YAML frontmatter" directive verbatim.

## Review Findings

Reviewed the `draftImproveDevDoc` case (`PlanningPanelProvider.ts`) and the `btn-agent-devdoc` wiring (`planning.html`/`planning.js`) in commit `8a14023` against this plan — fully compliant, no fixes required. Confirmed: server-side path re-validation via `_resolveDevDocPath` (untrusted paths rejected with a toast, no prompt built), server-side content re-read with Draft-on-empty/half-load default, the 200 KB truncated-Improve variant that points the agent at the file instead of inlining, the verbatim "preserve YAML frontmatter" directive, the `<Type>` token mapped from the source dropdown, and the label toggle Draft/Improve. No code changed in this subtask. Validated by static trace (compile/tests skipped per session directives); no remaining risks specific to this subtask.

## Uncertain Assumptions

None. This plan reuses only verified internal patterns (the refine copy-prompt idiom at `PlanningPanelProvider.ts:6034-6035`, the 200 KB threshold at `:8385`) and standard VS Code clipboard/notification APIs. The prompt templates are product copy, not factual or library claims. No web research is needed for this subtask.
