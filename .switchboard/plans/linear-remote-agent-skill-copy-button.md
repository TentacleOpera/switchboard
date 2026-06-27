# Linear Remote Tab: Dynamic Agent Skill Copy Button

## Goal

Add a "Copy Linear Agent Skill" button to the Kanban REMOTE tab that generates a tailored instruction text for the Linear native agent, pre-filled with the user's actual board/status mappings. The user pastes this into Linear's agent configuration manually as a one-time setup step.

### Background & Problem

Switchboard's Linear Remote Control feature allows driving the Kanban board from any Linear client — moving an issue between Linear states dispatches the local column agent; comments are routed to that agent and responses written back. The Linear app has a native AI agent that users can instruct to manage issues on their behalf. However, for the native agent to operate correctly as a Switchboard controller, it needs to know:
- Which Linear status names map to which Switchboard actions
- How to format issue descriptions as plans
- How to interact via comments

There is currently no way for Switchboard to surface this information in a usable form. Users must manually piece together their own instructions from documentation. Because the sync function ensures Linear status names match Switchboard column names, the mapping data is already in the DB and can be used to generate a fully tailored skill text with zero user effort.

---

## Implementation Tasks

### 1. Read column-to-state mapping for skill generation

**File:** `src/services/LinearSyncService.ts`

The `LinearConfig` interface (lines 17–34) contains `columnToStateId: Record<string, string>` — a map of Switchboard column names to Linear state IDs. The state names and column names match by convention (enforced by the sync function). This is loaded via `loadConfig()` from the Kanban DB config table under key `"linear-config"`.

The skill generator needs:
- Column names from `columnToStateId` keys (these ARE the Linear status names)
- Remote config from DB key `"remote.config"` for any board-level context

### 2. Implement skill text generator

Add a function (in the kanban webview message handler or a utility in `LinearSyncService.ts`) that:

1. Loads `LinearConfig.columnToStateId` to extract column/status names
2. Identifies which columns represent "trigger" states (all mapped columns)
3. Interpolates into a template:

```
You are a controller for the Switchboard AI development board.

## How it works
Switchboard polls Linear every [ping frequency]s. When you move an issue to a new state, it dispatches the corresponding local AI agent. Comments you post on an issue are routed to that column's agent; responses appear as new comments.

## Column → Agent mapping
[For each column name in the mapping:]
- Move to "[Column Name]" → dispatches the [Column Name] agent

## How to write plans
Place the implementation plan in the issue description. No special format is required, but use clear sections (Goal, Tasks, Notes). The local agent reads whatever is in the description.

## Responding to questions
If the user asks a question in a comment, post it as a comment on the issue. The local agent will respond in a follow-up comment within one polling cycle.

## Setup notes
- Remote control must be enabled (toolbar button in VS Code).
- Only move issues between states that appear in the mapping above.
- Do not create new Linear states — only use the ones listed.
```

### 3. Add "Copy Linear Agent Skill" button to REMOTE tab

**File:** `src/webview/kanban.html`, REMOTE tab section (lines 2544–2593, `#remote-tab-content`)

- Add a button below the existing remote description text, labelled **"Copy Linear Agent Skill"**
- On click: generate the skill text (using current config from DB), write to clipboard, show brief "Copied!" feedback on the button (revert after 2s)
- Disable the button (with tooltip "Configure Linear sync first") if `columnToStateId` is empty or remote control is not configured

### 4. Wire up the message handler

**File:** `src/webview/kanban.html` JS section (lines 6879–6957)

Add a `vscode.postMessage` call for the button click, and a handler in the extension host (`TaskViewerProvider.ts` or equivalent) that:
1. Loads `LinearConfig` via `LinearSyncService.loadConfig()`
2. Loads `remote.config` from DB
3. Generates the skill text
4. Posts it back to the webview
5. Webview writes to clipboard via `navigator.clipboard.writeText()`

---

## Edge Cases & Risks

- **No mapping configured:** If `columnToStateId` is empty (Linear not set up), the button should be disabled with a clear label explaining why.
- **Partial mapping:** Some columns may not be mapped to Linear states. Only include mapped columns in the generated text — don't reference unmapped ones.
- **Ping frequency:** Read from `remote.config` to interpolate the actual polling interval. Default to "60s" if not set.
- **Clipboard API availability:** `navigator.clipboard` requires a secure context. The webview runs in VS Code's sandboxed iframe — use the standard clipboard API; if it fails, fall back to a textarea + `document.execCommand('copy')`.

---

## Out of Scope

- No changes to the Linear sync protocol
- No changes to how remote control works
- No automated posting of the skill text to Linear

---

## Metadata

**Complexity:** 3
**Tags:** frontend, backend, api, ui, infrastructure
