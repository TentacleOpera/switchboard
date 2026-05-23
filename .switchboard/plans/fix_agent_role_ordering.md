---
description: Fix agent role ordering in kanban.html prompts tab and agents tab
---

# Fix Agent Role Ordering

## Goal

Reorder built-in agent roles across three UI surfaces — `sharedDefaults.js`, `kanban.html` (agents tab and prompts tab role selector), and `agentConfig.ts` — so they reflect the logical workflow sequence (context gathering → planning → splitting → implementation → QA → tooling).

## Metadata

- **Tags:** frontend, UI
- **Complexity:** 2

## User Review Required

> [!NOTE]
> The `splitter` role label changes from `'Splitter'` to `'Splitter Agent'` in `sharedDefaults.js`. This is bundled with the reorder. Confirm this label change is intentional.

> [!NOTE]
> `agentConfig.ts` does **not** include `research_planner` in its `BuiltInAgentRole` union type. The proposed reorder for that file excludes `research_planner` to avoid a TypeScript type error. This pre-existing gap is out of scope for this plan.

## Complexity Audit

### Routine
- All changes are element reorders within existing arrays/objects/HTML blocks
- No logic changes, no new dependencies, no API surface changes
- Checkbox `checked` states are preserved by `data-role` attribute (key-based), not position
- Persisted agent config state uses role keys — reordering is safe

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is a static markup/array reorder with no async implications.

### Security
- None. No auth, no data access changes.

### Side Effects
- **Label change**: `sharedDefaults.js` entry for `splitter` changes from `'Splitter'` to `'Splitter Agent'`. Any consumer comparing label strings (not keys) could be affected. Code review shows labels are used for display only; keys drive logic.
- **Record ordering in `agentConfig.ts`**: JavaScript `Record<K, V>` iteration order for string keys is V8 insertion order in practice. Any consumer using `Object.keys(BUILT_IN_AGENT_LABELS)` will see the new order. This is cosmetic — no behavioral change expected.
- **`research_planner` exclusion from `agentConfig.ts`**: `research_planner` is absent from the `BuiltInAgentRole` union type (line 1 of `agentConfig.ts`). The reorder skips it in the TS record to avoid a type error. This is a pre-existing inconsistency.

### Dependencies & Conflicts
- No active plans in the kanban reference these files. The changes are purely cosmetic reordering.

## Dependencies

- None

## Adversarial Synthesis

Key risks: the `splitter` label rename bundled with the reorder is a silent UI text change, and the `agentConfig.ts` Record is missing `research_planner` from its union type. Mitigations: label change is display-only (no key-based logic affected); `research_planner` is excluded from the `agentConfig.ts` changes to prevent a TypeScript type error. The Record reorder in `agentConfig.ts` is cosmetic/consistency-only and carries no runtime risk.

## Proposed Changes

### `src/webview/sharedDefaults.js` (lines 36–50)

**Context**: The `BUILT_IN_AGENT_LABELS` array is the canonical source-of-truth for built-in agent order used by UI rendering logic. It is currently out of order relative to the workflow sequence.

**Logic**: Reorder the array entries. Also corrects the `splitter` label from `'Splitter'` → `'Splitter Agent'` for consistency with the HTML.

**Implementation**:

```javascript
// Before (lines 36-50):
const BUILT_IN_AGENT_LABELS = [
    { key: 'planner', label: 'Planner' },
    { key: 'lead', label: 'Lead Coder' },
    { key: 'coder', label: 'Coder' },
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'tester', label: 'Acceptance Tester' },
    { key: 'intern', label: 'Intern' },
    { key: 'analyst', label: 'Analyst' },
    { key: 'ticket_updater', label: 'Ticket Updater' },
    { key: 'researcher', label: 'Researcher' },
    { key: 'splitter', label: 'Splitter' },
    { key: 'research_planner', label: 'Research Planner' },
    { key: 'gatherer', label: 'Context Gatherer' },
    { key: 'jules', label: 'Jules' }
];

// After:
const BUILT_IN_AGENT_LABELS = [
    { key: 'gatherer', label: 'Context Gatherer' },
    { key: 'planner', label: 'Planner' },
    { key: 'research_planner', label: 'Research Planner' },
    { key: 'splitter', label: 'Splitter Agent' },
    { key: 'lead', label: 'Lead Coder' },
    { key: 'coder', label: 'Coder' },
    { key: 'intern', label: 'Intern' },
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'tester', label: 'Acceptance Tester' },
    { key: 'analyst', label: 'Analyst' },
    { key: 'ticket_updater', label: 'Ticket Updater' },
    { key: 'researcher', label: 'Researcher' },
    { key: 'jules', label: 'Jules' }
];
```

**Edge Cases**: `jules` has no entry in `DEFAULT_ROLE_CONFIG` — it is display-only in this array. This is unchanged behavior.

---

### `src/webview/kanban.html` — Prompts Tab Role Selector (lines 2147–2160)

**Context**: The `<select id="roleSelect">` dropdown in the Prompts tab is hardcoded with option elements in workflow-incorrect order.

**Logic**: Reorder `<option>` elements to match the canonical workflow sequence. The `selected` attribute remains on `planner` as the default.

**Implementation**: Replace lines 2148–2160:

```html
<!-- Before -->
<option value="planner" selected>Planner</option>
<option value="lead">Lead Coder</option>
<option value="coder">Coder</option>
<option value="reviewer">Reviewer</option>
<option value="tester">Acceptance Tester</option>
<option value="intern">Intern</option>
<option value="analyst">Analyst</option>
<option value="ticket_updater">Ticket Updater</option>
<option value="researcher">Researcher</option>
<option value="research_planner">Research Planner</option>
<option value="splitter">Splitter Agent</option>
<option value="gatherer">Context Gatherer</option>
<optgroup id="customAgentsGroup" label="Custom Agents"></optgroup>

<!-- After -->
<option value="gatherer">Context Gatherer</option>
<option value="planner" selected>Planner</option>
<option value="research_planner">Research Planner</option>
<option value="splitter">Splitter Agent</option>
<option value="lead">Lead Coder</option>
<option value="coder">Coder</option>
<option value="intern">Intern</option>
<option value="reviewer">Reviewer</option>
<option value="tester">Acceptance Tester</option>
<option value="analyst">Analyst</option>
<option value="ticket_updater">Ticket Updater</option>
<option value="researcher">Researcher</option>
<option value="jules">Jules</option>
<optgroup id="customAgentsGroup" label="Custom Agents"></optgroup>
```

**Note**: `jules` is added to the prompts tab selector (currently missing from it). The `customAgentsGroup` `<optgroup>` remains at the end.

**Edge Cases**: The `selected` attribute stays on `planner`. No JS state is bound to option position.

---

### `src/webview/kanban.html` — Agents Tab (lines 2031–2056)

**Context**: The Agents Tab lists all built-in agents with visibility checkboxes and CLI command inputs. Currently ordered incorrectly relative to workflow sequence.

**Logic**: Reorder the `startup-row` + `agent-description` div pairs. Preserve all `checked` attributes exactly as in the current code:
- **checked**: planner, lead, coder, intern, reviewer, analyst
- **unchecked**: gatherer, research_planner, splitter, tester, ticket_updater, researcher, jules

**Implementation**: Replace lines 2031–2056 with the reordered block:

```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="gatherer" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Context Gatherer</label><span style="flex:1;font-size:10px;color:var(--text-secondary);">Clipboard context gathering only</span></div>
<div class="agent-description">Aggregates codebase files, directory structure, and relevant symbols into the active prompt context.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="planner" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Planner</label><input type="text" data-role="planner" id="agents-tab-cmd-planner" placeholder="e.g. agy --approval-mode auto_edit" style="flex:1;"></div>
<div class="agent-description">Writes detailed step-by-step implementation plans and creates work checklists.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="research_planner" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Research Planner</label><input type="text" data-role="research_planner" id="agents-tab-cmd-research-planner" placeholder="e.g. agy --approval-mode auto_edit" style="flex:1;"></div>
<div class="agent-description">Scopes complex multi-part plans by gathering extensive context using deep research.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="splitter" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Splitter Agent</label><input type="text" data-role="splitter" id="agents-tab-cmd-splitter" placeholder="e.g. claude" style="flex:1;"></div>
<div class="agent-description">Segregates planned files into distinct routine and complex task batches.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="lead" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Lead Coder</label><input type="text" data-role="lead" id="agents-tab-cmd-lead" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="agent-description">Implements high-complexity files, complex refactors, and core architecture changes.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="coder" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Coder</label><input type="text" data-role="coder" id="agents-tab-cmd-coder" placeholder="e.g. agy --approval-mode auto_edit" style="flex:1;"></div>
<div class="agent-description">Implements low-complexity boilerplate, routine functions, and minor enhancements.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="intern" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Intern</label><input type="text" data-role="intern" id="agents-tab-cmd-intern" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="agent-description">Executes simple, repetitive code edits and heavily guided tasks at lowest cost.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="reviewer" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Reviewer</label><input type="text" data-role="reviewer" id="agents-tab-cmd-reviewer" placeholder="e.g. agy --approval-mode auto_edit" style="flex:1;"></div>
<div class="agent-description">Evaluates completed implementations against plans, checking for regressions and scope creep.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="tester" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester" id="agents-tab-cmd-tester" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
<div class="agent-description">Validates implemented changes against the Design Doc/PRD, applies fixes for requirement gaps, and logs verification results.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="analyst" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst" id="agents-tab-cmd-analyst" placeholder="e.g. qwen" style="flex:1;"></div>
<div class="agent-description">Researches general-purpose technical queries and outlines plan dependencies.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="ticket_updater" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Ticket Updater</label><input type="text" data-role="ticket_updater" id="agents-tab-cmd-ticket-updater" placeholder="e.g. agy" style="flex:1;"></div>
<div class="agent-description">Synchronizes plan state and comments back to connected project management systems (e.g. ClickUp/Linear).</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="researcher" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Researcher</label><input type="text" data-role="researcher" id="agents-tab-cmd-researcher" placeholder="e.g. claude" style="flex:1;"></div>
<div class="agent-description">Conducts semantic code searches and web research to discover necessary implementation context.</div>
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="jules" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Jules</label><span style="flex:1;font-size:10px;color:var(--text-secondary);">Cloud coder visibility only</span></div>
<div class="agent-description">Offloads tasks to Google Jules cloud-coding service for quota-free background execution.</div>
```

**Edge Cases**: The Jules auto-sync checkbox row (line 2057–2060) sits after the agent list and must NOT be moved — it is a separate section-level setting, not an agent row.

---

### `src/services/agentConfig.ts` (lines 73–85)

**Context**: The TypeScript `BUILT_IN_AGENT_LABELS` Record provides label lookups by role key. Its property insertion order is cosmetically inconsistent with the desired sequence. `research_planner` is NOT in the `BuiltInAgentRole` union type (line 1) and must **not** be added here without a separate type change.

**Logic**: Reorder properties to match workflow sequence. Omit `research_planner` (pre-existing type gap, out of scope).

**Implementation**:

```typescript
// Before (lines 73-85):
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    planner: 'Planner',
    'analyst': 'Analyst',
    'ticket_updater': 'Ticket Updater',
    'researcher': 'Researcher',
    'splitter': 'Splitter Agent',
    'gatherer': 'Context Gatherer'
};

// After:
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    gatherer: 'Context Gatherer',
    planner: 'Planner',
    splitter: 'Splitter Agent',
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    analyst: 'Analyst',
    ticket_updater: 'Ticket Updater',
    researcher: 'Researcher',
};
```

**Edge Cases**: `research_planner` is omitted because it is not in the `BuiltInAgentRole` union type. This is a pre-existing inconsistency. `jules` is also absent from the TS type (display-only in the JS array) — unchanged.

## Verification Plan

### Automated Tests
- (Skipped per session policy)

### Manual Verification
1. Open the Kanban panel → **Prompts tab** → confirm role selector dropdown shows agents in the new order: Context Gatherer, Planner, Research Planner, Splitter Agent, Lead Coder, Coder, Intern, Reviewer, Acceptance Tester, Analyst, Ticket Updater, Researcher, Jules, then Custom Agents group
2. Open the **Agents tab** → confirm agent rows appear in the new order with correct checked/unchecked states preserved
3. Verify role selection in the Prompts tab still correctly renders config panels and add-on checkboxes
4. Verify agent CLI command inputs still save/restore correctly (key-based persistence)

---

**Recommendation**: Send to **Intern** (complexity 2)
