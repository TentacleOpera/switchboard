# Add Context Gatherer Role to Prompts Tab

## Goal
Add the `gatherer` role to the prompts tab role selector so it can be configured like other roles (Planner, Coder, Reviewer, etc.). This resolves the architectural inconsistency where `gatherer` exists in the agents tab and kanban columns but is missing from the prompts tab.

## Metadata
- **Tags:** frontend, UI
- **Complexity:** 3

## User Review Required

> [!IMPORTANT]
> **Decision required: Should `gatherer` be added to `PROMPT_OVERRIDE_EXCLUDED_KEYS`?**
> `sharedDefaults.js` line 56 defines specialist roles that are excluded from prompt override UI: `ticket_updater`, `researcher`, `splitter`, `research_planner`. The `gatherer` role is clipboard-only (no CLI terminal dispatch), similar to these excluded roles. If `gatherer` should NOT show a full prompt customization panel, add it to `PROMPT_OVERRIDE_EXCLUDED_KEYS`. Current plan assumes it SHOULD show a basic prompt textarea (like coder/intern), making it configurable. Confirm before implementing.

## Complexity Audit

### Routine
- Add one `<option>` to the static HTML role selector dropdown in `kanban.html`
- Add one entry to `DEFAULT_ROLE_CONFIG` object in `sharedDefaults.js`
- Add one entry to `ROLE_ADDONS` object in `sharedDefaults.js`
- `ROLE_KEYS` is derived from `Object.keys(DEFAULT_ROLE_CONFIG)` — no separate change needed

### Complex / Risky
- `sharedDefaults.js` is a shared module used by both `kanban.html` and potentially `setup.html`; changes ripple to all consumers

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is a pure UI config addition.

### Security
- None. The `gatherer` role is clipboard-only; no new terminal dispatch path is opened.

### Side Effects
- `ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG)` is derived dynamically, so adding `gatherer` to `DEFAULT_ROLE_CONFIG` automatically includes it in `ROLE_KEYS` without a separate change. The plan's original step 3 (add to `ROLE_KEYS`) is therefore **redundant** and should be skipped.
- The `KanbanProvider.ts` `getPromptPreview` handler (lines 5844–5950) already handles unknown roles generically via `buildKanbanBatchPrompt(role, plans, {...})` — no switch-case is needed for `gatherer`. The original step 4 in the plan is a **no-op** and should be skipped.

### Dependencies & Conflicts
- `sharedDefaults.js` is inlined via `<!-- SHARED_DEFAULTS_SCRIPT -->` injection in `kanban.html` at build time. Changes to `sharedDefaults.js` are immediately consumed by `kanban.html`.
- `BUILT_IN_AGENT_LABELS` in `sharedDefaults.js` (line 47) already includes `{ key: 'gatherer', label: 'Context Gatherer' }` — no change needed there.

## Dependencies
- None identified.

## Adversarial Synthesis
Key risks: (1) `DEFAULT_ROLE_CONFIG` lives in `sharedDefaults.js`, not inline in `kanban.html` — the original plan targeted the wrong file, which would have been a no-op; (2) the `ROLE_ADDONS` entry was missing, leaving the add-ons panel empty for `gatherer`. Mitigations: correct both file targets, add `ROLE_ADDONS` entry, and drop the two redundant steps (ROLE_KEYS and KanbanProvider.ts).

## Proposed Changes

### `src/webview/kanban.html` — Add gatherer option to Role Selector
**File:** [`src/webview/kanban.html`](src/webview/kanban.html)

**Context:** The `<select id="roleSelect">` (line 2137) lists all configurable roles as static `<option>` elements. A dynamic `<optgroup id="customAgentsGroup">` follows at line 2149 for custom agents. Insert `gatherer` before that optgroup.

**Logic:** One new static `<option>` between `splitter` (line 2148) and the `<optgroup>` (line 2149).

**Implementation** — after line 2148, before line 2149:
```html
<option value="gatherer">Context Gatherer</option>
```

**Edge Cases:** None — static HTML option only.

---

### `src/webview/sharedDefaults.js` — Add gatherer to DEFAULT_ROLE_CONFIG

**File:** [`src/webview/sharedDefaults.js`](src/webview/sharedDefaults.js)

**Context:** `DEFAULT_ROLE_CONFIG` (line 17) defines per-role config shapes. `ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG)` (line 52) is derived — no separate ROLE_KEYS edit needed.

**Logic:** Add a `gatherer` entry matching the shape of other simple roles (like `analyst`).

**Implementation** — add after `research_planner` entry (line 31), before the closing `};` of `DEFAULT_ROLE_CONFIG`:
```javascript
gatherer: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false } },
```

**Edge Cases:** `ROLE_KEYS` auto-updates via `Object.keys()` — no further changes required. All consumers of `DEFAULT_ROLE_CONFIG` will pick up `gatherer` automatically.

---

### `src/webview/sharedDefaults.js` — Add gatherer to ROLE_ADDONS

**File:** [`src/webview/sharedDefaults.js`](src/webview/sharedDefaults.js)

**Context:** `ROLE_ADDONS` (lines 59–143) provides the add-on checkbox metadata for the prompts tab UI. Every role in `DEFAULT_ROLE_CONFIG` should have a matching entry to avoid empty or broken add-ons panels.

**Logic:** Add a `gatherer` entry after `research_planner` (line 143), before the closing `}` of `ROLE_ADDONS`.

**Implementation:**
```javascript
gatherer: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
    { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false }
],
```

**Edge Cases:** The `gatherer` role has no terminal dispatch; omit performance/pair-programming addons not relevant to clipboard-only roles.

---

## Verification Plan

### Automated Tests
```bash
npx tsc --noEmit
```
- Should show no new TypeScript errors

### Manual Verification
1. Open Kanban → Prompts tab
2. Open the role selector dropdown
3. Confirm "Context Gatherer" appears in the list (above the Custom Agents group)
4. Select "Context Gatherer"
5. Confirm the prompt preview textarea appears and is editable
6. Confirm add-ons panel renders (Switchboard Safeguards, Git Prohibition, etc.)
7. Enter a custom prompt and save
8. Reload the panel and confirm the custom prompt persists

---

> **Recommendation:** Send to Coder (complexity 3)
