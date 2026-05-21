const DEFAULT_VISIBLE_AGENTS = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    jules: true,
    gatherer: true,
    ticket_updater: false,
    researcher: false,
    splitter: false,
    research_planner: false
};

const DEFAULT_ROLE_CONFIG = {
    planner: {
        workflowFilePath: '.agent/workflows/improve-plan.md',
        addons: { switchboardSafeguards: true, dependencyCheck: false, designDoc: false, aggressivePairProgramming: false, gitProhibition: false, splitPlan: false, clearAntigravityContext: false }
    },
    lead: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false } },
    coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false } },
    reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, gitProhibition: true, clearAntigravityContext: false } },
    tester: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false } },
    intern: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false } },
    analyst: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false } },
    ticket_updater: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, ticketUpdateEnabled: false, clearAntigravityContext: false } },
    researcher: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, researchEnabled: false, clearAntigravityContext: false } },
    splitter: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, complexityScoringSkill: false, clearAntigravityContext: false } },
    research_planner: { prompt: '', enableDeepPlanning: false, researchDepth: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false } }
};

// Role key/label pairs for UI rendering
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

// Derivable helper
const ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG);

// Specialized roles that operate via skills/addons, not prompt overrides.
// Used by setup.html to filter the prompt customization UI.
const PROMPT_OVERRIDE_EXCLUDED_KEYS = new Set(['ticket_updater', 'researcher', 'splitter', 'research_planner']);

// Role addon UI metadata (moved from kanban.html)
const ROLE_ADDONS = {
    planner: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'dependencyCheck', label: 'Dependency Check', tooltip: 'Query Kanban for cross-plan dependencies', default: false },
        { id: 'designDoc', label: 'Design Doc Reference', tooltip: 'Include design doc as planning context', default: false },
        { id: 'aggressivePairProgramming', label: 'Aggressive Pair Programming', tooltip: 'Assume Coder can handle more independently', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: false },
        { id: 'splitPlan', label: 'Split Plan', tooltip: 'Produce separate Routine and Complex plan files', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    lead: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Coder handles Routine tasks concurrently', default: false },
        { id: 'leadChallenge', label: 'Inline Challenge Step', tooltip: 'Internal review before code generation', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    coder: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'pairProgramming', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
        { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    reviewer: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'advancedRegression', label: 'Advanced Regression Analysis', tooltip: 'Trace all callers of modified functions', default: false },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    tester: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    intern: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    analyst: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    ticket_updater: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'ticketUpdateEnabled', label: 'Ticket Update', tooltip: 'Update associated ticket with AI analysis', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'researchEnabled', label: 'Deep Research', tooltip: 'Enable deep research mode', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    splitter: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'complexityScoringSkill', label: 'Complexity Scoring', tooltip: 'Invoke complexity scoring before split', default: false },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ],
    research_planner: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false }
    ]
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_VISIBLE_AGENTS, DEFAULT_ROLE_CONFIG, BUILT_IN_AGENT_LABELS, ROLE_KEYS, PROMPT_OVERRIDE_EXCLUDED_KEYS, ROLE_ADDONS };
}
