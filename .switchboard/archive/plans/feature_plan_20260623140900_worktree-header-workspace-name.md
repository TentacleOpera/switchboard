# Show the Active Workspace Name in the Worktree Tab's "Create New Worktree" Header

## Goal

Make the WORKTREES tab's "Create New Worktree" form header state which workspace a new worktree will be created in, so a user with multiple workspaces/repos open can tell what they are acting on.

**Problem analysis + Root Cause (with cited file:line):**

In the kanban board's WORKTREES tab, the "Create New Worktree" form operates against the workspace currently open in the kanban board, but nothing in the UI communicates that scoping. A user with multiple workspaces/repos open cannot tell which workspace a new worktree will be created in.

The header is a static string:

- `src/webview/kanban.html:8659` — `stateTitle.textContent = 'CREATE NEW WORKTREE';` inside `createWorktreesPanel(config)` (function starts at `src/webview/kanban.html:8609`).

**Root cause:** the header text is hard-coded and never references the active workspace. The webview already tracks the active workspace path, so the fix is purely presentational: derive a friendly workspace name and inject it into the header, then keep it in sync when the workspace changes.

**Where the active workspace name is available (client-side, no host change needed):**

- `currentWorkspaceRoot` — the active workspace's absolute path. Declared at `src/webview/kanban.html:3734`, seeded from `document.body.dataset.initialWorkspaceRoot` at `src/webview/kanban.html:3736-3737`, and reassigned by the host's `updateWorkspaceSelection` message at `src/webview/kanban.html:5973`.
- `getActiveWorkspaceRoot()` at `src/webview/kanban.html:3875-3877` returns `currentWorkspaceRoot || (workspaceItems[0] && workspaceItems[0].workspaceRoot) || ''`. **This — not raw `currentWorkspaceRoot` — is the path the create-worktree action actually targets** (see the Accuracy note below), so the header must derive from it to be truthful.
- `getWorkspaceItemRepoScope(item)` at `src/webview/kanban.html:4018-4022` already derives a friendly name (the last path segment of a `workspaceRoot`). We reuse the same "last path segment" logic to turn the active workspace root into a display name.
- `workspaceItems` (declared `src/webview/kanban.html:3741`, populated at `src/webview/kanban.html:5976`) optionally carries richer labels via `buildWorkspaceOptionLabel` (`src/webview/kanban.html:4024`), but for a concise header the bare repo-scope name (last path segment) is the right choice.

**Accuracy note — where a new worktree is actually created:**

The "Create Project Worktree" button posts `{ type: 'createWorktreeForProject', workspaceRoot: currentWorkspaceRoot, ... }` (`src/webview/kanban.html:8745-8750`). But `postKanbanMessage` (`src/webview/kanban.html:3879-3884`) substitutes `getActiveWorkspaceRoot()` whenever `message.workspaceRoot` is falsy. So when `currentWorkspaceRoot === ''` (e.g. a single-workspace session at boot, before any `updateWorkspaceSelection`), the worktree is genuinely created in `workspaceItems[0].workspaceRoot`. A header derived from raw `currentWorkspaceRoot` would therefore read the plain `CREATE NEW WORKTREE` while the button creates into a real, named repo — i.e. the label would contradict the action it sits above. **The header is derived from `getActiveWorkspaceRoot()` so it always names the workspace the form actually targets.**

**Where workspace changes are handled (must re-render to keep header in sync):**

- `updateWorkspaceSelection` message handler at `src/webview/kanban.html:5971-5987`. This currently updates `currentWorkspaceRoot`, `workspaceItems`, the project dropdown, and the filter badge, but does **not** re-render the worktrees tab — so a workspace switch while the tab is open leaves a stale header. This is the sync gap to close.
- The tab is (re)rendered on activation at `src/webview/kanban.html:3857-3860` (`renderWorktreesTab()` after `loadWorktreeConfig()`), on the `worktreeConfig` message at `src/webview/kanban.html:6062-6064`, and via `renderWorktreesTab()` at `src/webview/kanban.html:8574-8583` which rebuilds the panel by calling `createWorktreesPanel(lastWorktreeConfig)`.

## Metadata

**Tags:** frontend, ui, ux, feature
**Complexity:** 2

## User Review Required

- **None.** This is a self-contained, presentational, client-side change with no product decisions outstanding. Two minor presentation calls were decided in-plan and need no sign-off:
  - **All-caps header** (`wsName.toUpperCase()`) is retained for consistency with the surrounding all-caps labels; `word-break: break-word` prevents overflow on long names.
  - **Display-name source** is `getActiveWorkspaceRoot()` (the form's true target), not raw `currentWorkspaceRoot`.

## Complexity Audit

### Routine
- Deriving a display name from the active workspace root (last path segment) — mirrors the existing `getWorkspaceItemRepoScope` helper.
- Changing one `textContent` assignment to an interpolated string plus one inline-style addition.
- Adding a re-render call in the existing `updateWorkspaceSelection` handler, guarded so it only fires when the worktrees tab is active and the displayed name actually changed.

### Complex / Risky
- None. This is a presentational, fully client-side change. No host (`KanbanProvider.ts`) changes, no message-shape changes, no persisted state, no migrations.

## Edge-Case & Dependency Audit

**Race Conditions**
- None of substance. The only async interplay is: `updateWorkspaceSelection` may arrive while the worktrees tab is open, and a fresh `worktreeConfig` may arrive shortly after. Both paths call `renderWorktreesTab()`, which rebuilds idempotently from `lastWorktreeConfig` and re-derives the header from `getActiveWorkspaceRoot()`. A double-render (one from the sync guard, one from a follow-up `worktreeConfig`) is harmless — the panel is rebuilt wholesale each time. `renderWorktreesTab()` is wrapped in try/catch (`src/webview/kanban.html:8580-8582`), so a render mid-flight cannot throw into the message loop.

**Security**
- `textContent` (not `innerHTML`) is used for the header, so the workspace name — an OS path segment — cannot inject markup. Safe by construction. No new network calls, no new message types, no new persisted data.

**Side Effects**
- The only DOM side effect is rebuilding the worktrees panel when the displayed workspace name changes while the tab is active. Guarded on `(a)` the tab being active and `(b)` the derived display name actually changing, so no needless DOM churn on unrelated `updateWorkspaceSelection` traffic. Inactive tab does no work — it re-renders itself on next activation (`src/webview/kanban.html:3857-3860`).
- **Empty / no resolvable workspace name:** both `currentWorkspaceRoot` and `workspaceItems` can be empty (initial value, `src/webview/kanban.html:3734` / `3741`). `getActiveWorkspaceRoot()` returns `''` in that case; the derive helper must return `''` for empty/whitespace input, and the header falls back to the original static `'CREATE NEW WORKTREE'` (no trailing "IN ").
- **Long workspace names:** the header lives in a flex column (`actionSection`, `src/webview/kanban.html:8653-8655`); to prevent overflow/wrapping issues, the header element gets `word-break: break-word;` (it currently has no wrapping rule at `src/webview/kanban.html:8658`). Text wraps gracefully within the dashed-border section.
- **Path separator portability:** Windows paths use `\`; the derive helper splits on both `/` and `\` (same regex `/[\\/]/` already used at `src/webview/kanban.html:4020`).

**Dependencies & Conflicts**
- **No host dependency:** `worktreeConfig` (built in `src/services/KanbanProvider.ts`, `getWorktreeConfig` handler) does not carry a workspace name and does not need to — the webview derives the name from state it already holds. No backend change required, so no risk to the published install base and no migration concern (consistent with the project migration rule for shipped state).
- **Hoisting:** `getActiveWorkspaceDisplayName()` and `renderWorktreesTab()` are function declarations in the same `<script>` scope and are hoisted, so calling them from the `updateWorkspaceSelection` handler (which lexically precedes their definitions) is safe.
- **Active-tab detection** reuses the established pattern: `.shared-tab-btn[data-tab="worktrees"]` (button exists at `src/webview/kanban.html:2470`) carries the `active` class toggled at `src/webview/kanban.html:3822/3825`.
- **No confirmation dialogs introduced** (per project rules). This change adds no dialogs of any kind.

## Dependencies

- None. This plan is self-contained — no upstream session work (`sess_…`) is required, and it introduces no new dependency for downstream plans.

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) the header lying about the create target — mitigated by deriving the name from `getActiveWorkspaceRoot()`, the same fallback the create action uses, rather than raw `currentWorkspaceRoot`; (2) a stale header after a workspace switch — mitigated by re-rendering when the *derived display name* changes (not merely when `currentWorkspaceRoot` changes), guarded on the tab being active; and (3) a verification step that contradicts project rules — corrected to test via the installed VSIX rather than rebuilding `dist/`. There is no host change, no persisted state, and no migration surface, so the blast radius is confined to one presentational panel.

## Proposed Changes

### File: `src/webview/kanban.html`

#### 1. Add a small helper to derive a display name from the active workspace root

Place this helper near the existing `getWorkspaceItemRepoScope` (after `src/webview/kanban.html:4022`) so the two related helpers sit together. It derives from `getActiveWorkspaceRoot()` (defined at `src/webview/kanban.html:3875`) so the name matches the workspace the create-worktree action actually targets (including the `workspaceItems[0]` fallback) — see the Accuracy note in **Goal**.

Before (`src/webview/kanban.html:4018-4022`):
```js
        function getWorkspaceItemRepoScope(item) {
            const raw = String(item && item.workspaceRoot || '');
            const parts = raw.split(/[\\/]/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : '';
        }
```

After:
```js
        function getWorkspaceItemRepoScope(item) {
            const raw = String(item && item.workspaceRoot || '');
            const parts = raw.split(/[\\/]/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : '';
        }

        // Friendly name for the workspace a new worktree will actually be created in.
        // Derived from getActiveWorkspaceRoot() (NOT raw currentWorkspaceRoot) so it matches
        // the path postKanbanMessage() sends for createWorktreeForProject — including the
        // workspaceItems[0] fallback used when currentWorkspaceRoot is still ''.
        // Returns '' when no workspace is known, so callers can fall back to a plain label.
        function getActiveWorkspaceDisplayName() {
            const raw = String(getActiveWorkspaceRoot() || '').trim();
            const parts = raw.split(/[\\/]/).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : '';
        }
```

> Clarification (not a new requirement): the original draft of this plan derived the name from `currentWorkspaceRoot`. It was changed to `getActiveWorkspaceRoot()` after confirming (`src/webview/kanban.html:8745-8750` + `3879-3884`) that the create action falls back to `workspaceItems[0]` when `currentWorkspaceRoot` is empty. This keeps the label and the action in agreement; behaviour is otherwise identical whenever `currentWorkspaceRoot` is non-empty.

#### 2. Inject the workspace name into the "Create New Worktree" header

Before (`src/webview/kanban.html:8657-8660`):
```js
            const stateTitle = document.createElement('div');
            stateTitle.style.cssText = 'font-size: 11px; font-weight: bold; color: var(--text-muted);';
            stateTitle.textContent = 'CREATE NEW WORKTREE';
            actionSection.appendChild(stateTitle);
```

After:
```js
            const stateTitle = document.createElement('div');
            stateTitle.style.cssText = 'font-size: 11px; font-weight: bold; color: var(--text-muted); word-break: break-word;';
            const wsName = getActiveWorkspaceDisplayName();
            stateTitle.textContent = wsName
                ? `CREATE NEW WORKTREE IN ${wsName.toUpperCase()}`
                : 'CREATE NEW WORKTREE';
            actionSection.appendChild(stateTitle);
```

Notes:
- `wsName.toUpperCase()` keeps the header visually consistent with the existing all-caps label style (decided in **User Review Required**).
- `textContent` (not `innerHTML`) is used, so the workspace name cannot inject markup — safe by construction.

#### 3. Keep the header in sync when the active workspace changes

The worktrees panel is fully rebuilt by `renderWorktreesTab()` (`src/webview/kanban.html:8574-8583`), which re-runs `createWorktreesPanel` and therefore re-derives the header. We just need to call it when the *displayed workspace name* changes while the tab is open. We compare the derived display name (captured before the state mutation) rather than `currentWorkspaceRoot` alone, so the guard also fires when the name changes via the `workspaceItems[0]` fallback (root empty before and after, but the workspace list swapped).

Before (`src/webview/kanban.html:5971-5987`):
```js
                case 'updateWorkspaceSelection': {
                    const previousRoot = currentWorkspaceRoot;
                    currentWorkspaceRoot = msg.workspaceRoot || '';
                    activeWorkspaceFilter = msg.activeFilter || null;
                    activeProjectFilter = msg.projectFilter ?? null;
                    workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
                    currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';

                    if (msg.allWorkspaceProjects && typeof msg.allWorkspaceProjects === 'object') {
                        allWorkspaceProjects = msg.allWorkspaceProjects;
                    }

                    const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;
                    updateWorkspaceProjectDropdown(explicitChange ? currentWorkspaceRoot : null);
                    updateWorkspaceFilterBadge();
                    break;
                }
```

After:
```js
                case 'updateWorkspaceSelection': {
                    const previousRoot = currentWorkspaceRoot;
                    const previousWorkspaceName = getActiveWorkspaceDisplayName();
                    currentWorkspaceRoot = msg.workspaceRoot || '';
                    activeWorkspaceFilter = msg.activeFilter || null;
                    activeProjectFilter = msg.projectFilter ?? null;
                    workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
                    currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';

                    if (msg.allWorkspaceProjects && typeof msg.allWorkspaceProjects === 'object') {
                        allWorkspaceProjects = msg.allWorkspaceProjects;
                    }

                    const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;
                    updateWorkspaceProjectDropdown(explicitChange ? currentWorkspaceRoot : null);
                    updateWorkspaceFilterBadge();

                    // Keep the worktrees tab's "CREATE NEW WORKTREE IN <workspace>" header in sync
                    // when the displayed workspace name changes while that tab is open. Compare the
                    // derived display name (not just currentWorkspaceRoot) so the header also tracks
                    // the workspaceItems[0] fallback used by getActiveWorkspaceRoot(). When the tab
                    // is not active it re-renders itself on next activation, so no work is needed here.
                    if (getActiveWorkspaceDisplayName() !== previousWorkspaceName) {
                        const worktreesTabActive = document
                            .querySelector('.shared-tab-btn[data-tab="worktrees"]')
                            ?.classList.contains('active');
                        if (worktreesTabActive) {
                            renderWorktreesTab();
                        }
                    }
                    break;
                }
```

Notes:
- `getActiveWorkspaceDisplayName()` and `renderWorktreesTab()` (defined at `src/webview/kanban.html:8574`) are function declarations and are hoisted, so calling them from this earlier handler is safe.
- `previousWorkspaceName` is captured **before** `currentWorkspaceRoot`/`workspaceItems` are reassigned, so it reflects the pre-update derived name.
- The active-tab check mirrors how tab activation is detected elsewhere (`.shared-tab-btn[data-tab=…]` with the `active` class, e.g. `src/webview/kanban.html:3822/3825` and `5965`).
- `renderWorktreesTab()` rebuilds from `lastWorktreeConfig` (`src/webview/kanban.html:8579`); the header derives purely from the active workspace root, so it is correct even before any fresh `worktreeConfig` arrives for the new workspace. The config-dependent body refreshes when the next `worktreeConfig` message lands, and `loadWorktreeConfig` is still triggered on tab activation at `src/webview/kanban.html:3858`.

## Verification Plan

> Per project rules (CLAUDE.md) and this session's directives: `dist/` is **not** used during development/testing — all testing is via the installed VSIX, with `src/` as the source of truth. Do **not** run `npm run compile` to verify; rebuild a VSIX only when producing a release. Automated tests are run separately by the user.

1. **Header shows workspace name:** Open the kanban board on a workspace (e.g. a folder named `switchboard`), open the WORKTREES tab, and confirm the form header reads `CREATE NEW WORKTREE IN SWITCHBOARD`.
2. **Sync on workspace switch:** With the WORKTREES tab open, switch the active workspace (via the workspace/project dropdown or any path that emits `updateWorkspaceSelection`). Confirm the header updates to the new workspace name without needing to leave and re-enter the tab.
3. **Re-entry sync:** Switch workspace while on a different tab (e.g. board), then open the WORKTREES tab. Confirm the header shows the now-current workspace.
4. **Single-workspace / empty `currentWorkspaceRoot` fallback:** In a session where `currentWorkspaceRoot` is initially `''` but a single workspace is present, confirm the header names that workspace (matching the repo a "Create Project Worktree" click would target) rather than showing the bare `CREATE NEW WORKTREE`.
5. **Truly empty fallback:** With no resolvable workspace name at all (`getActiveWorkspaceRoot()` returns `''`), confirm the header falls back to plain `CREATE NEW WORKTREE` with no dangling "IN ".
6. **Long name:** On a workspace with a long folder name, confirm the header wraps within the dashed action section and does not overflow horizontally.
7. **No regressions:** Confirm the rest of the WORKTREES tab (suppress-main-terminals checkbox, repo select in control-plane mode, project dropdown, "Create Project Worktree" button, worktree list) renders and behaves as before. No confirmation dialogs were added anywhere.

### Automated Tests
- No automated tests are added or required for this change: it is a presentational, fully client-side edit to a VS Code webview (`kanban.html`) with no testable host logic, no message-shape change, and no persisted state. The webview is not under automated test harness in this repo. Verification is the manual checklist above. (The user runs the existing suite separately, per this session's directive.)

---

**Recommendation:** Complexity 2 → **Send to Intern.**

## Reviewer Pass (2026-06-23)

### Stage 1 — Adversarial Findings

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| 1 | **MAJOR** | `src/webview/kanban.html:6004-6011` (sync block) | Sync block calls `renderWorktreesTab()` on workspace switch while the tab is active, but `renderWorktreesTab()` rebuilds from `lastWorktreeConfig` — which is still the **previous** workspace's config. The header refreshes correctly (derived from `getActiveWorkspaceRoot()`), but the worktree list, repo/project dropdowns, and control-plane mode all stay stale on the old workspace. This creates a **header/body contradiction** ("CREATE NEW WORKTREE IN B" above workspace A's project list and worktree entries) — arguably worse than the pre-change behavior where the whole panel was at least consistently stale. Root cause: the sync code never calls `loadWorktreeConfig()`, and the host (`KanbanProvider.ts`) only sends `worktreeConfig` in response to an explicit `getWorktreeConfig` request (line 6616-6621) — none of the three `updateWorkspaceSelection` send sites (1245, 2107, 2264) push a `worktreeConfig` afterward. The plan's note at line 211 ("The config-dependent body refreshes when the next `worktreeConfig` message lands") is incorrect — that message never lands without an explicit fetch. |
| 2 | NIT | Plan line-number citations | Plan cites `kanban.html:8657-8660` for the header and `5971-5987` for the handler; actuals drifted to 8691-8697 and 5982-6020 due to the auto-commit chain. No code impact. |
| 3 | NIT | `src/webview/kanban.html:8692` | `word-break: break-word` is a non-standard alias for `overflow-wrap: break-word`, but universally supported. Leave as-is. |

### Stage 2 — Balanced Synthesis

- **Keep:** `getActiveWorkspaceDisplayName()` helper (correct source via `getActiveWorkspaceRoot()`, correct `workspaceItems[0]` fallback, correct empty-string return). Header injection (`textContent`, `toUpperCase`, fallback label, `word-break`). Active-tab guard. `previousWorkspaceName` capture-before-mutation timing. All correct and match the plan.
- **Fix now (Finding #1):** Add `loadWorktreeConfig()` to the sync block so the body fetches fresh config for the new workspace. The immediate `renderWorktreesTab()` gives an instant correct header; `loadWorktreeConfig()` posts `getWorktreeConfig` with the now-updated `currentWorkspaceRoot`, and the `worktreeConfig` handler (6088-6090) updates `lastWorktreeConfig` and re-renders with correct body data. Double-render is harmless (plan line 57).
- **Defer:** Findings #2 and #3 — no code impact.

### Fix Applied

**File:** `src/webview/kanban.html` (sync block in `updateWorkspaceSelection` handler)

Added `loadWorktreeConfig()` call alongside the existing `renderWorktreesTab()` in the active-tab sync branch, with an explanatory comment documenting why both calls are needed (immediate header fix + async body refresh). The `worktreeConfig` response handler re-renders the panel once fresh config arrives, so the body no longer stays stale on the previous workspace.

### Verification Results

- **Compilation:** Skipped per session directive (`SKIP COMPILATION`). `src/` is the source of truth; `dist/` is not used during development.
- **Automated tests:** Skipped per session directive (`SKIP TESTS`). The user runs the suite separately.
- **Manual verification (code-level, read-only):**
  - Confirmed all three plan changes are present and match the plan spec: helper at 4029-4033, header injection at 8691-8697, sync block at 5999-6019.
  - Confirmed `getActiveWorkspaceRoot()` (3875-3877) has the `workspaceItems[0]` fallback the plan relies on.
  - Confirmed `postKanbanMessage` (3879-3884) substitutes `getActiveWorkspaceRoot()` for falsy `workspaceRoot` — so the header's source matches the create action's true target.
  - Confirmed `createWorktreeForProject` (8774-8779) sends `workspaceRoot: currentWorkspaceRoot`, which `postKanbanMessage` backstops — accuracy claim holds.
  - Confirmed `renderWorktreesTab` (8600-8609) is a function declaration (hoisted) — safe to call from the earlier handler.
  - Confirmed the `worktreeConfig` handler (6088-6090) updates `lastWorktreeConfig` and calls `renderWorktreesTab()` — so the added `loadWorktreeConfig()` will trigger a correct body refresh.
  - Confirmed none of the three `updateWorkspaceSelection` send sites in `KanbanProvider.ts` (1245, 2107, 2264) push `worktreeConfig` — validating that the fix's `loadWorktreeConfig()` call is necessary.
  - Confirmed no `confirm()`/`window.confirm()` dialogs introduced (per CLAUDE.md rules).

### Remaining Risks

- **Brief header-correct/body-stale flash:** Between the immediate `renderWorktreesTab()` and the `worktreeConfig` response, the header is correct but the body briefly shows the previous workspace's config. This is a sub-second async round-trip and is strictly better than the pre-fix state (body stale indefinitely until tab re-entry). Acceptable.
- **Host non-response:** If the host cannot resolve the new workspace root (`KanbanProvider.ts:6619` — `if (!workspaceRoot) break;`), no `worktreeConfig` arrives and the body stays stale. The header is still correct (from the immediate `renderWorktreesTab()`). This matches the existing behavior for unresolvable roots and is an acceptable edge case.
- **Manual checklist items 1-7 above** still require runtime verification via the installed VSIX (not executable in this review session).
