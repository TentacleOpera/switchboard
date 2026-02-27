const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const STATE_ROOT = process.argv[2] || process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
if (!process.argv[2] && !process.env.SWITCHBOARD_WORKSPACE_ROOT) {
    console.warn("[StateManager] Warning: Neither SWITCHBOARD_WORKSPACE_ROOT nor process.argv[2] set. Falling back to process.cwd(). This may cause state fragmentation if MCP is started from different directories.");
}
const STATE_DIR = path.join(STATE_ROOT, '.switchboard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const INITIAL_STATE = {
    session: {
        id: null,
        activeWorkflow: null,
        suspendedWorkflows: [],
        status: "IDLE",
        startTime: null,
        activePersona: null,
        currentStep: 0,
        activeWorkflowPhase: 0
    },
    context: {},
    tasks: [],
    terminals: {},
    chatAgents: {},
    teams: {}
};

function cloneInitialState() {
    return JSON.parse(JSON.stringify(INITIAL_STATE));
}

function normalizeAgentWorkflowState(agentState) {
    if (!agentState || typeof agentState !== 'object') return;
    if (agentState.activeWorkflow === undefined) agentState.activeWorkflow = null;
    if (agentState.currentStep === undefined) agentState.currentStep = 0;
    if (agentState.activeWorkflowPhase === undefined) agentState.activeWorkflowPhase = 0;
    if (agentState.activePersona === undefined) agentState.activePersona = null;
    if (!Array.isArray(agentState.workflowToolInvocations)) agentState.workflowToolInvocations = [];
}

function normalizeStateSchema(state) {
    const normalized = state && typeof state === 'object' ? state : {};

    if (!normalized.session || typeof normalized.session !== 'object') normalized.session = {};
    if (normalized.session.id === undefined) normalized.session.id = null;
    if (normalized.session.activeWorkflow === undefined) normalized.session.activeWorkflow = null;
    if (!Array.isArray(normalized.session.suspendedWorkflows)) normalized.session.suspendedWorkflows = [];
    if (normalized.session.status === undefined) normalized.session.status = "IDLE";
    if (normalized.session.startTime === undefined) normalized.session.startTime = null;
    if (normalized.session.activePersona === undefined) normalized.session.activePersona = null;
    if (normalized.session.currentStep === undefined) normalized.session.currentStep = 0;
    if (normalized.session.activeWorkflowPhase === undefined) normalized.session.activeWorkflowPhase = 0;
    if (!Array.isArray(normalized.session.workflowToolInvocations)) normalized.session.workflowToolInvocations = [];

    if (!normalized.context || typeof normalized.context !== 'object') normalized.context = {};
    if (!Array.isArray(normalized.tasks)) normalized.tasks = [];
    if (!normalized.terminals || typeof normalized.terminals !== 'object') normalized.terminals = {};
    if (!normalized.chatAgents || typeof normalized.chatAgents !== 'object') normalized.chatAgents = {};
    if (!normalized.teams || typeof normalized.teams !== 'object') normalized.teams = {};

    Object.values(normalized.terminals).forEach(normalizeAgentWorkflowState);
    Object.values(normalized.chatAgents).forEach(normalizeAgentWorkflowState);

    return normalized;
}

// Ensure storage directory
if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

const LOCK_OPTIONS = {
    retries: {
        retries: 20,
        minTimeout: 50,
        maxTimeout: 1000,
        randomize: true
    },
    stale: 10000
};

function sleepMsSync(ms) {
    if (ms <= 0) return;
    if (typeof SharedArrayBuffer === 'function' && typeof Atomics?.wait === 'function') {
        const signal = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(signal, 0, 0, ms);
        return;
    }
    const until = Date.now() + ms;
    while (Date.now() < until) {
        // Busy wait fallback for environments without Atomics.wait.
    }
}

function isTransientFsError(error) {
    const code = error?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Ensure the state file exists on disk (idempotent, race-safe).
 * If two processes race, both will try to write INITIAL_STATE.
 * Since atomicWrite uses rename, the last writer wins — but both
 * write identical content, so the result is correct either way.
 */
function ensureStateFile() {
    if (!fs.existsSync(STATE_FILE)) {
        try {
            atomicWrite(STATE_FILE, JSON.stringify(INITIAL_STATE, null, 2));
        } catch (e) {
            // Another process may have created it between our check and write.
            // If the file now exists, that's fine — swallow the error.
            if (!fs.existsSync(STATE_FILE)) throw e;
        }
    }
}

/**
 * atomicWrite — write to temp then rename for crash safety.
 */
function atomicWrite(filePath, content) {
    const maxAttempts = process.platform === 'win32' ? 8 : 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const tempFile = `${filePath}.${Date.now()}.${attempt}.tmp`;
        try {
            fs.writeFileSync(tempFile, content);
            fs.renameSync(tempFile, filePath);
            return;
        } catch (e) {
            if (fs.existsSync(tempFile)) {
                try {
                    fs.unlinkSync(tempFile);
                } catch {
                    // Best-effort cleanup only.
                }
            }

            const canRetry = isTransientFsError(e) && attempt < maxAttempts;
            if (!canRetry) {
                console.error(`[StateManager] Write failed: ${e.message}`);
                throw e;
            }

            const delayMs = Math.min(25 * Math.pow(2, attempt - 1), 300);
            sleepMsSync(delayMs);
        }
    }
}

/**
 * readStateFromDisk — raw read, no lock. Returns parsed state or INITIAL_STATE on error.
 */
function readStateFromDisk() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return cloneInitialState();
        }
        return normalizeStateSchema(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    } catch (e) {
        console.error(`[StateManager] Read failed: ${e.message}`);
        return cloneInitialState();
    }
}

/**
 * loadState (Async) — lock-free read for non-mutating callers.
 * Ensures the file exists first, then reads it.
 */
async function loadState() {
    ensureStateFile();
    return readStateFromDisk();
}

/**
 * updateState (Async)
 * Acquires an exclusive lock, reads current state, applies updater, writes back.
 * Uses proper-lockfile to avoid the deadlock from the old mkdir-based mutex.
 * @param {Function} updater (state) => modifiedState
 */
async function updateState(updater) {
    ensureStateFile();

    let release;
    try {
        release = await lockfile.lock(STATE_FILE, LOCK_OPTIONS);
    } catch (e) {
        throw new Error(`Failed to acquire state lock: ${e.message}`);
    }

    try {
        const current = normalizeStateSchema(readStateFromDisk());
        const next = normalizeStateSchema(updater(current) || current);
        atomicWrite(STATE_FILE, JSON.stringify(next, null, 2));
        return next;
    } finally {
        await release();
    }
}

module.exports = {
    loadState,
    updateState,
    INITIAL_STATE
};
