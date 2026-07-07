# Fix "Open Terminals" to Honor Every Agent Visibility Checkbox

**Plan ID:** 7c4f2a8e-9b3d-4e6a-8c1f-2d5b7e9a0c34

## Goal

The "Open Terminals" button (the main **Agents** button, wired to `switchboard.createAgentGrid`) silently ignores the visibility checkboxes for **Phone-a-Friend**, **Acceptance Tester**, **Ticket Updater**, and **Researcher** in the Agents tab. Ticking those boxes and clicking Open Terminals opens every other configured agent but never opens these four. The fix is to make the launch loop in `createAgentGrid` cover every role that has a checkbox, so the visibility flag the user set is actually consumed — and to make Phone-a-Friend's default-visibility consistent with the other three optional roles so the fix does not auto-open a terminal for fresh users who never ticked its box.

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

**Why this is especially broken for Phone-a-Friend:** Phone-a-Friend is a *persistent* terminal that sits idle until a coder's `curl` to `POST /phone-a-friend` triggers a second-pass dispatch into it (see `LocalApiServer._handlePhoneAFriend`, lines 650–694, and `TaskViewerProvider._dispatchPhoneAFriend`, lines 3008–3065). The host callback "handles the silent drop when no terminal is running" (line 3034–3037 logs and returns). Because Open Terminals never creates the terminal, every Phone-a-Friend dispatch silently drops — the entire feature is dead for any user who relies on the button instead of manually opening and naming a terminal.

**Jules is intentionally excluded** — its checkbox row says "Cloud coder visibility only" and has no command field; it is handled separately by the `includeJulesMonitor` flag (line 2632) and the Jules Monitor push (line 2662). Jules must remain out of `allBuiltInAgents`.

**Default-visibility subtlety discovered during review:** `TaskViewerProvider.getVisibleAgents` (`src/services/TaskViewerProvider.ts` lines 4039–4053) seeds these defaults:

```ts
const defaults: Record<string, boolean> = {
    lead: true, coder: true, intern: true, reviewer: true,
    tester: false, planner: true, analyst: true, jules: false,
    ticket_updater: false, researcher: false,
    mcp_monitor: false, claude_artifacts: false
};
```

`phone_a_friend` is **absent** from this defaults object, so for a user with no saved preference `visibleAgents.phone_a_friend` is `undefined`. The grid loop tests `if (visibleAgents[builtIn.role] !== false)`, and `undefined !== false` is `true` — meaning the array fix alone would make Phone-a-Friend **auto-open for fresh users** even though its checkbox renders *unchecked* in HTML (kanban.html line 2824). The other three optional roles (`tester`, `ticket_updater`, `researcher`) all default to `false`, so they do **not** auto-open. Adding `phone_a_friend: false` to the defaults makes Phone-a-Friend opt-in by default — matching its unchecked checkbox and matching its three optional siblings. This is a Clarification (consistency with the existing default pattern for optional roles), not new product scope.

## Metadata

**Complexity:** 4
**Tags:** bugfix, frontend, ui, reliability

## User Review Required

Yes — review the second change (the `getVisibleAgents` defaults addition). The array fix is mandatory and non-controversial. The defaults addition is a Clarification that changes observable behavior for fresh installs (Phone-a-Friend becomes opt-in by default instead of auto-opening). Existing users who have already ticked the Phone-a-Friend box are unaffected — saved `visibleAgents` values override defaults (`{ ...defaults, ...fileValue }` at line 4063). Confirm the opt-in default is the intended product behavior before coding.

## Complexity Audit

### Routine
- Adding four entries to a hardcoded `{ name, role }` array in `createAgentGrid` — no logic change, the existing visibility-check loop already does the right thing.
- Adding one key (`phone_a_friend: false`) to the `defaults` object in `getVisibleAgents` — a single literal line, same shape as the surrounding `tester: false` / `researcher: false` entries.
- No new branches, no new state, no schema changes. Both edits reuse patterns already present in the same functions.

### Complex / Risky
- Phone-a-Friend is a **persistent, dispatch-driven** terminal (not a click-to-run agent). Wiring it into the grid means the terminal it creates must be the *same terminal* the `/phone-a-friend` callback resolves at dispatch time — a name-mismatch would silently resurrect the original "drops every dispatch" bug. Verification must confirm the end-to-end curl → dispatch → terminal path, not just that a terminal opens.
- The fix newly makes `phone_a_friend`'s default-visibility observable (it was previously dead code). Choosing the wrong default ships an auto-open behavior to ~4,000 installs — hence the second change.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `createAgentGrid` pre-subscribes to `onDidStartTerminalShellExecution` before creating terminals (lines 2784–2787) to avoid a fast-shell race. Adding four roles to the array does not touch this ordering — the new terminals flow through the same pre-subscribed path. No new race introduced.
- Phone-a-Friend dispatch is serialized behind `_phoneAFriendInFlight` (lines 3010–3012). Opening the terminal via the grid does not interact with that serialization guard; the guard only chains dispatches. No new race.

**Security:**
- No new inputs, no new endpoints, no new auth surface. The `/phone-a-friend` endpoint already validates `planFile` (non-empty, relative, no `..` traversal — lines 673–682) and checks auth (line 651). The grid change only decides *whether to create a terminal*; it does not alter the endpoint's validation. No security impact.

**Side Effects:**
- **Fresh-install auto-open:** without the defaults change, Phone-a-Friend would auto-open for fresh users (undefined default). The defaults change (`phone_a_friend: false`) eliminates this side effect — Phone-a-Friend becomes opt-in like `tester`/`ticket_updater`/`researcher`.
- **Worktree grids (verified — no behavior change):** the worktree branch (lines 2670–2677) maps `agents.map(a => a.role)` into `ensureWorktreeTerminals(w.path, roles)`. Adding the four roles means their role strings are now *passed* to `ensureWorktreeTerminals`, but that function filters to **autoban-pool roles only** (`_autobanPoolRoles`, TaskViewerProvider.ts lines 6617–6630, returns `['planner', 'coder', 'lead', 'reviewer', 'intern']` + custom agents). The `eligiblePoolRoles` check at lines 7700–7703 silently `continue`s any role not in the pool — so `tester`, `ticket_updater`, `researcher`, and `phone_a_friend` are **silently skipped** and get **no worktree terminal**, with no error toast (the comment at lines 7685–7688 documents this exact filter pattern). This is the correct behavior: worktree terminals are for autoban-pool coding agents, not for Phone-a-Friend/Tester/Ticket Updater/Researcher. The **main-repo** grid path (lines 2679+) is unaffected and DOES create the terminals. Net: no worktree regression, no toast spam.
- **Existing users with checkboxes unticked:** `visibleAgents[role] !== false` means an *undefined* value is treated as visible, but a saved `false` is honored. Users who explicitly unticked any of the four keep their unticked state. Users who never toggled `tester`/`ticket_updater`/`researcher` already have `false` defaults → no terminal. Users who never toggled `phone_a_friend` get `false` after the defaults change → no terminal (was `undefined` → would have opened without it).
- **Phone-a-Friend with no command configured:** if the user ticks the box but leaves the command field empty, `createAgentGrid` still opens the terminal (the launch loop does not check for a non-empty command). Same behavior as every other role (e.g. an empty Coder command). Not a regression.
- **Jules:** confirmed not affected. Jules stays out of `allBuiltInAgents` and continues to be controlled by `includeJulesMonitor` (line 2632) and the Jules Monitor push (line 2662).
- **Custom-name mismatch (pre-existing, out of scope):** Phone-a-Friend dispatch resolves the terminal name via `_getAgentNameForRole('phone_a_friend', root) || 'Phone-a-Friend'` (line 3020) and looks it up in `_registeredTerminals` by that name and its suffixed form (lines 3024–3026), with a fallback scan of open terminals by normalized name (lines 3028–3032). The grid creates the terminal with the hardcoded name `'Phone-a-Friend'` and registers it under `suffixedName(agent.name)`. For the default case (no custom name in state.json) these align and dispatch succeeds. If a user has customized the Phone-a-Friend terminal name in `state.json`, the grid would still create `'Phone-a-Friend'` while dispatch hunts for the custom name → silent drop. **This same mismatch exists today for every role in `allBuiltInAgents`** (planner, coder, etc. all use hardcoded names while dispatch uses `_getAgentNameForRole`) — it is a pre-existing inconsistency, not one introduced by this fix. Disclosed here for completeness; resolving it (deriving grid names from `_getAgentNameForRole`) is out of scope for this bugfix.

**Dependencies & Conflicts:**
- **Label drift:** the fix hardcodes display names (`'Acceptance Tester'`, `'Ticket Updater'`, `'Researcher'`, `'Phone-a-Friend'`) in a second location — `allBuiltInAgents` — while `BUILT_IN_AGENT_LABELS` (`src/services/agentConfig.ts` lines 110–120) already owns the first three. `phone_a_friend` is intentionally **not** in `BUILT_IN_AGENT_LABELS` (it has no kanban column and is not a pipeline stage). Deriving `allBuiltInAgents` from `BUILT_IN_AGENT_LABELS` would eliminate the duplication but is scope creep for this bugfix and would force adding `phone_a_friend` to `BUILT_IN_AGENT_LABELS` (which the original plan correctly argues is out of scope). Accept the duplication; note that a future plan that adds a Phone-a-Friend kanban column should also reconcile the two label sources.
- No dependency on other plans or sessions. No conflict with the Jules Monitor or MCP Monitor paths — those are pushed separately (lines 2662–2666) and untouched.

## Dependencies

- None. This is a self-contained bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the array fix alone would auto-open Phone-a-Friend for fresh users because `phone_a_friend` is absent from the `getVisibleAgents` defaults (undefined → visible), unlike its three optional siblings which default to false — mitigated by the one-line defaults addition; (2) Phone-a-Friend is dispatch-driven, so the grid-created terminal name (`'Phone-a-Friend'`) must match the name the `/phone-a-friend` callback resolves — verified to align for the default case, with a pre-existing custom-name mismatch disclosed as out of scope; (3) no automated test covers `createAgentGrid` terminal creation, so the end-to-end Phone-a-Friend curl loop is the sole regression guard and must be run manually. Mitigations: add `phone_a_friend: false` to defaults, keep the change to two one-line edits, and require the manual curl-based acceptance test before closing.

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

Ordering follows the Agents tab layout (kanban.html lines 2788–2824). No other changes are required in this function — the existing loop at lines 2646–2656 already does the right thing (`if (visibleAgents[builtIn.role] !== false)`) and the planner-multi-terminal branch (lines 2648–2651) is unaffected. The cleanup path (`clearGridBlockers`, lines 2720–2780) iterates `for (const agent of agents)` and builds `agentNames = new Set(agents.map(a => a.name))`, so once the four roles are in `agents` their terminals are covered by the dispose-on-untick and duplicate-cleanup logic automatically.

### [MODIFY] `src/services/TaskViewerProvider.ts` — `getVisibleAgents`, add `phone_a_friend: false` default (Clarification)

**Lines 4040–4053.** Add `phone_a_friend: false` to the `defaults` object so Phone-a-Friend is opt-in by default, matching its unchecked checkbox (kanban.html line 2824) and matching its three optional siblings (`tester: false`, `ticket_updater: false`, `researcher: false`):

```ts
// BEFORE:
const defaults: Record<string, boolean> = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    jules: false,
    ticket_updater: false,
    researcher: false,
    mcp_monitor: false,
    claude_artifacts: false
};

// AFTER:
const defaults: Record<string, boolean> = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    jules: false,
    ticket_updater: false,
    researcher: false,
    mcp_monitor: false,
    claude_artifacts: false,
    phone_a_friend: false
};
```

Saved `visibleAgents` values override defaults via `{ ...defaults, ...fileValue }` (line 4063) and the `globalState` merge (line 4071), so existing users who have already toggled Phone-a-Friend are unaffected. Only users with no saved preference for `phone_a_friend` get the new `false` default. This change is strictly implied by the existing default pattern for optional roles (Clarification, not new scope).

### No other files need changes

- `kanban.html` — checkboxes, autosave (`agentsTabCollectConfig`/`agentsTabSaveConfig`, lines 3752–3769), and the `startupCommands` sync (lines 7005–7012) already handle these roles correctly. The sync handler at line 7011 (`cb.checked = vis[cb.dataset.role] !== false`) means a saved `false` renders the checkbox unchecked and a saved `true` (or legacy `undefined`) renders it checked. No UI changes.
- `agentConfig.ts` — `BUILT_IN_AGENT_LABELS` already includes `tester`, `ticket_updater`, `researcher`. `phone_a_friend` is not in `BUILT_IN_AGENT_LABELS` and does not need to be: it has no kanban column and is not a pipeline stage; it only needs to be launchable, which the array fix above accomplishes. (If a future plan adds a column for it, that plan should also add it to `BUILT_IN_AGENT_LABELS` and reconcile the two label sources — out of scope here.)
- `LocalApiServer.ts` — `_handlePhoneAFriend` (lines 650–694) dispatch endpoint is already correct.
- `TaskViewerProvider.ts` — `getStartupCommands` (line 3952) already returns commands for all roles saved by the Agents tab, including the four (it reads a generic `Record<string, string>` from state). `_dispatchPhoneAFriend` (lines 3008–3065) resolves the terminal by name and is already correct. Only the `getVisibleAgents` defaults need the one-line addition above.

## Edge Cases & Risks

- **Existing users with checkboxes unticked:** `visibleAgents[role] !== false` means a saved `false` is honored and an *undefined* value is treated as visible. After both changes: `tester`/`ticket_updater`/`researcher` already default to `false` → do not open for never-toggled users; `phone_a_friend` now also defaults to `false` → does not open for never-toggled users. Users who explicitly ticked any of the four get their saved `true` → terminal opens. Net effect: "the box you see is the box that opens" — consistent across all four roles and consistent with the other roles in the array.
- **Fresh-install Phone-a-Friend auto-open (corrected during review):** the original draft of this plan asserted all four roles "will start opening terminals for any user who has never explicitly unticked them — which matches the existing behavior of every other role." That is imprecise. Only `phone_a_friend` had an `undefined` default (→ would auto-open); `tester`/`ticket_updater`/`researcher` all default to `false` (→ do not auto-open). The `getVisibleAgents` defaults addition above closes the gap so `phone_a_friend` matches its three optional siblings and its unchecked checkbox.
- **Phone-a-Friend with no command configured:** If the user ticks the box but leaves the command field empty, `createAgentGrid` will still attempt to open a terminal for it. This is the same behavior as every other role (the launch loop does not check for a non-empty command). The terminal will open with no startup command — consistent with existing behavior for, e.g., an empty Coder command. Not a regression.
- **Worktree terminals (verified — no behavior change):** The worktree branch (lines 2670–2677) passes `agents.map(a => a.role)` to `ensureWorktreeTerminals(w.path, roles)`. The four new roles are now in that `roles` array, but `ensureWorktreeTerminals` filters to autoban-pool roles only (`_autobanPoolRoles` = `['planner', 'coder', 'lead', 'reviewer', 'intern']` + custom agents; filter at lines 7700–7703). The four roles are silently skipped — no worktree terminal is created for them and no error toast fires. The main-repo grid path is unaffected. This is the correct behavior: these four roles are not autoban-pool coding agents and should not get worktree terminals.
- **Phone-a-Friend custom-name mismatch (pre-existing, out of scope):** see the Edge-Case & Dependency Audit above. The grid hardcodes `'Phone-a-Friend'`; dispatch uses `_getAgentNameForRole('phone_a_friend') || 'Phone-a-Friend'`. They align for the default case. A user-customized terminal name would mismatch — but this is a pre-existing issue for every role, not introduced here.
- **Jules:** Confirmed not affected. Jules stays out of `allBuiltInAgents` and continues to be controlled by `includeJulesMonitor`.

## Verification Plan

### Automated Tests

No automated test covers `createAgentGrid` terminal creation or the Phone-a-Friend dispatch loop. The existing `src/test/agent-startup-command-fallbacks.test.ts` only asserts the `jules_monitor` fallback contract and the `getAgentStartupCommand` method shape; it does not exercise the grid array or `getVisibleAgents` defaults, and the defaults addition (`phone_a_friend: false`) does not break it (verified by reading the test — it never references `phone_a_friend` or the defaults object). Per session directives, automated tests are not run as part of this verification. A regression guard could be added later as a source-string assertion that `allBuiltInAgents` contains the `phone_a_friend` role and that the `getVisibleAgents` defaults include `phone_a_friend: false` — out of scope for this bugfix.

### Manual Verification

1. Tick Phone-a-Friend (and optionally Tester/Ticket Updater/Researcher) in the Agents tab, set a startup command, let it autosave.
2. Click the main **Agents** button (`switchboard.createAgentGrid`).
3. Confirm a terminal opens for each ticked role, including Phone-a-Friend.
4. Untick one, click Agents again, confirm that role's terminal is not recreated (existing terminal cleanup path at lines 2720–2780 already handles this for any name in the `agents` set — now it includes the four).
5. For Phone-a-Friend specifically: with its terminal open, trigger a coder batch-done `curl` to `POST /phone-a-friend` and confirm the second-pass dispatch lands in the terminal instead of silently dropping (check the diagnostics channel does NOT log `[Phone-a-Friend] POST received for ..., no terminal running, dropped.`).
6. Fresh-install default check: on a workspace with no saved `visibleAgents`, confirm clicking Agents does **not** open a Phone-a-Friend terminal (defaults now `false`), and does not open Tester/Ticket Updater/Researcher terminals (already `false`). Open the Agents tab and confirm the Phone-a-Friend checkbox renders unchecked.

**Recommendation:** Complexity 4 → **Send to Coder**.

**Stage Complete:** PLAN REVIEWED

**Stage Complete:** Coded

## Review Findings

Both plan edits verified in place and committed: the four roles added to `allBuiltInAgents` (`src/extension.ts:2635-2647`, Jules correctly excluded) and `phone_a_friend: false` added to the `getVisibleAgents` defaults (`src/services/TaskViewerProvider.ts:4053`). Full-path regression audit confirmed checkbox → autosave → `getVisibleAgents` → grid launch → shared-registry registration (`suffixedName('Phone-a-Friend')`) → `_dispatchPhoneAFriend` suffixed-key lookup all align, and no other consumer reads `phone_a_friend` visibility, so the new default cannot break dispatch or any generic `enabled === true` filter. No CRITICAL or MAJOR findings; no code fixes were required. NITs deferred: a stale webview comment (kanban.html ~line 7125 claims startupCommands sends raw state — both live senders send defaults-merged data) and duplicated column-scoped defaults objects (KanbanProvider `_getVisibleAgents` fallback, PlanningPanelProvider `_getKanbanColumnDefinitions`) that intentionally omit non-column roles. Residual risk: existing users who ever opened the Agents tab pre-fix may have `phone_a_friend: true` incidentally persisted (the undefined default rendered its checkbox checked, and any autosave captured it), so Open Terminals will now open a Phone-a-Friend terminal for them — this matches their visibly-checked box and is one-click reversible; compilation and automated tests were skipped per session directives.

**Stage Complete:** CODE REVIEWED
