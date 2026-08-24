# Memo Is the One Surface That Exists Only in the Cramped Column — Give It an Editor Tab

## Goal

Add a VS Code editor-tab webview panel for Memo, rendering the existing `memo.html` / `memo.js` pair, and repoint `switchboard.openMemo` at it. The sidebar keeps a Memo section, but as a launcher and a quick-capture box rather than the only place a memo can be written.

### Problem Analysis

Every other Switchboard surface has a full-width home. Memo does not: `switchboard.openMemo` calls `taskViewerProvider.openMemoTab()` (`TaskViewerProvider.ts:6602`), which persists a sub-tab key, focuses the sidebar view, and posts `openMemoTab` twice (immediately and again after 300ms as a cold-open safety net). The destination is a `240px` textarea inside a ~300px column (`implementation.html:1601-1604`), sharing that column with a launcher, terminal controls, plan selection and an activity feed.

Memo is where a user dumps a session's worth of bugs and thoughts, one per paragraph, before `process memo` turns each into a plan file. It is the most text-heavy thing in the product and it has the least room of anything in it.

**The three-post cold-open dance is a symptom.** A panel does not need to persist a tab key, focus a container view, and re-assert itself on a timer — it opens. The retry exists because the destination is a tab inside a view that may not be mounted yet.

### Why this is small

`memo.js` is **webview-native**: one `acquireVsCodeApi()` call and **zero** `fetch()` calls. It is the opposite of `terminals.js` (51 relative fetches, no `acquireVsCodeApi`), which is what makes the terminals panel browser-only. And the five messages it posts — `memoLoad`, `memoSave`, `memoClear`, `memoListWorkspaces`, `memoGeneratePrompt` — already have arms in `TaskViewerProvider._handleMessage` (`:15253`, `:15274`, `:15289`, `:15303`, `:15313`).

So the work is a provider in the shape of `SetupPanelProvider` plus message routing to handlers that exist. No new verbs, no new state, no change to `memo.js`.

### What must be preserved

`CLAUDE.md` records the sidebar Memo path as deliberate: *"The Memo sub-tab in the sidebar remains as an alternative processing path (backend-driven, immune to host system prompt overrides)."* That property comes from the processing being backend-driven, not from the textarea's location — an editor-tab panel posting the same `memoGeneratePrompt` arm keeps it. But the sidebar entry must not be deleted on the assumption the panel replaces it: it is the fallback for a host whose system prompt has overridden the `/switchboard-memo` capture protocol.

## Metadata

**Complexity:** 3
**Tags:** ui, ux, frontend, feature

## User Review Required

- **What the sidebar Memo section keeps.** Proposed: a small always-visible capture box (a few lines, autosaving to the same `.switchboard/memo.md`) plus an "Open Memo" button — so a one-line thought never costs a tab, and a long dump gets room. The alternative is button-only. This is the one real product decision here.

## Complexity Audit

### Routine

- `MemoPanelProvider` following `SetupPanelProvider`: one `createWebviewPanel`, `localResourceRoots`, `asWebviewUri` substitution for the `{{MEMO_JS_URI}}` / font placeholders `getMemoHtml` already parameterises (`headlessPanelHtml.ts:377-379`), a nonce'd CSP, and singleton reveal-if-open.
- Repointing `switchboard.openMemo` (`extension.ts:1346`) at the provider.
- Routing the five posted messages to the existing arms.

### Complex / Risky

- **The two memo UIs must not diverge.** The sidebar block (`implementation.html:1586-1607`) and `memo.html` are separate implementations of the same feature over the same file. This is the divergence pattern that produced the browser/VS Code split in the first place. Either the sidebar box is deliberately reduced to *capture only* (proposed), or the two must be unified — but not left as two full editors over one file.
- **`memo.md` is a single file with two live writers.** With a panel and a sidebar box both open, two autosaves race. `memoSave` is the single write path, so the fix belongs there — last-write-wins on a whole-file save silently discards the other surface's text. Decide the semantics (append-only reconcile, or a dirty-check that refuses a stale overwrite) before shipping two writers.
- **Do not delete the sidebar path.** See above: it is documented as the override-immune route.
- **`ACTIVE_SUB_TAB_STATE_KEY` may hold `'memo'` on ~4,000 installs.** If the sidebar's memo sub-tab is removed or reshaped, a stored `'memo'` value must resolve to something that exists rather than leaving the sidebar on a dead tab. Per the project's migration rule, treat the stored value as shipped state and map it, do not assume it is absent.

## Edge-Case & Dependency Audit

**Race Conditions**
- Panel open + sidebar box open + an agent appending via `/switchboard-memo` capture mode: three writers. The capture-mode path appends server-side, so it is the one that must never lose content — a whole-file overwrite from a stale editor is the failure to design against.

**Security**
- No new route. `memo.md` stays inside `.switchboard/`; the workspace selector reuses `memoListWorkspaces`.

**Side Effects**
- `switchboard.openMemo` changes destination. It is bound to a status-bar item (`extension.ts:2502`), so that item's behaviour changes for every user — worth a line in release notes, not a migration.

**Dependencies & Conflicts**
- Independent of the other sidebar plans; it can land before or after them. If it lands first, the IA plan inherits a Memo section that is already a launcher.
- Touches `src/services/` (new provider), `src/extension.ts`, and `src/webview/implementation.html`. No change to `memo.js` or `memo.html`.

## Verification Plan

### Automated
- Assert the new provider's CSP carries a nonce and no `unsafe-inline` for `script-src`, matching the other providers.
- Assert every `type:` string posted by `memo.js` has a matching `case` arm reachable from the new panel's message handler — the same subset check that would have caught a missing arm before the panel shipped.
- Regression: `switchboard.openMemo` resolves to the panel command, and no code path still calls `openMemoTab()` unless the sidebar section retains a tab.

### Manual
1. `switchboard.openMemo` and the status-bar memo item both open an editor tab; the tab reveals rather than duplicating on a second invocation.
2. Text typed in the panel appears in `.switchboard/memo.md`; `process memo` in an agent chat consumes it and clears the file.
3. With the panel open and the sidebar box open, type in both: the agreed write semantics hold and no content is silently lost.
4. Workspace selector lists the same roots as the sidebar version.
