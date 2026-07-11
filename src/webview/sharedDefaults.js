// CRITICAL: DO NOT CHANGE DEFAULTS UNLESS SPECIFICALLY ASKED
const DEFAULT_VISIBLE_AGENTS = {
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
    claude_designer: false,
    phone_a_friend: false,
    project_manager: true
};

// CRITICAL: DO NOT CHANGE DEFAULTS UNLESS SPECIFICALLY ASKED
const DEFAULT_ROLE_CONFIG = {
    planner: {
        workflowFilePath: '.agents/skills/improve-plan/SKILL.md',
        addons: { switchboardSafeguards: true, constitution: false, aggressivePairProgramming: false, gitProhibition: false, clearAntigravityContext: false, cavemanOutput: true, adviseResearch: true, writeFeatureDescriptionIfEmpty: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: true }
    },
    lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, gitBranchStrategy: 'notSpecified', gitCommitStrategy: 'notSpecified', gitPushStrategy: 'notSpecified', phoneAFriend: false, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, gitBranchStrategy: 'notSpecified', gitCommitStrategy: 'notSpecified', gitPushStrategy: 'notSpecified', phoneAFriend: false, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, reviewerConciseMode: false, reviewerCompactPlanUpdate: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    tester: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, gitBranchStrategy: 'notSpecified', gitCommitStrategy: 'notSpecified', gitPushStrategy: 'notSpecified', phoneAFriend: false, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    analyst: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    ticket_updater: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, ticketUpdateMode: 'disabled', clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, researchEnabled: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    claude_designer: { prompt: 'Import a design from claude.ai/design into the target folder, writing the implementation into the designated workspace folder, built with the repo\'s existing components and styles.', addons: { switchboardSafeguards: true, gitProhibition: true, gitBranchStrategy: 'notSpecified', gitCommitStrategy: 'notSpecified', gitPushStrategy: 'notSpecified', clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    phone_a_friend: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    project_manager: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } }
};

// Role key/label pairs for UI rendering
const BUILT_IN_AGENT_LABELS = [
    { key: 'planner', label: 'Planner' },
    { key: 'lead', label: 'Lead Coder' },
    { key: 'coder', label: 'Coder' },
    { key: 'intern', label: 'Intern' },
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'tester', label: 'Acceptance Tester' },
    { key: 'analyst', label: 'Analyst' },
    { key: 'ticket_updater', label: 'Ticket Updater' },
    { key: 'researcher', label: 'Researcher' },
    { key: 'claude_designer', label: 'Claude Designer' },
    { key: 'jules', label: 'Jules' },
    { key: 'mcp_monitor', label: 'Comms Monitor' },
    { key: 'phone_a_friend', label: 'Phone-a-Friend' },
    { key: 'project_manager', label: 'Project Manager' }
];

// Derivable helper
const ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG);

// Specialized roles that operate via skills/addons, not prompt overrides.
// Used by setup.html to filter the prompt customization UI.
const PROMPT_OVERRIDE_EXCLUDED_KEYS = new Set(['ticket_updater']);

// Shared git-policy radio groups (Branch / Commit / Push). Attached to the
// four code-writing roles inside ROLE_ADDONS; the guardrail checkbox stays
// independent. No worktree option — feature-worktree isolation stays at
// feature granularity (see plan: expand-git-policy-granular-...).
const GIT_BRANCH_STRATEGY_RADIO = {
    id: 'gitBranchStrategy', label: 'Git Branch Strategy', tooltip: 'Prescriptive branch directive emitted in the GIT POLICY block', type: 'radio', default: 'notSpecified', group: 'git', options: [
        { value: 'current', label: 'Current Branch', tooltip: 'Do all work on the current branch; do NOT create new branches or worktrees' },
        { value: 'newBranch', label: 'New Branch', tooltip: 'Create ONE descriptively-named branch for this task and do all work on it' },
        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no branch clause' }
    ]
};
const GIT_COMMIT_STRATEGY_RADIO = {
    id: 'gitCommitStrategy', label: 'Git Commit Strategy', tooltip: 'Prescriptive commit directive emitted in the GIT POLICY block', type: 'radio', default: 'notSpecified', group: 'git', options: [
        { value: 'whenDone', label: 'Commit When Done', tooltip: 'Stage all changes and create a single descriptive commit when the task is finished' },
        { value: 'dontCommit', label: 'Do Not Commit', tooltip: 'Leave all changes in the working tree for the user to review' },
        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no commit clause' }
    ]
};
const GIT_PUSH_STRATEGY_RADIO = {
    id: 'gitPushStrategy', label: 'Git Push Strategy', tooltip: 'Prescriptive push directive emitted in the GIT POLICY block', type: 'radio', default: 'notSpecified', group: 'git', options: [
        { value: 'noPush', label: 'Do Not Push', tooltip: 'Do NOT push to any remote' },
        { value: 'pushWhenDone', label: 'Push When Done', tooltip: 'After committing, push the working branch to its remote. Do not force-push.' },
        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no push clause' }
    ]
};

const SUBAGENT_POLICY_RADIO = {
    id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning',
    type: 'radio', group: 'subagent', default: 'default', options: [
        { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
        { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
        { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
        { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
    ]
};

// Role addon UI metadata (moved from kanban.html)
const ROLE_ADDONS = {
    planner: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },

        { id: 'constitution', label: 'Project Constitution Reference', tooltip: 'Include project constitution as context for planning', default: false },
        { id: 'designSystemDoc', label: 'Project PRD Reference', tooltip: 'Include project PRD as context for planning', default: false },
        { id: 'aggressivePairProgramming', label: 'Aggressive Pair Programming', tooltip: 'Assume Coder can handle more independently', default: false },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'writeFeatureDescriptionIfEmpty', label: 'Write Feature Description If Empty', tooltip: 'Backfill Goal, How the Subtasks Achieve This, and Dependencies & sequencing sections in feature files when missing', default: true },
        SUBAGENT_POLICY_RADIO
    ],
    lead: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Coder handles Routine tasks concurrently', default: false },
        { id: 'leadChallenge', label: 'Inline Challenge Step', tooltip: 'Internal review before code generation', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        GIT_BRANCH_STRATEGY_RADIO,
        GIT_COMMIT_STRATEGY_RADIO,
        GIT_PUSH_STRATEGY_RADIO,
        { id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'When done coding the batch, notify the Phone-a-Friend terminal to do a second pass (requires Phone-a-Friend agent configured)', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'staggeredImplementation', label: 'Staggered Implementation', group: 'features', tooltip: 'After completing each subtask, append a brief summary to the feature file\'s ## Implementation Notes section so the next subtask has context from prior work', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        SUBAGENT_POLICY_RADIO,
        { id: 'useWorktreesPerPlan', label: 'Agent-Managed Worktrees (plans + feature subtasks)', tooltip: 'Opt into agent-managed orchestration: the agent uses its native subagent/orchestration capabilities to process each plan (and, for a feature dispatch, each subtask) in an isolated git worktree, then reviews and merges. Off = the agent implements plans/subtasks directly — no worktrees, no subagents.', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    coder: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        GIT_BRANCH_STRATEGY_RADIO,
        GIT_COMMIT_STRATEGY_RADIO,
        GIT_PUSH_STRATEGY_RADIO,
        { id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'When done coding the batch, notify the Phone-a-Friend terminal to do a second pass (requires Phone-a-Friend agent configured)', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'staggeredImplementation', label: 'Staggered Implementation', group: 'features', tooltip: 'After completing each subtask, append a brief summary to the feature file\'s ## Implementation Notes section so the next subtask has context from prior work', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        SUBAGENT_POLICY_RADIO,
        { id: 'useWorktreesPerPlan', label: 'Agent-Managed Worktrees (plans + feature subtasks)', tooltip: 'Opt into agent-managed orchestration: the agent uses its native subagent/orchestration capabilities to process each plan (and, for a feature dispatch, each subtask) in an isolated git worktree, then reviews and merges. Off = the agent implements plans/subtasks directly — no worktrees, no subagents.', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    reviewer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'advancedRegression', label: 'Advanced Regression Analysis', tooltip: 'Trace all callers of modified functions', default: false },
        { id: 'reviewerConciseMode', label: 'Concise Review Mode', tooltip: 'Keep theatrical intros but compress findings to terse bullets; allow the agent to summarise trivial fixes', default: false },
        { id: 'reviewerCompactPlanUpdate', label: 'Compact Plan Update', tooltip: 'Append a brief summary to the plan file instead of reproducing full sections', default: false },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        SUBAGENT_POLICY_RADIO,
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    tester: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        SUBAGENT_POLICY_RADIO,
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    intern: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        GIT_BRANCH_STRATEGY_RADIO,
        GIT_COMMIT_STRATEGY_RADIO,
        GIT_PUSH_STRATEGY_RADIO,
        { id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'When done coding the batch, notify the Phone-a-Friend terminal to do a second pass (requires Phone-a-Friend agent configured)', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'staggeredImplementation', label: 'Staggered Implementation', group: 'features', tooltip: 'After completing each subtask, append a brief summary to the feature file\'s ## Implementation Notes section so the next subtask has context from prior work', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        SUBAGENT_POLICY_RADIO,
        { id: 'useWorktreesPerPlan', label: 'Agent-Managed Worktrees (plans + feature subtasks)', tooltip: 'Opt into agent-managed orchestration: the agent uses its native subagent/orchestration capabilities to process each plan (and, for a feature dispatch, each subtask) in an isolated git worktree, then reviews and merges. Off = the agent implements plans/subtasks directly — no worktrees, no subagents.', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    analyst: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        SUBAGENT_POLICY_RADIO,
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    ticket_updater: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        SUBAGENT_POLICY_RADIO,
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'researchEnabled', label: 'Enable Deep Research', tooltip: 'Enable deep research mode (50-100 sources, codebase + web)', default: true },
        SUBAGENT_POLICY_RADIO,
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    claude_designer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        GIT_BRANCH_STRATEGY_RADIO,
        GIT_COMMIT_STRATEGY_RADIO,
        GIT_PUSH_STRATEGY_RADIO,
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        SUBAGENT_POLICY_RADIO,
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ]
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_VISIBLE_AGENTS, DEFAULT_ROLE_CONFIG, BUILT_IN_AGENT_LABELS, ROLE_KEYS, PROMPT_OVERRIDE_EXCLUDED_KEYS, ROLE_ADDONS };
}

// Shared click-flash feedback: gives every button a brief press pulse on click so actions
// don't fire silently. Self-contained (injects its own CSS); loaded in every panel via the
// shared scripts. Guarded so it only initialises once per webview.
(function initSbClickFlash() {
    if (typeof document === 'undefined' || window.__sbClickFlashInit) { return; }
    window.__sbClickFlashInit = true;

    const style = document.createElement('style');
    style.textContent =
        '@keyframes sbClickFlash{0%{transform:scale(1)}38%{transform:scale(0.94)}100%{transform:scale(1)}}' +
        '.sb-click-flash{animation:sbClickFlash 0.18s ease-out}';
    // Insert FIRST so any panel-specific click animation (e.g. kanban's richer flash)
    // wins the cascade on conflict, while this still applies everywhere else.
    const head = document.head || document.documentElement;
    head.insertBefore(style, head.firstChild);

    document.addEventListener('click', e => {
        const btn = e.target.closest && e.target.closest('button, [role="button"], [class*="btn"]');
        if (!btn || btn.disabled) { return; }
        btn.classList.remove('sb-click-flash');
        void btn.offsetWidth; // restart the animation if clicked again mid-play
        btn.classList.add('sb-click-flash');
        btn.addEventListener('animationend', () => btn.classList.remove('sb-click-flash'), { once: true });
    }, true);
})();
