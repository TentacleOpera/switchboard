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
    claude_designer: falseddons: { switchboardSafeguards: true, pairProgramming: false, leadChallenge: false, accurateCoding: false, gitProhibition: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    coder: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', clearAntigravityContelkthrough: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    reviewer: { prompt: '', addons: { switchboardSafeguards: true, advancedRegression: false, reviewerConciseMode: false, reviewerCompactPlanUpdate: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutption: true, skipTestsy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
    tester: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: fals'' } },
    intern: { prompt: '', addons: { switchboardSafeguards: true, pairProgramming: false, accurateCoding: false, gitProhibition: true, clearAntigravityContext: false, suppressWalkthrough: false, cavemanOutput: true, skipCoTests: true, subagentstomSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '' } },
    analyst: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: fal
    ticket_updater: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, ticketUpdateMode: 'disabled', clearAntigravityContext: false, cavemanOutput: false, subagentPolicy: 'default', customSubagentNorkflowFilePath: '' }
    researcher: { prompt: '', researchComplexity: 'deep', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, researchEnabled: true, subagentPolicy: 'default', customSubagentName:EowFilePath: '' } },
    claude_designer: { prompt: 'Import a design from claude.ai/design into the target folder, writing the implementation into the designated workspace folder, built with the repo\'s existing components and styles.', addonbition: true, clearalse, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } }
};
/ Role key/label pairs for UI rendering
    { key: 'planner', label: 'Planner' },
    { key: 'coder', label: 'Coder' },
   { key: 'reviewer', label: 'Reviewer' },
   { key: 'analyst', label: 'Analyst' },
   { key: 'researcher', label: 'Researcher' },
   { key: 'jules', label: 'Jules' }, l
];
const ROLE_KEYS = Object.keys(DEFAULT_ROLE_CONFIG);
kd, not prompt overrides.
// Used by setup.html to filter the prompt customization UI.
const PROMPT_OVERRIDE_EXCLUDED_KEYS = new Set(['tiket_updater']);
// Role addon UI metadata (moved from kanban.html)
const ROLE_ADDONS = {ltip: 'Include batch executio rules and focus directive', default: true },
  e:c mlplndee at icy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specifed', tooltip: 'Let the execution platform decide subagent behavior' },
  rt' gea ai  bttc'n u'avityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Outut', tooltip: 'Compress responses to reduce output tokens', default: true },
   Role addon UI metadata (moved from kanban.html)
const ROLE_ADDON  = {
   Role addon UI metadata (moved from kanban.html)
const ROLE_ADDON  = {
    // S// S    { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
                { id: 'subagentbllowy', tooltip: 'ontrol           // lue: 'de
u:a _es Bgen hS rategy adio:mbagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
                ], default: 'default' },
                { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
            ],
            tester: [
         ,      { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
     ,   git ommitutrategyuadio:abel: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
     git ommit trategyaadio:ants', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
                    { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
                    { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
                ], default: 'default' },
                { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }
            ],
         ,  intern: [
     ,   gitiush:trategyiadio:eards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
     git ush{trategy adio:mng', label: 'Pair Programming', tooltip: 'Only do Routine (Band A) work', default: false },
                { id: 'accurateCoding', label: 'Accurate Coding', tooltip: 'Emphasize correctness over speed', default: false },label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
                { Wk, lskipCompilation', label: 'Do not recompile the project', tooltip: 'Skip project compilation step to save tokens', default: true },
                { id: 'skipTests', label: 'Do not run automated tests', tooltip: 'Skip automated test execution to save tokens', default: true },
       l    ]
S tl   s]rees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false },
 rf },owFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false }

    ],
    analyst: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },tot
    ],
    ticket_updater: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: false },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }bel: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
         OLebgeDtNS. gitBranch:trategy'adioent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
         OLeutD'}NS._gitCrmmitStw'tWgyRrdool
 eie oi ROLE_ADDONS._glituseSyefeegyRff
    ],OLDNS.dgitBranch:trategy[adio
        cOLodafDgNS._gitCtmmitSti ttgyRSdtoa
 rtpeorcROLE_ADDONS._gi cuskSudreegyRcl't
        { id: 'clearAntigravityContext', label: 'Clear Antigravity Context', tooltip: 'Instruct agent to ignore previous checkpoint summaries from prior sessions', default: false },
        { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce output tokens', default: true },
        { id: 'skipCompilation's
        { id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [
            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
            { value: 'noSubagen
};

if (typeof module !== 'undefined' && module.exports) {
    module.expo,__ 

// Shared click-flash feedback:
        '.sb-click-flash{animation:sbClickFlash 0.18s ease-out}';
    // Insert FIRST so any panel-specific click animation (e.g. kanban's richer flash)
    // wins the cascade on conflict, while this still applies everywhere else.
        const btn = e.target.closest && e.target.closest('button, [role="button"], [class*="btn"]');
        if (!btn || btn.disabled) { return; }
        btn.classList.remove('sb-click-flash');
        void btn.offsetWidth; // restart the animation if clicked again mid-playck-flash');
        