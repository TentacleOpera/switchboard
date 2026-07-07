# Fix "Open Terminals" to Honor Every Agent Visibility Checkbox

## Goal

The "Open Terminals" button (the main **Agents** button, wired to `switchboard.createAgentGrid`) silently ignores the visibility checkboxes for **Phone-a-Friend**, **Acceptance Tester**, **Ticket Updater**, and **Researcher** in the Agents tab. Ticking those boxes and clicking Open Terminals opens every other configured agent but never opens these four. The fix is to make the launch loop in `createAgentGrid` cover every role that has a checkbox, so the visibility flag the user set is actually consumed.

### Problem & Root Cause

The Agents tab in `kanban.html` renders a visibility checkbox (`class="agents-tab-visible-toggle"`) and a startup-command text field for each of these roles (lines 2788–2824):

- planner, lead, coder, intern, reviewer, **tester**, analyst, **ticket_updater**, **researcher**, jules, claude_artifacts, **phone_a_friend**

The checkbox autosave (`agentsTabCollectConfig` / `agentsTabSaveConfig`, kanban.html lines 3752–3768) correctly writes each role's `checked` state into `visibleAgents[<role>]` via the `saveStartupCommands` message. The backend persists it. So the user's intent is stored faithfully.

The break is in `createAgentGrid` in `src/extension.ts` (lines 2635–2656). It builds the launch list from a **hardcoded array** `allBuiltInAgents`:

```ts
const allBuiltInAgents = [
    { name: 'Planner', role: 'planner' },
    { name: 'Lead Coder', role: 'lead' },
    { name: 'Coder', role: 'coder' },
    { name: 'Intern', role: 'intern' },
    { name: 'Reviewer', role: 'reviewer' },
    { name: 'Analyst', role: 'analyst' },
    { name: 'Claude Artifacts', role: 'claude_artifacts' }
];
```

Four roles with checkboxes are absent from this array: `tester`, `ticket_updater`, `researcher`, `phone_a_friend`. The subsequent loop (`for (const builtIn of allBuiltInAgents)`) only checks `visibleAgents[builtIn.role]` for roles already in the array — so the visibility flag for the four missing roles is saved but never read, and no terminal is ever created for them.

**Why this is especially broken for Phone-a-Friend:** Phone-a-Friend is a *persistent* terminal that sits idle until a coder's `curl` to `POST /phone-a-friend` triggers a second-pass dispatch into it (see `LocalApiServer._handlePhoneAFriend`, lines 602–653). The host callback "handles the silent drop when no terminal is running." Because Open Terminals never creates the terminal, every Phone-a-Friend dispatch silently drops — the entire feature is dead for any user who relies on the button instead of manually opening and naming a terminal.

**Jules is intentionally excluded** — its checkbox row says "Cloud coder visibility only" and has no command field; it is handled separately by the `includeJulesMonitor` flag (line 2632) and the Jules Monitor push (line 2662). Jules must remain out of `allBuiltInAgents`.

## Metadata

**Complexity:** 2
**Tags:** bugfix, frontend, ui

## Proposed Changes

### [MODIFY] `src/extension.ts` — `createAgentGrid`, add missing roles to `allBuiltInAgents`

**Lines 2635–2643.** Add the four missing roles to the hardcoded array, using the same display names already defined in `BUILT_IN_AGENT_LABELS` (`src/services/agentConfig.ts` lines 110–120) and the Agents tab labels (`kanban.html` lines 2812, 2816, 2818, 2824):

```ts
// BEFORE:
const allBuiltInAgents = [
    { name: 'Planner', role: 'planner' },
    { name: 'Lead Coder', role: 'lead' },
    { name: 'Coder', role: 'coder' },
    { name: 'Intern', role: 'intern' },
    { name: 'Reviewer', role: 'reviewer' },
    { name: 'Analyst', role: 'analyst' },
    { name: 'Claude Artifacts', role: 'claude_artifacts' }
];

// AFTER:
const allBuiltInAgents = [
    { name: 'Planner', role: 'planner' },
    { name: 'Lead Coder', role: 'lead' },
    { name: 'Coder', role: 'coder' },
    { name: 'Intern', role: 'intern' },
    { name: 'Reviewer', role: 'reviewer' },
    { name: 'Acceptance Tester', role: 'tester' },
    { name: 'Analyst', role: 'analyst' },
    { name: 'Ticket Updater', role: 'ticket_updater' },
    { name: 'Researcher', role: 'researcher' },
    { name: 'Claude Artifacts', role: 'claude_artifacts' },
    { name: 'Phone-a-Friend', role: 'phone_a_friend' }
];
```

Ordering follows the Agents tab layout (kanban.html lines 2788–2824). No other changes are required — the existing loop at lines 2646–2656 already does the right thing (`if (visibleAgents[builtIn.role] !== false)`) and the planner-multi-terminal branch (lines 2648–2651) is unaffected.

### No other files need changes

- `kanban.html` — checkboxes, autosave, and the `startupCommands` sync (lines 6976–7003) already handle these roles correctly. No UI changes.
- `agentConfig.ts` — `BUILT_IN_AGENT_LABELS` already includes `tester`, `ticket_updater`, `researcher`. `phone_a_friend` is not in `BUILT_IN_AGENT_LABELS` and does not need to be: it has no kanban column and is not a pipeline stage; it only needs to be launchable, which the array fix above accomplishes. (If a future plan adds a column for it, that plan should also add it to `BUILT_IN_AGENT_LABELS` — out of scope here.)
- `LocalApiServer.ts` — dispatch endpoint is already correct.
- `TaskViewerProvider.ts` — `getStartupCommands` already returns commands for all roles saved by the Agents tab, including the four. No change.

## Edge Cases & Risks

- **Existing users with checkboxes unticked:** `visibleAgents[role] !== false` means an *undefined* value is treated as visible. The four newly-added roles will start opening terminals for any user who has never explicitly unticked them — which matches the existing behavior of every other role in the array and matches the checkbox default state (tester/ticket_updater/researcher/phone_a_friend all render *unchecked* in HTML, but the `startupCommands` handler at kanban.html line 6982 sets `cb.checked = vis[cb.dataset.role] !== false`, so a user who has never toggled them will see them become checked on next load). Net effect: consistent with the other roles. No surprise beyond "the box you see is the box that opens."
- **Phone-a-Friend with no command configured:** If the user ticks the box but leaves the command field empty, `createAgentGrid` will still attempt to open a terminal for it. This is the same behavior as every other role (the launch loop does not check for a non-empty command). The terminal will open with no startup command — consistent with existing behavior for, e.g., an empty Coder command. Not a regression.
- **Worktree terminals:** The worktree branch (lines 2670–2677) maps `agents.map(a => a.role)` into `ensureWorktreeTerminals`. Adding the four roles means worktree grids will now also open these terminals when their checkboxes are ticked. This is the correct generalization — the worktree path should mirror the main-repo path.
- **Jules:** Confirmed not affected. Jules stays out of `allBuiltInAgents` and continues to be controlled by `includeJulesMonitor`.

## Verification

1. Tick Phone-a-Friend (and optionally Tester/Ticket Updater/Researcher) in the Agents tab, set a startup command, let it autosave.
2. Click the main **Agents** button (`switchboard.createAgentGrid`).
3. Confirm a terminal opens for each ticked role, including Phone-a-Friend.
4. Untick one, click Agents again, confirm that role's terminal is not recreated (existing terminal cleanup path at lines 2720–2748 already handles this for any name in the `agents` set — now it includes the four).
5. For Phone-a-Friend specifically: with its terminal open, trigger a coder batch-done `curl` to `POST /phone-a-friend` and confirm the second-pass dispatch lands in the terminal instead of silently dropping.

**Stage Complete:** Created
