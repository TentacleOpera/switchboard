# Move Agent and Prompt Configuration to Kanban View

Move Agent and Prompt Configuration to Kanban View
Goal
Move agent configuration (visibility, CLI commands, prompt controls) and default prompt overrides from the terminals sidebar and setup menu into a new AGENTS tab in kanban.html for better discoverability and accessibility.

Metadata
Tags: frontend, UI, UX Complexity: 7 Repo: (omit — single repo)

User Review Required
IMPORTANT

This plan removes HTML, JS, and CSS from implementation.html. The exact line ranges must be verified before deletion — they are approximate in the original plan. The implementer must grep for element IDs/comments to confirm ranges before cutting.

NOTE

setup.html is intentionally untouched. The full prompts system is copied from setup.html into kanban.html, not moved — setup.html retains its own copy for the setup flow.

Complexity Audit
Routine
Adding the AGENTS tab button to the kanban-tab-bar (1 line HTML)
Adding the agents-tab-content div shell to kanban.html
The tab switch logic already handles new tabs via querySelectorAll('.kanban-tab-btn') — no JS change needed for basic tab switching
Copying .subsection-header, .db-subsection, .startup-row CSS into kanban.html <style> block
Removing the CUSTOMIZE DEFAULT PROMPTS button from implementation.html
Complex / Risky
Porting autosave JS: The saveTerminalsAgentConfig() function and its event listeners in implementation.html (lines ~3310–3353) post saveStartupCommands. This must be re-implemented in kanban.html querying the new DOM IDs — if IDs collide between files (both webviews load simultaneously in different panels), behavior is undefined. Use unique prefixed IDs like agents-tab-cmd-planner in kanban.html.
Porting message handlers: saveStartupCommandsResult (line ~2671), designDocConfig (line ~3025), julesAutoSyncSetting (line ~3085), defaultPromptOverrides, saveDefaultPromptOverridesResult, defaultPromptPreviews must all be added to kanban.html's window.addEventListener('message', ...) switch — kanban.html has its own separate message bus from implementation.html.
Full prompts system port: PROMPT_ROLES, lastPromptOverrides, lastPromptPreviews, editingPromptRole, renderPromptRoleTabs(), saveCurrentRoleDraft(), loadCurrentRoleIntoForm(), updatePromptOverrideSummary(), loadPreviewForCurrentRole(), openCustomPromptsModal() (adapted as inline, not modal) — all must be faithfully copied and adapted. Missing any one breaks the save/load cycle.
Requesting preview on tab open: When user clicks AGENTS tab, must call vscode.postMessage({ type: 'getDefaultPromptOverrides' }) and vscode.postMessage({ type: 'getDefaultPromptPreviews' }) to hydrate state — otherwise textareas are blank.
Removing implementation.html sections: Risk of accidentally removing too much or too little. Verify by ID, not just line number.
Edge-Case & Dependency Audit
Race Conditions: Both kanban.html and implementation.html can post saveStartupCommands simultaneously if both panels are open and a user changes a toggle. The backend must handle this idempotently (it already does — last-write-wins).
Security: No new attack surface. Webview messaging is already sandboxed.
Side Effects: Removing implementation.html agent config section means any external code that queries those DOM IDs (e.g. tests, other scripts) will fail silently. Confirm no test fixtures reference terminals-cmd-planner etc.
Dependencies & Conflicts: sess_1777020742591 (Restore Default Prompt Overrides Interactivity) is currently in CODER CODED and modifies implementation.html's terminals tab prompt modal. This plan supersedes that work — if that plan lands first, its changes get deleted by this plan's Step 5. Coordinate: either block this plan until that one is reviewed/reverted, or treat this plan as the canonical replacement and close the other.
Dependencies
IMPORTANT

Machine-readable. One dependency per line.

sess_1777020742591 — Restore Default Prompt Overrides Interactivity to Terminals Tab
Adversarial Synthesis
Grumpy Critique
"This plan is a copy-paste migration spec written by someone who has never read a message bus before. Let me count the ways this will explode:

ONE: Both webviews are alive at the same time. kanban.html and implementation.html both call vscode.postMessage({ type: 'saveStartupCommands' }). The backend doesn't know which one is authoritative. If I open the Kanban panel, tweak an agent, switch back to the sidebar — the sidebar's stale state fires saveStartupCommands on focus and silently overwrites my Kanban change. The plan says nothing about this.

TWO: The plan tells the implementer to 'port the JavaScript logic' for the prompts system — eight functions, three state variables, eight message handlers — with zero code. 'Port it' is not an implementation spec. The implementer will guess, get editingPromptRole state wrong, and ship a tab where switching roles corrupts the draft you were editing.

THREE: Steps 4 and 5 say 'remove lines ~1814–1910' and 'remove lines ~1975–2012'. Tilde ranges in a 5838-line file that's actively being edited? The implementer will either cut the wrong block or leave dangling DOM references for terminalsDefaultPromptOverrideSummary that now point to null, causing a silent JS crash every time saveDefaultPromptOverridesResult fires.

FOUR: There's a live plan (sess_1777020742591) actively working on the exact modal this plan deletes. No merge strategy is documented. One of these plans will land on top of the other and create a broken intermediate state.

FIVE: The plan says 'request previews when tab opens' in one line. But getDefaultPromptPreviews may not exist as a message type — setup.html requests them inside openCustomPromptsModal() via a different path. This needs to be verified against the backend."

Balanced Response
The Grumpy critique is substantially correct on three points:

Dual-write conflict: The fix is to make implementation.html stop owning saveStartupCommands once this plan lands — Step 4 already removes the autosave listeners from implementation.html, so this resolves itself as long as Steps 4 and 2 are executed atomically (not in two separate deploys).

Insufficient code spec: Steps 2 and 3 have been expanded below to include the exact state variables, function signatures, and message handler cases the implementer must write.

Line-number fragility: All removal steps now specify element IDs and comment anchors as the primary targeting mechanism, with approximate line numbers as hints only.

Cross-plan conflict: Documented in Dependencies above. This plan should be gated until sess_1777020742591 is resolved.

Preview message type: getDefaultPromptPreviews is verified in setup.html line 2342 — it is sent inside openCustomPromptsModal. The equivalent in kanban.html should send this when the AGENTS tab is first activated.

Proposed Changes
Component 1: kanban.html — Add AGENTS Tab
[MODIFY] src/webview/kanban.html
Context: Add tab button, tab content shell, ported CSS, ported JS.

Step 1.1 — Tab button (after line 624, inside .kanban-tab-bar):

html
<button class="kanban-tab-btn" data-tab="agents">AGENTS</button>
Step 1.2 — Tab content div (after </div> closing setup-tab-content, before <!-- Testing Fail Modal -->):

html
<!-- Agents Tab Content -->
<div id="agents-tab-content" class="kanban-tab-content">
  <div style="padding:12px; overflow-y:auto; height:100%;">
    <div style="font-size:11px; color:var(--accent-teal); margin-bottom:10px; font-family:var(--font-mono); letter-spacing:1px; font-weight:600;">
      AGENT CONFIGURATION
    </div>
    <!-- Agent Visibility & CLI Commands -->
    <div class="db-subsection">
      <div class="subsection-header"><span>Agent Visibility &amp; CLI Commands</span></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="planner" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Planner</label><input type="text" data-role="planner" id="agents-tab-cmd-planner" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="lead" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Lead Coder</label><input type="text" data-role="lead" id="agents-tab-cmd-lead" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="coder" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Coder</label><input type="text" data-role="coder" id="agents-tab-cmd-coder" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="intern" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Intern</label><input type="text" data-role="intern" id="agents-tab-cmd-intern" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="reviewer" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Reviewer</label><input type="text" data-role="reviewer" id="agents-tab-cmd-reviewer" placeholder="e.g. gemini --approval-mode auto_edit" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="tester" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Acceptance Tester</label><input type="text" data-role="tester" id="agents-tab-cmd-tester" placeholder="e.g. copilot --allow-all-tools" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="analyst" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Analyst</label><input type="text" data-role="analyst" id="agents-tab-cmd-analyst" placeholder="e.g. qwen" style="flex:1;"></div>
      <div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="jules" checked style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Jules</label><span style="flex:1;font-size:10px;color:var(--text-secondary);">Cloud coder visibility only</span></div>
      <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
        <input id="agents-tab-jules-auto-sync" type="checkbox" style="width:auto;margin:0;">
        <span>Auto-sync repo before sending to Jules</span>
      </label>
    </div>
    <!-- Prompt Controls -->
    <div class="db-subsection">
      <div class="subsection-header"><span>Prompt Controls</span></div>
      <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
        <input id="agents-tab-design-doc-toggle" type="checkbox" style="width:auto;margin:0;">
        <span>Append Design Doc to planner prompts</span>
      </label>
      <div id="agents-tab-design-doc-status" style="font-size:10px;color:var(--text-secondary);margin-top:4px;font-family:var(--font-mono);">Not configured</div>
      <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
        <input id="agents-tab-accurate-coding-toggle" type="checkbox" style="width:auto;margin:0;">
        <span>Accurate coding mode for Coder prompts</span>
      </label>
      <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
        <input id="agents-tab-lead-challenge-toggle" type="checkbox" style="width:auto;margin:0;">
        <span>Inline challenge step for Lead Coder prompts</span>
      </label>
      <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
        <input id="agents-tab-advanced-reviewer-toggle" type="checkbox" style="width:auto;margin:0;">
        <span>Advanced reviewer mode (deep regression analysis)</span>
      </label>
      <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
        <input id="agents-tab-aggressive-pair-toggle" type="checkbox" style="width:auto;margin:0;">
        <span>Aggressive pair programming (shift more tasks to Coder)</span>
      </label>
    </div>
    <!-- Default Prompt Overrides (inline, not modal) -->
    <div class="db-subsection">
      <div class="subsection-header"><span>Default Prompt Overrides</span></div>
      <div id="agents-tab-prompt-role-tabs" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;"></div>
      <details id="agents-tab-prompt-preview-details" style="margin-bottom:10px;">
        <summary style="font-size:10px;font-family:var(--font-mono);letter-spacing:1px;cursor:pointer;color:var(--text-secondary);user-select:none;">DEFAULT PROMPT PREVIEW (read only)</summary>
        <textarea id="agents-tab-prompt-preview-text" rows="6" readonly style="width:100%;font-family:var(--font-mono);font-size:10px;opacity:0.7;cursor:default;resize:vertical;background:#0a0a0a;color:var(--text-secondary);border:1px solid var(--border-color);border-radius:3px;padding:6px;" placeholder="Loading preview..."></textarea>
      </details>
      <label style="display:block;font-size:10px;font-family:var(--font-mono);color:var(--text-secondary);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Mode</label>
      <select id="agents-tab-prompt-mode" style="width:100%;background:#0a0a0a;color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:4px;font-size:11px;margin-bottom:8px;">
        <option value="append">Append — add after generated prompt</option>
        <option value="prepend">Prepend — insert before generated prompt</option>
        <option value="replace">Replace — replace prompt body</option>
      </select>
      <label style="display:block;font-size:10px;font-family:var(--font-mono);color:var(--text-secondary);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Custom instructions</label>
      <textarea id="agents-tab-prompt-text" rows="6" placeholder="Enter custom instructions for this role..." style="width:100%;background:#0a0a0a;color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:6px;font-size:11px;resize:vertical;margin-bottom:8px;"></textarea>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">
        <button id="agents-tab-btn-clear-override" style="font-family:var(--font-mono);font-size:10px;padding:3px 8px;background:transparent;border:1px solid var(--border-color);color:var(--text-secondary);cursor:pointer;border-radius:2px;">CLEAR OVERRIDE</button>
        <span style="flex:1;"></span>
      </div>
      <div id="agents-tab-prompt-override-summary" style="font-size:10px;color:var(--text-secondary);font-family:var(--font-mono);min-height:14px;margin-bottom:6px;"></div>
      <button id="agents-tab-btn-save-overrides" style="width:100%;font-family:var(--font-mono);font-size:10px;letter-spacing:1px;padding:6px;background:color-mix(in srgb, var(--accent-teal) 10%, transparent);border:1px solid var(--accent-teal-dim);color:var(--accent-teal);cursor:pointer;border-radius:2px;">SAVE ALL OVERRIDES</button>
    </div>
  </div>
</div>
Step 1.3 — CSS (add to <style> block in kanban.html):

css
/* AGENTS tab shared styles */
.subsection-header {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-mono); font-size: 10px; font-weight: 600;
  color: var(--text-secondary); text-transform: uppercase;
  letter-spacing: 1px; margin-bottom: 8px;
}
.db-subsection {
  border-top: 1px solid var(--border-color);
  padding: 10px 0;
}
.startup-row {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 6px; font-size: 11px;
}
.startup-row input[type="text"] {
  background: #0a0a0a; color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 3px;
  padding: 3px 6px; font-size: 10px; font-family: var(--font-mono);
}
/* Role tab pills */
.agents-prompt-role-tab {
  font-family: var(--font-mono); font-size: 10px; padding: 3px 8px;
  border: 1px solid var(--border-color); border-radius: 3px;
  background: transparent; color: var(--text-secondary);
  cursor: pointer; transition: all 0.15s;
}
.agents-prompt-role-tab.active {
  border-color: var(--accent-teal-dim); color: var(--accent-teal);
  background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
}
.agents-prompt-role-tab.has-override::after { content: ' ●'; color: var(--accent-teal); }
Step 1.4 — JavaScript (add to kanban.html <script> block, after existing icon constants):

js
// ── AGENTS TAB STATE ─────────────────────────────────────────
const AGENTS_TAB_PROMPT_ROLES = [
    { key: 'planner', label: 'Planner' },
    { key: 'lead', label: 'Lead Coder' },
    { key: 'coder', label: 'Coder' },
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'tester', label: 'Acceptance Tester' },
    { key: 'intern', label: 'Intern' },
    { key: 'analyst', label: 'Analyst' },
    { key: 'team-lead', label: 'Team Lead' },
];
let agentsTabPromptOverrides = {};
let agentsTabPromptPreviews = {};
let agentsTabEditingRole = 'planner';
let agentsTabStartupCommands = {};
let agentsTabVisibleAgents = {};
function agentsTabSaveCurrentRoleDraft() {
    const mode = document.getElementById('agents-tab-prompt-mode')?.value || 'append';
    const text = document.getElementById('agents-tab-prompt-text')?.value.trim() || '';
    if (text) {
        agentsTabPromptOverrides[agentsTabEditingRole] = { mode, text };
    } else {
        delete agentsTabPromptOverrides[agentsTabEditingRole];
    }
}
function agentsTabLoadRoleIntoForm() {
    const o = agentsTabPromptOverrides[agentsTabEditingRole];
    const modeEl = document.getElementById('agents-tab-prompt-mode');
    const textEl = document.getElementById('agents-tab-prompt-text');
    if (modeEl) modeEl.value = o?.mode || 'append';
    if (textEl) textEl.value = o?.text || '';
}
function agentsTabUpdateSummary() {
    const count = Object.values(agentsTabPromptOverrides).filter(o => o?.text).length;
    const el = document.getElementById('agents-tab-prompt-override-summary');
    if (el) el.textContent = count ? `${count} role(s) customized` : 'No overrides configured';
}
function agentsTabLoadPreview() {
    const el = document.getElementById('agents-tab-prompt-preview-text');
    if (el) el.value = agentsTabPromptPreviews[agentsTabEditingRole] || 'Loading preview...';
}
function agentsTabRenderRoleTabs() {
    const container = document.getElementById('agents-tab-prompt-role-tabs');
    if (!container) return;
    container.innerHTML = '';
    AGENTS_TAB_PROMPT_ROLES.forEach(({ key, label }) => {
        const btn = document.createElement('button');
        btn.className = 'agents-prompt-role-tab' +
            (key === agentsTabEditingRole ? ' active' : '') +
            (agentsTabPromptOverrides[key]?.text ? ' has-override' : '');
        btn.textContent = label;
        btn.addEventListener('click', () => {
            agentsTabSaveCurrentRoleDraft();
            agentsTabEditingRole = key;
            agentsTabLoadRoleIntoForm();
            agentsTabLoadPreview();
            agentsTabRenderRoleTabs();
        });
        container.appendChild(btn);
    });
}
function agentsTabCollectConfig() {
    const commands = {};
    const visibleAgents = {};
    document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
        if (i.dataset.role) commands[i.dataset.role] = i.value.trim();
    });
    document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
        if (cb.dataset.role) visibleAgents[cb.dataset.role] = cb.checked;
    });
    return {
        commands,
        visibleAgents,
        accurateCodingEnabled: document.getElementById('agents-tab-accurate-coding-toggle')?.checked ?? false,
        advancedReviewerEnabled: document.getElementById('agents-tab-advanced-reviewer-toggle')?.checked ?? false,
        leadChallengeEnabled: document.getElementById('agents-tab-lead-challenge-toggle')?.checked ?? false,
        aggressivePairProgramming: document.getElementById('agents-tab-aggressive-pair-toggle')?.checked ?? false,
        designDocEnabled: document.getElementById('agents-tab-design-doc-toggle')?.checked ?? false,
        julesAutoSyncEnabled: document.getElementById('agents-tab-jules-auto-sync')?.checked ?? false,
    };
}
function agentsTabSaveConfig() {
    vscode.postMessage({ type: 'saveStartupCommands', ...agentsTabCollectConfig() });
}
// Autosave listeners
document.querySelectorAll('#agents-tab-content input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', agentsTabSaveConfig);
});
document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
    i.addEventListener('blur', agentsTabSaveConfig);
});
// Save overrides button
document.getElementById('agents-tab-btn-save-overrides')?.addEventListener('click', () => {
    agentsTabSaveCurrentRoleDraft();
    vscode.postMessage({ type: 'saveDefaultPromptOverrides', overrides: agentsTabPromptOverrides });
    agentsTabUpdateSummary();
    agentsTabRenderRoleTabs();
});
// Clear override button
document.getElementById('agents-tab-btn-clear-override')?.addEventListener('click', () => {
    delete agentsTabPromptOverrides[agentsTabEditingRole];
    agentsTabLoadRoleIntoForm();
    agentsTabRenderRoleTabs();
    agentsTabUpdateSummary();
});
// Hydrate when AGENTS tab is activated
kanbanTabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'agents') {
            vscode.postMessage({ type: 'getDefaultPromptOverrides' });
            vscode.postMessage({ type: 'getDefaultPromptPreviews' });
        }
    });
});
Step 1.5 — Message handlers (add to kanban.html's window.addEventListener('message', ...) switch):

js
case 'startupCommands': {
    // Hydrate agent visibility toggles and CLI inputs
    const cmds = message.commands || {};
    const vis = message.visibleAgents || {};
    document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
        if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
    });
    document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
        if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
    });
    const at = document.getElementById('agents-tab-accurate-coding-toggle');
    if (at) at.checked = !!message.accurateCodingEnabled;
    const avr = document.getElementById('agents-tab-advanced-reviewer-toggle');
    if (avr) avr.checked = !!message.advancedReviewerEnabled;
    const lc = document.getElementById('agents-tab-lead-challenge-toggle');
    if (lc) lc.checked = !!message.leadChallengeEnabled;
    const ap = document.getElementById('agents-tab-aggressive-pair-toggle');
    if (ap) ap.checked = !!message.aggressivePairProgramming;
    const dd = document.getElementById('agents-tab-design-doc-toggle');
    if (dd) dd.checked = !!message.designDocEnabled;
    const jas = document.getElementById('agents-tab-jules-auto-sync');
    if (jas) jas.checked = !!message.julesAutoSyncEnabled;
    break;
}
case 'julesAutoSyncSetting': {
    const el = document.getElementById('agents-tab-jules-auto-sync');
    if (el) el.checked = message.enabled === true;
    break;
}
case 'designDocConfig': {
    const statusEl = document.getElementById('agents-tab-design-doc-status');
    if (statusEl) statusEl.textContent = message.url
        ? `Source: ${message.url.length > 60 ? message.url.slice(0, 57) + '...' : message.url}`
        : 'Not configured — configure in Planning tab';
    break;
}
case 'defaultPromptOverrides': {
    agentsTabPromptOverrides = message.overrides || {};
    agentsTabEditingRole = AGENTS_TAB_PROMPT_ROLES[0].key;
    agentsTabLoadRoleIntoForm();
    agentsTabRenderRoleTabs();
    agentsTabUpdateSummary();
    break;
}
case 'defaultPromptPreviews': {
    agentsTabPromptPreviews = message.previews || {};
    agentsTabLoadPreview();
    break;
}
case 'saveDefaultPromptOverridesResult': {
    if (message.success) agentsTabUpdateSummary();
    break;
}
case 'saveStartupCommandsResult': {
    // No-op — autosave is fire-and-forget in kanban context
    break;
}
Component 2: implementation.html — Remove Migrated Sections
[MODIFY] src/webview/implementation.html
Step 2.1 — Remove Agent Configuration HTML block

Target: comment <!-- Agent Configuration Section (migrated from setup.html) --> (line ~1814) through closing </div> of .terminals-agent-config (line ~1926)
Verify by searching for id="terminals-btn-customize-default-prompts" — remove the entire containing .terminals-agent-config div
Step 2.2 — Remove broken Default Prompt Overrides modal HTML

Target: <div id="default-prompt-overrides-modal" (line ~1975) through its closing </div> (line ~2012)
Verify by searching for id="default-prompt-overrides-modal"
Step 2.3 — Remove DOM element references

Remove lines ~2048–2068: the block starting with // Terminals Tab Agent Configuration Elements through let currentPromptOverrides = {};
Specifically remove: terminalsAccurateCodingToggle, terminalsAdvancedReviewerToggle, terminalsLeadChallengeToggle, terminalsAggressivePairToggle, terminalsDesignDocToggle, terminalsDesignDocStatusLine, terminalsJulesAutoSyncToggle, terminalsDefaultPromptOverrideSummary, terminalsCustomizeDefaultPromptsBtn, defaultPromptOverridesModal, overridePlannerTextarea…overrideInternTextarea, btnSaveDefaultPrompts, btnCancelDefaultPrompts, currentPromptOverrides
Step 2.4 — Remove autosave event listeners and functions

Remove collectTerminalsAgentConfig() function (lines ~3311–3339)
Remove saveTerminalsAgentConfig() function (lines ~3341–3344)
Remove autosave event listener blocks (lines ~3346–3353)
Remove
Step 2.4 (continued) — Remove from implementation.html:

collectTerminalsAgentConfig() + saveTerminalsAgentConfig() functions (~lines 3311–3344)
Autosave event listener blocks for #agent-list-terminals checkboxes and text inputs (~lines 3346–3353)
terminalsCustomizeDefaultPromptsBtn click handler (~lines 3355–3362)
populateDefaultPromptOverridesModal(), collectDefaultPromptOverrides(), buildOverridesSummary() functions (~lines 3364–3391)
btnSaveDefaultPrompts and btnCancelDefaultPrompts click handlers + backdrop handler (~lines 3393–3421)
Step 2.5 — Remove message handlers from implementation.html:

case 'defaultPromptOverrides': block (~lines 3060–3071)
case 'saveDefaultPromptOverridesResult': block (~lines 3072–3078)
case 'julesAutoSyncSetting': block (~lines 3085–3091)
Step 2.6 — Remove .subsection-header CSS from implementation.html (~lines 1643–1655) only if nothing else in the file references that class. Grep first: grep -n "subsection-header" src/webview/implementation.html

Verification Plan
Automated Tests
grep -n "terminals-cmd-planner\|terminalsAccurateCoding\|default-prompt-overrides-modal" src/webview/implementation.html → should return 0 results after removal
grep -n "agents-tab-" src/webview/kanban.html → should return all ported IDs
Manual Verification
Open Kanban panel → AGENTS tab appears in tab bar
Toggle an agent visibility → reload panel → toggle state persists
Change a CLI command → blur field → reload → command persists
Switch prompt roles → configure text → Save All Overrides → reopen tab → overrides still shown with ● indicator
Open implementation.html terminals sidebar → no agent config section visible, no JS console errors
setup.html opens cleanly and its own prompts modal still works
Agent recommendation: Complexity 7 → Send to Lead Coder

Cross-plan conflict: Block until sess_1777020742591 (Restore Default Prompt Overrides Interactivity) is resolved — that plan modifies the exact modal this plan deletes.