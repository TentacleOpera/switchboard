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
    gatherer: false,
    ticket_updater: false,
    researcher: false,
    splitter: false,
    code_researcher: false,
    mcp_monitor: false,
    claude_designer: false,
    orchestrator: false
};

// CRITICAL: DO NOT CHANGE DEFAULTS UNLESS SPECIFICALLY ASKED
const DEFAULT_ROLE_CONFIG = {
    planner: {
        workflowFilePath: '.agents/workflows/improve-plan.md',
        addons: { switchboardSafeguards: true, designDoc: false, constitution: false, aggressivePairProgramming: false, gitProhibition: false, clearAntigravityContext: false, cavemanOutput: true, adviseResearch: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: true }
    },
    lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, reviewerConciseMode: false, reviewerCompactPlanUpdate: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    tester: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    analyst: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    ticket_updater: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, ticketUpdateMode: 'disabled', clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, researchEnabled: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    splitter: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, complexityScoringSkill: false, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    code_researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    gatherer: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    orchestrator: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'useSubagents', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '', ultracode: false } },
    claude_designer: { prompt: 'Import a design from claude.ai/design into the target folder, writing the implementation into the designated workspace folder, built with the repo\'s existing components and styles.', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } }
};

// Role key/label pairs for UI rendering
const BUILT_IN_AGENT_LABELS = [
    { key: 'gatherer', label: 'Context Gatherer' },
    { key: 'planner', label: 'Planner' },
    { key: 'code_researcher', label: 'Code Researcher' },
    { key: 'splitter', label: 'Splitter Agent' },
    { key: 'lead', label: 'Lead Coder' },
    { key: 'coder', label: 'Coder' },
    { key: 'intern', label: 'Intern' },
    { key: 'reviewer', label: 'Reviewer' },
    { key: 'tester', label: 'Acceptance Tester' },
    { key: 'analyst', label: 'Analyst' },
    { key: 'ticket_updater', label: 'Ticket Updater' },
    { key: 'researcher', label: 'Researcher' },
    { key: 'orchestrator', label: 'Orchestrator' },
    { key: 'claude_designer', label: 'Claude Designer' },
    { key: 'jules', label: 'Jules' },
    { key: 'mcp_monitor', label: 'MCP Monitor' }
];

// Derivable helper
const ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG);

// Specialized roles that operate via skills/addons, not prompt overrides.
// Used by setup.html to filter the prompt customization UI.
const PROMPT_OVERRIDE_EXCLUDED_KEYS = new Set(['ticket_updater', 'splitter', 'code_researcher']);

// Role addon UI metadata (moved from kanban.html)
const ROLE_ADDONS = {
    planner: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'designDoc', label: 'Planning Epic Reference (legacy)', tooltip: 'Legacy planner-only doc — superseded by per-project PRDs (Projects tab + PROJECT CONTEXT toggle). Kept for back-compat.', default: false },
        { id: 'constitution', label: 'Project Constitution Reference', tooltip: 'Include project constitution as context for planning', default: false },
        { id: 'designSystemDoc', label: 'Design Doc Reference', tooltip: 'Include design system doc as context', default: false },
        { id: 'aggressivePairProgramming', label: 'Aggressive Pair Programming', tooltip: 'Assume Coder can handle more independently', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    lead: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Coder handles Routine tasks concurrently', default: false },
        { id: 'leadChallenge', label: 'Inline Challenge Step', tooltip: 'Internal review before code generation', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    coder: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    reviewer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'advancedRegression', label: 'Advanced Regression Analysis', tooltip: 'Trace all callers of modified functions', default: false },
        { id: 'reviewerConciseMode', label: 'Concise Review Mode', tooltip: 'Keep theatrical intros but compress findings to terse bullets; allow the agent to summarise trivial fixes', default: false },
        { id: 'reviewerCompactPlanUpdate', label: 'Compact Plan Update', tooltip: 'Append a brief summary to the plan file instead of reproducing full sections', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    tester: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    intern: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    analyst: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    ticket_updater: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'researchEnabled', label: 'Enable Deep Research', tooltip: 'Enable deep research mode (50-100 sources, codebase + web)', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    splitter: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'complexityScoringSkill', label: 'Complexity Scoring', tooltip: 'Invoke complexity scoring before split', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    code_researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    gatherer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    claude_designer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
    ],
    orchestrator: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents to handle each epic subtask concurrently' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'useSubagents' },
        { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each subtask in an isolated git worktree', default: false },
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false },
        { id: 'ultracode', label: 'Ultracode', tooltip: 'Append the "use ultracode" directive so a Claude Code host orchestrates the epic with multi-agent workflows', default: false }
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
