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
    code_researcher: false
};

const DEFAULT_ROLE_CONFIG = {
    planner: {
        workflowFilePath: '.agent/workflows/improve-plan.md',
        addons: { switchboardSafeguards: true, dependencyCheck: false, designDoc: false, aggressivePairProgramming: false, gitProhibition: false, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '' }
    },
    lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', includeDependencyInstructions: false } },
    coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', includeDependencyInstructions: false } },
    reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '' } },
    tester: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '' } },
    intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', includeDependencyInstructions: false } },
    analyst: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '' } },
    ticket_updater: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, ticketUpdateMode: 'disabled', clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '' } },
    researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, researchEnabled: true, subagentPolicy: 'default', customSubagentName: '' } },
    splitter: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, complexityScoringSkill: false, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '' } },
    code_researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '' } },
    gatherer: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false } }
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
    { key: 'jules', label: 'Jules' }
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
        { id: 'dependencyCheck', label: 'Dependency Check', tooltip: 'Query Kanban for cross-plan dependencies', default: false },
        { id: 'designDoc', label: 'Design Doc Reference', tooltip: 'Include design doc as planning context', default: false },
        { id: 'aggressivePairProgramming', label: 'Aggressive Pair Programming', tooltip: 'Assume Coder can handle more independently', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
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
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'includeDependencyInstructions', label: 'Include Dependency Instructions', tooltip: 'Include DEPENDENCY ORDER section in prompts when plans have dependencies. Disable only if you are certain plans have no dependencies.', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    coder: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'includeDependencyInstructions', label: 'Include Dependency Instructions', tooltip: 'Include DEPENDENCY ORDER section in prompts when plans have dependencies. Disable only if you are certain plans have no dependencies.', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    reviewer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'advancedRegression', label: 'Advanced Regression Analysis', tooltip: 'Trace all callers of modified functions', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    tester: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    intern: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: true },
        { id: 'suppressWalkthrough', label: 'Suppress Walkthrough Artifact', tooltip: 'Do not generate walkthrough.md at task completion', default: false },
        { id: 'skipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
        { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
        { id: 'includeDependencyInstructions', label: 'Include Dependency Instructions', tooltip: 'Include DEPENDENCY ORDER section in prompts when plans have dependencies. Disable only if you are certain plans have no dependencies.', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    analyst: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    ticket_updater: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'ticketUpdateMode', label: 'Ticket Update Mode', tooltip: 'Select how the agent should update the external ticket', type: 'radio', options: [
            { value: 'disabled', label: 'Disabled', tooltip: 'No ticket update' },
            { value: 'comment-only', label: 'Comment Only', tooltip: 'Add AI analysis as a comment to the ticket' },
            { value: 'refine-ticket', label: 'Refine Ticket', tooltip: 'Refine the ticket description based on plan analysis' },
            { value: 'research-and-refine', label: 'Research & Refine', tooltip: 'Research first, then refine the ticket with findings' }
        ], default: 'disabled' },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'researchEnabled', label: 'Enable Deep Research', tooltip: 'Enable deep research mode (50-100 sources, codebase + web)', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    splitter: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'complexityScoringSkill', label: 'Complexity Scoring', tooltip: 'Invoke complexity scoring before split', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    code_researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Default', tooltip: 'Use platform default subagent behavior (sequential processing)' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
        ], default: 'default' }
    ],
    gatherer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false }
    ]
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_VISIBLE_AGENTS, DEFAULT_ROLE_CONFIG, BUILT_IN_AGENT_LABELS, ROLE_KEYS, PROMPT_OVERRIDE_EXCLUDED_KEYS, ROLE_ADDONS };
}
