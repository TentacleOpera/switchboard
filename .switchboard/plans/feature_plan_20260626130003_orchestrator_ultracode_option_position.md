# Move the Orchestrator "Ultracode" Option Up into the Main Options Group

## Goal

In the Kanban panel's **Prompts tab**, for the **Orchestrator** role, the "Ultracode" option currently renders at the very bottom of the option list (below "Subagent Policy", "Worktrees Per Plan", and "Workflow File"). It should sit with the main top-level checkboxes that appear **above** the "Subagent Policy" section, so it's discoverable as a primary orchestration setting.

### Problem analysis & root cause

The Prompts tab's per-role option list is **fully data-driven**. There is no static orchestrator markup in `kanban.html`; instead `renderRoleAddons(role)` iterates `ROLE_ADDONS[role]` **in array order** and renders each entry. So the on-screen order is exactly the array order in `src/webview/sharedDefaults.js`.

For the orchestrator (`ROLE_ADDONS.orchestrator`, `src/webview/sharedDefaults.js:270-286`), the current order is:

```js
orchestrator: [
    { id: 'switchboardSafeguards', ... },        // 271  ┐
    { id: 'gitProhibition', ... },               // 272  │ main options
    { id: 'clearAntigravityContext', ... },      // 273  │ (top-level checkboxes)
    { id: 'cavemanOutput', ... },                // 274  │
    { id: 'skipCompilation', ... },              // 275  │
    { id: 'skipTests', ... },                    // 276  ┘
    { id: 'subagentPolicy', type: 'radio', ... },// 277  ← Subagent Policy section starts
    { id: 'useWorktreesPerPlan', ... },          // 283
    { id: 'workflowFilePath', type: 'file', ... },//284
    { id: 'ultracode', ... }                     // 285  ← currently LAST (wrong place)
];
```

`ultracode` is a plain checkbox (no `type`), so it already renders in the standard checkbox branch — it's purely a question of **position in the array**. Moving its object up to just after `skipTests` (line 276) and before `subagentPolicy` (line 277) puts it in the main options group with no other change required. The directive wiring (`ULTRACODE_DIRECTIVE` in the prompt builder and the `ultracodeByRole` mapping in `KanbanProvider.ts`) is keyed by the `id` string, not by array position, so it is unaffected.

**Verified against source (improve-plan pass):**
- `renderRoleAddons` (`src/webview/kanban.html:3290`) does `addons.forEach(addon => ...)` straight off `ROLE_ADDONS[role]` — no sort, no filter. Array order is render order. Confirmed.
- `ultracode` is keyed by `id`/boolean in three places, none of which depend on array position:
  - `src/services/KanbanProvider.ts:2950` — `ultracodeEnabled: promptsConfig.ultracodeByRole?.[role] ?? false`
  - `src/services/KanbanProvider.ts:3432-3433` — `ultracodeByRole: { orchestrator: orchestratorConfig?.addons?.ultracode ?? false }`
  - `src/services/agentPromptBuilder.ts:1232` — `const ultracodeBlock = ultracodeEnabled ? ULTRACODE_DIRECTIVE : ''`
- Stored role configs are objects keyed by addon id (`roleConfigs[role].addons[addon.id]`, `kanban.html:3293`), so a reorder cannot orphan a persisted value.
- The orchestrator test (`src/test/orchestrator-prompt.test.js`) passes `ultracodeEnabled: true` as a boolean and imports the compiled builder; it never references `ROLE_ADDONS` or array order. Unaffected.

## Metadata

- **Tags:** ui, ux, refactor
- **Complexity:** 1 / 10
- **Primary file:** `src/webview/sharedDefaults.js`
- **Affected feature area:** Kanban panel → Prompts tab → Orchestrator role

## User Review Required

No review required beyond a visual confirmation. The change is a non-behavioural array reorder in a single file; no schema, persistence, directive, or cross-file logic is touched. A reviewer need only confirm the on-screen position and that the file still parses.

## Complexity Audit

### Routine
- Single-array element relocation in one file (`src/webview/sharedDefaults.js`).
- No logic, schema, persistence, message, or directive changes — render order is derived from the array, and `ultracode`'s value/persistence is keyed by `id`.
- Trailing-comma hygiene on the two swapped elements (move comma from `workflowFilePath` to `ultracode`'s new mid-array position).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The array is a static module-level literal read synchronously by `renderRoleAddons` on each role switch; no concurrent mutation path exists.
- **Security:** None. No user input, credentials, or privileged state involved.
- **Side Effects:** None beyond the visual reorder. Directive wiring (`ULTRACODE_DIRECTIVE`), persistence (`ultracodeByRole`), and prompt assembly are all keyed by `id`/boolean and are position-independent (verified above).
- **Dependencies & Conflicts:**
  - **Trailing comma hygiene (the single real trap):** today `ultracode` (line 285) is the last element with *no* trailing comma and `workflowFilePath` (line 284) has *one*. After the swap, `workflowFilePath` becomes last. If the implementer leaves `ultracode` without a trailing comma in its new mid-array position, the file throws a `SyntaxError` and the webview fails to load (Prompts tab renders blank). The proposed code block below shows the correct comma placement; this must be the #1 verification check.
  - **No effect on other roles:** only `ROLE_ADDONS.orchestrator` is touched; other roles' arrays are independent.
  - **`renderRoleAddons` requires no change:** it iterates with `forEach` and no sorting (`src/webview/kanban.html:3290`), so the new order is honoured automatically.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) a trailing-comma `SyntaxError` if the manual edit leaves `ultracode` comma-less in its new mid-array slot — the single point of failure, already flagged and handled in the proposed code block. Mitigations: lead verification with a parse/load check rather than a full compile; the proposed code shows correct comma placement. No persistence, directive, or cross-file risk remains — all wiring is keyed by `id`/boolean and verified position-independent.

## Proposed Changes

### `src/webview/sharedDefaults.js` — reorder `ROLE_ADDONS.orchestrator`

Move the `ultracode` object from the end of the array (line 285) to immediately after `skipTests` (line 276) and before `subagentPolicy` (line 277). Note the trailing comma moves from `workflowFilePath` to `ultracode`'s new mid-array position; `workflowFilePath` becomes the last element with no trailing comma.

```js
orchestrator: [
    { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: false },
    { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
    { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
    { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
    { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: false },
    { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: false },
    { id: 'ultracode', label: 'Ultracode', tooltip: 'Append the "use ultracode" directive so a Claude Code host orchestrates the epic with multi-agent workflows', default: false },
    { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
        { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
        { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
        { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents to handle each epic subtask concurrently' },
        { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
    ], default: 'useSubagents' },
    { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each subtask in an isolated git worktree', default: false },
    { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
]
```

- **Context:** `ROLE_ADDONS.orchestrator` is the single source of the Orchestrator role's on-screen option order; `renderRoleAddons` renders it verbatim.
- **Logic:** No logic change — pure element relocation.
- **Implementation:** Cut the `ultracode` object from line 285, paste it between `skipTests` (276) and `subagentPolicy` (277). Remove the trailing comma from `workflowFilePath` (now last); add a trailing comma to `ultracode` in its new mid-array position.
- **Edge Cases:** Trailing-comma correctness (see Edge-Case audit). No other edge cases.

> Note: this plan only reorders. The `default` values shown above are the actual current values in `src/webview/sharedDefaults.js` (corrected during review — an earlier draft of this block showed stale `true` defaults for `switchboardSafeguards`, `skipCompilation`, and `skipTests`; the real values are `false`). Changing those defaults is a separate change (tracked in its own plan).

## Verification Plan

> Compilation and automated tests are skipped this session per directive. The change is a static array literal with no logic, so a parse/load check plus visual confirmation is sufficient.

1. **Parse check (primary):** confirm `src/webview/sharedDefaults.js` still parses — open the Kanban panel and verify the Prompts tab renders without a blank/broken view. A `SyntaxError` from a misplaced trailing comma would surface here immediately.
2. **Visual order:** open Kanban → Prompts tab → select the Orchestrator role. Confirm "Ultracode" now appears in the top-level checkbox group, directly below "Do not run automated tests" and above the "Subagent Policy" radio group.
3. **Toggle persists:** check "Ultracode", switch to another role and back — the checkbox stays checked (value still keyed by `id`).
4. **Directive still applies:** dispatch/preview an orchestrator prompt with Ultracode enabled and confirm the "use ultracode" directive is still appended (behaviour unchanged by the reorder).
5. **Other roles unaffected:** confirm coder/planner/reviewer option lists are unchanged.

---

**Recommendation:** Complexity 1/10 → **Send to Intern**.

---

## Review Results (Reviewer-Executor Pass, 2026-06-26)

### Stage 1 — Grumpy Findings

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | NIT | Plan's "Proposed Changes" code block showed stale `default: true` for `switchboardSafeguards`, `skipCompilation`, `skipTests`; actual code has `default: false`. Implementer correctly preserved real defaults. | `feature_plan_...md:86-91` (plan doc, now corrected) |

No CRITICAL or MAJOR findings. The code implementation is correct.

### Stage 2 — Balanced Synthesis

- **Keep:** `ultracode` relocation to line 277 (after `skipTests`, before `subagentPolicy`) — matches plan exactly.
- **Keep:** Trailing comma on `ultracode` (277), no trailing comma on `workflowFilePath` (285, last element) — comma hygiene correct.
- **Keep:** Directive/persistence wiring keyed by `id`/boolean across 3 call sites — position-independent, verified unchanged.
- **Fix now (doc only):** Corrected stale `default` values in plan's proposed code block to match actual code (`false` for the three flagged addons). Updated note at line 109.
- **Deferred:** Nothing.

### Code Fixes Applied

None. The implementation in `src/webview/sharedDefaults.js:270-286` is correct as-is. Only the plan file's documentation was corrected (stale default values in the proposed code block).

### Files Changed

- `src/webview/sharedDefaults.js` — **no changes required** (implementation already correct: `ultracode` at line 277, comma hygiene correct).
- `.switchboard/plans/feature_plan_20260626130003_orchestrator_ultracode_option_position.md` — corrected stale `default` values in proposed code block (lines 86-91) and updated note (line 109).

### Validation Results

| Check | Result |
|---|---|
| `node --check src/webview/sharedDefaults.js` (parse) | ✅ `PARSE_OK` |
| `ultracode` position (line 277, after `skipTests`, before `subagentPolicy`) | ✅ Confirmed |
| Trailing comma on `ultracode`; none on `workflowFilePath` (last) | ✅ Confirmed |
| `renderRoleAddons` uses `forEach` with no sort/filter (`kanban.html:3290`) | ✅ Confirmed |
| Directive wiring keyed by `id`/boolean (3 call sites in `KanbanProvider.ts`, `agentPromptBuilder.ts`) | ✅ Confirmed position-independent |
| Other roles' arrays untouched | ✅ Confirmed |

*Compilation and automated tests skipped per session directive.*

### Remaining Risks

None. The change is a pure array element relocation with correct comma hygiene, verified parse-clean, and all downstream wiring is position-independent.
