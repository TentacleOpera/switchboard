/**
 * register-tools.js
 * 
 * Factory function that registers all Switchboard MCP tools on a given server instance.
 * This allows the same tool definitions to be shared across multiple transports
 * (Stdio, SSE, StreamableHTTP) without duplication.
 */

const z = require("zod");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { loadState, updateState } = require("./state-manager");
const { getWorkflow, WORKFLOWS } = require("./workflows");

// DYNAMICALLY derived from WORKFLOWS object keys
const WorkflowEnum = z.enum(Object.keys(WORKFLOWS));
const PhaseGatePhaseEnum = z.enum(['planning', 'execution', 'verification']);
const PhaseGateSchema = z.object({
    phase: PhaseGatePhaseEnum.optional().describe("Declared resume phase for the recipient."),
    authorized_plan: z.string().optional().describe("Plan path already approved for execution."),
    enforce_persona: z.string().optional().describe("Persona to force during resume (e.g., task_runner).")
}).passthrough();

const RESERVED_SYSTEM_AGENT_NAMES = new Set(['session', 'user', 'sidebar']);
const CANONICAL_INBOX_RECIPIENTS = new Set(['coder', 'reviewer', 'planner', 'lead', 'analyst']);
const CANONICAL_RECIPIENT_ALIASES = {
    'coder': 'coder',
    'reviewer': 'reviewer',
    'planner': 'planner',
    'lead': 'lead',
    'lead coder': 'lead',
    'lead-coder': 'lead',
    'analyst': 'analyst'
};
const CANONICAL_ROLE_TO_INBOX = {
    coder: 'coder',
    reviewer: 'reviewer',
    planner: 'planner',
    lead: 'lead',
    analyst: 'analyst'
};

const WORKFLOW_ACTION_ROUTING = {
    'handoff-lead': {
        execute: 'lead'
    },
    handoff: {
        execute: 'coder',
        delegate_task: 'coder'
    },
    'handoff-chat': {
        // Clipboard flow does not require cross-agent dispatch.
    },
    'handoff-relay': {
        // Relay flow pauses after staging, no dispatch required.
    },
    challenge: {
        execute: 'reviewer'
    },
    accuracy: {
        // No cross-agent delegation
    }
};

const MAX_ENRICHED_DISPATCH_PAYLOAD_CHARS = 1200;

// --- Recipient Validation ---

/**
 * Validates that a recipient exists as a registered agent.
 * Checks: state.terminals, state.chatAgents ONLY.
 * Inbox-only agents are NOT accepted (prevents stale inbox false positives).
 * Returns null if valid, error string if invalid.
 */
async function validateRecipient(recipient, state) {
    // Check for exact match or resolved alias/friendlyName
    const resolvedName = resolveAgentName(state, recipient);
    if (resolvedName) return null;

    // NO inbox-only fallback — stale inbox directories from previous bad sends
    // must NOT count as valid recipients. Agents MUST be explicitly registered.
    return `Recipient '${recipient}' is not a registered terminal or chat agent. Known agents: ${getKnownAgentNames(state).join(', ') || '(none)'}. Register the agent first with register_terminal or register_chat agent.`;
}

function getKnownAgentNames(state) {
    const names = new Set();
    if (state.terminals) Object.keys(state.terminals).forEach(n => names.add(n));
    if (state.chatAgents) Object.keys(state.chatAgents).forEach(n => names.add(n));
    return Array.from(names);
}

function getAgentRecord(state, agentName) {
    if (!agentName) return null;

    // First try exact match
    const exactMatch = state.terminals?.[agentName] || state.chatAgents?.[agentName];
    if (exactMatch) return exactMatch;

    // Then try resolved name
    const resolvedName = resolveAgentName(state, agentName);
    if (resolvedName) {
        return state.terminals?.[resolvedName] || state.chatAgents?.[resolvedName] || null;
    }

    return null;
}

/**
 * Resolves an agent name by checking for exact match, alias, or friendlyName.
 * @param {Object} state - The current state containing terminals and chatAgents
 * @param {string} agentName - The name, alias, or friendlyName to resolve
 * @returns {string|null} - The resolved agent name or null if not found
 */
function resolveAgentName(state, agentName) {
    if (!agentName) return null;

    // First, check for exact match (maintain backward compatibility)
    if ((state.terminals && state.terminals[agentName]) ||
        (state.chatAgents && state.chatAgents[agentName])) {
        return agentName;
    }

    const normalizedRequested = normalizePersonaKey(agentName);
    if (normalizedRequested && CANONICAL_ROLE_TO_INBOX[normalizedRequested]) {
        const roleMatches = [];
        if (state.terminals) {
            for (const [name, data] of Object.entries(state.terminals)) {
                if (normalizePersonaKey(data?.role) === normalizedRequested) {
                    roleMatches.push(name);
                }
            }
        }
        if (state.chatAgents) {
            for (const [name, data] of Object.entries(state.chatAgents)) {
                if (normalizePersonaKey(data?.role) === normalizedRequested) {
                    roleMatches.push(name);
                }
            }
        }
        if (roleMatches.length === 1) {
            return roleMatches[0];
        }
    }

    // Then check for alias or friendlyName matches in terminals
    if (state.terminals) {
        for (const [name, data] of Object.entries(state.terminals)) {
            if ((data.alias && data.alias === agentName) ||
                (data.friendlyName && data.friendlyName === agentName)) {
                return name;
            }
        }
    }

    // Then check for alias or friendlyName matches in chatAgents
    if (state.chatAgents) {
        for (const [name, data] of Object.entries(state.chatAgents)) {
            if ((data.alias && data.alias === agentName) ||
                (data.friendlyName && data.friendlyName === agentName)) {
                return name;
            }
        }
    }

    return null;
}

function isSystemChatAgentRecord(name, data) {
    if (RESERVED_SYSTEM_AGENT_NAMES.has(name)) return true;
    if (!data || typeof data !== 'object') return false;
    if (data.role === 'system') return true;
    if (data.interface === 'system') return true;
    return false;
}

function resolveWorkflowTarget(state, targetAgent) {
    if (!targetAgent) {
        if (!state.session) state.session = { status: "IDLE", currentStep: 0, activeWorkflowPhase: 0, suspendedWorkflows: [] };
        return { kind: 'session', label: 'session', name: null, node: state.session };
    }

    // Try exact match first
    const terminal = state.terminals?.[targetAgent];
    if (terminal) {
        return { kind: 'terminal', label: `terminal '${targetAgent}'`, name: targetAgent, node: terminal };
    }

    const chatAgent = state.chatAgents?.[targetAgent];
    if (chatAgent) {
        return { kind: 'chat', label: `chat agent '${targetAgent}'`, name: targetAgent, node: chatAgent };
    }

    // Try resolving by alias or friendlyName
    const resolvedName = resolveAgentName(state, targetAgent);
    if (resolvedName) {
        const resolvedTerminal = state.terminals?.[resolvedName];
        if (resolvedTerminal) {
            return { kind: 'terminal', label: `terminal '${resolvedName}'`, name: resolvedName, node: resolvedTerminal };
        }

        const resolvedChatAgent = state.chatAgents?.[resolvedName];
        if (resolvedChatAgent) {
            return { kind: 'chat', label: `chat agent '${resolvedName}'`, name: resolvedName, node: resolvedChatAgent };
        }
    }

    return null;
}

function getSenderWorkflowContext(state, sender) {
    const envSender = sanitizePathToken(process.env.SWITCHBOARD_AGENT_NAME || process.env.SWITCHBOARD_SENDER);
    const implicitSender = envSender ? (resolveAgentName(state, envSender) || envSender) : null;
    const senderName = sender || implicitSender || 'orchestrator';
    if (RESERVED_SYSTEM_AGENT_NAMES.has(senderName)) {
        return {
            senderName,
            scope: 'session',
            activeWorkflow: state.session?.activeWorkflow || null
        };
    }

    const senderAgent = getAgentRecord(state, senderName);
    if (senderAgent) {
        return {
            senderName,
            scope: 'agent',
            activeWorkflow: senderAgent.activeWorkflow || null
        };
    }

    return {
        senderName,
        scope: 'session',
        activeWorkflow: state.session?.activeWorkflow || null
    };
}

function sanitizePathToken(input) {
    if (typeof input !== 'string') return null;
    const cleaned = input.trim().replace(/^[`'"]+/, '').replace(/[`'".,;:!?]+$/, '');
    return cleaned || null;
}

// F-02/F-03/F-04: Validate agent names to prevent path traversal
const SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9 _-]+$/;
function isValidAgentName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 128 && SAFE_AGENT_NAME_RE.test(name);
}

// F-04: Check that resolved path is within a root directory
function isPathWithinRoot(resolvedPath, rootDir) {
    if (typeof resolvedPath !== 'string' || typeof rootDir !== 'string') return false;

    const normalizedPath = path.resolve(resolvedPath);
    const normalizedRoot = path.resolve(rootDir);

    let rel = path.relative(normalizedRoot, normalizedPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return true;
    }

    // Windows/symlink fallback: compare canonicalized existing paths.
    // If either path does not exist, fall back to normalized comparison above.
    try {
        const canonicalPath = fs.realpathSync.native
            ? fs.realpathSync.native(normalizedPath)
            : fs.realpathSync(normalizedPath);
        const canonicalRoot = fs.realpathSync.native
            ? fs.realpathSync.native(normalizedRoot)
            : fs.realpathSync(normalizedRoot);
        rel = path.relative(canonicalRoot, canonicalPath);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch {
        return false;
    }
}

function getWorkspaceRoot() {
    return process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
}

function isStrictInboxAuthEnabledForDispatch() {
    const raw = process.env.SWITCHBOARD_STRICT_INBOX_AUTH;
    if (typeof raw !== 'string' || !raw.trim()) return false;
    return raw.trim().toLowerCase() !== 'false';
}

function getDispatchSigningKey() {
    const raw = process.env.SWITCHBOARD_DISPATCH_SIGNING_KEY;
    if (typeof raw !== 'string') return null;
    const token = raw.trim();
    return token.length >= 32 ? token : null;
}

function computeDispatchPayloadHash(payload) {
    return crypto
        .createHash('sha256')
        .update(String(payload ?? ''), 'utf8')
        .digest('hex');
}

function buildDispatchAuthEnvelope(message) {
    const secret = getDispatchSigningKey();
    if (!secret) return null;

    const nonce = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const payloadHash = computeDispatchPayloadHash(message?.payload || '');
    const canonical = [
        'hmac-sha256-v1',
        String(message?.id || ''),
        String(message?.action || ''),
        String(message?.sender || ''),
        String(message?.recipient || ''),
        String(message?.createdAt || ''),
        nonce,
        payloadHash
    ].join('|');
    const signature = crypto
        .createHmac('sha256', secret)
        .update(canonical, 'utf8')
        .digest('hex');

    return {
        version: 'hmac-sha256-v1',
        nonce,
        payloadHash,
        signature
    };
}

const ACTIVITY_LOG_FILENAME = 'activity.jsonl';
const MCP_SENSITIVE_KEY_RE = /(api[_-]?key|password|passwd|secret|token|authorization|cookie|private[_-]?key)/i;

function sanitizeAuditPayload(value, key = 'root') {
    if (value === null || value === undefined) return value;
    if (MCP_SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item, idx) => sanitizeAuditPayload(item, `${key}[${idx}]`));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = sanitizeAuditPayload(v, k);
        }
        return out;
    }
    if (typeof value === 'string' && value.length > 800) {
        return `${value.slice(0, 800)}... [TRUNCATED]`;
    }
    return value;
}

async function appendWorkflowAuditEvent(type, payload, workspaceRoot = getWorkspaceRoot()) {
    try {
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        await fs.promises.mkdir(sessionsDir, { recursive: true });
        const row = {
            timestamp: new Date().toISOString(),
            type,
            payload: sanitizeAuditPayload(payload || {})
        };
        await fs.promises.appendFile(path.join(sessionsDir, ACTIVITY_LOG_FILENAME), `${JSON.stringify(row)}\n`, 'utf8');
    } catch (error) {
        console.error(`[audit] Failed to append workflow audit event '${type}': ${error?.message || error}`);
    }
}

function resolveWorkspacePathToken(inputPath, workspaceRoot = getWorkspaceRoot()) {
    const token = sanitizePathToken(inputPath);
    if (!token) return null;
    if (path.isAbsolute(token)) return path.normalize(token);
    return path.resolve(workspaceRoot, token);
}

function inferAuthorizedPlanPath(payload) {
    const text = String(payload || '');
    const directPathMatch = text.match(
        /(?:^|[\s(])([./\\A-Za-z0-9_:-]*(?:implementation_plan[^\s`'")]*|plan_[^\s`'")]*)\.md)/i
    );
    if (directPathMatch?.[1]) {
        return sanitizePathToken(directPathMatch[1]);
    }

    const phrasePathMatch = text.match(/(?:implement|review|execute)\s+(?:the\s+)?plan(?:\s+at)?\s+([^\s`'")]+)/i);
    if (phrasePathMatch?.[1]) {
        return sanitizePathToken(phrasePathMatch[1]);
    }

    return null;
}

function isPlanReviewIntent(payload, metadata, workspaceRoot = getWorkspaceRoot()) {
    const metadataPlanToken = sanitizePathToken(metadata?.review?.authorized_plan);
    const metadataPlan = resolveWorkspacePathToken(metadataPlanToken, workspaceRoot);
    if (metadataPlan) {
        return {
            isPlan: true,
            reason: 'metadata.review.authorized_plan',
            planPath: metadataPlan
        };
    }

    const inferredPlanToken = inferAuthorizedPlanPath(payload);
    const inferredPlan = resolveWorkspacePathToken(inferredPlanToken, workspaceRoot);
    if (inferredPlan) {
        return {
            isPlan: true,
            reason: 'payload_plan_path',
            planPath: inferredPlan
        };
    }

    return {
        isPlan: false,
        reason: 'no_plan_signal',
        planPath: null
    };
}

function findPreferredRoleRecipient(state, roleKey) {
    const normalizedRole = normalizePersonaKey(roleKey);
    if (!normalizedRole) return null;

    const candidates = [];
    const addCandidates = (agents) => {
        if (!agents || typeof agents !== 'object') return;
        for (const [name, data] of Object.entries(agents)) {
            if (normalizePersonaKey(data?.role) === normalizedRole) {
                candidates.push({
                    name,
                    status: normalizePersonaKey(data?.status),
                    lastSeenMs: Date.parse(String(data?.lastSeen || ''))
                });
            }
        }
    };

    addCandidates(state.terminals);
    addCandidates(state.chatAgents);
    if (candidates.length > 0) {
        const score = (candidate) => {
            if (candidate.status === 'active' || candidate.status === 'working') return 3;
            if (candidate.status === 'thinking') return 2;
            if (candidate.status === 'idle') return 1;
            return 0;
        };
        candidates.sort((a, b) => {
            const scoreDelta = score(b) - score(a);
            if (scoreDelta !== 0) return scoreDelta;

            const timeA = Number.isFinite(a.lastSeenMs) ? a.lastSeenMs : 0;
            const timeB = Number.isFinite(b.lastSeenMs) ? b.lastSeenMs : 0;
            return timeB - timeA;
        });
        return candidates[0].name;
    }

    return resolveAgentName(state, roleKey);
}

function parseJsonSafe(content) {
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function coercePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function sanitizeIsoTimestamp(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}

function archiveSwitchboardFileSync(workspaceRoot, filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const switchboardRoot = path.join(workspaceRoot, '.switchboard');
        const relative = path.relative(switchboardRoot, filePath);
        if (relative.startsWith('..')) return null;

        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const archiveRoot = path.join(switchboardRoot, 'archive', `${yyyy}-${mm}`);
        const targetPath = path.join(archiveRoot, relative);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });

        let finalTarget = targetPath;
        if (fs.existsSync(finalTarget)) {
            const ext = path.extname(finalTarget);
            const base = ext ? finalTarget.slice(0, -ext.length) : finalTarget;
            finalTarget = `${base}.${Date.now()}${ext}`;
        }

        fs.renameSync(filePath, finalTarget);
        return finalTarget;
    } catch {
        return null;
    }
}

function supersedePendingDelegateTasks(workspaceRoot, recipient, senderName, replacementMessageId, replacementCreatedAt) {
    if (!isValidAgentName(recipient)) return [];
    const inboxRoot = path.join(workspaceRoot, '.switchboard', 'inbox');
    const inboxDir = path.resolve(path.join(inboxRoot, recipient));
    if (!isPathWithinRoot(inboxDir, inboxRoot)) return [];
    if (!fs.existsSync(inboxDir)) return [];

    const supersededIds = [];
    const files = fs.readdirSync(inboxDir)
        .filter(f => f.startsWith('msg_') && f.endsWith('.json') && !f.endsWith('.result.json') && !f.endsWith('.receipt.json'))
        .sort();

    for (const file of files) {
        const fullPath = path.join(inboxDir, file);
        const parsed = parseJsonSafe(fs.readFileSync(fullPath, 'utf8'));
        if (!parsed) continue;
        if (parsed.action !== 'delegate_task') continue;
        if (parsed.sender !== senderName) continue;
        if (!parsed.id || parsed.id === replacementMessageId) continue;

        const resultPath = fullPath.replace(/\.json$/i, '.result.json');
        const receiptPath = fullPath.replace(/\.json$/i, '.receipt.json');
        if (fs.existsSync(resultPath) || fs.existsSync(receiptPath)) continue;

        const marker = {
            id: `superseded_${parsed.id}`,
            inReplyTo: parsed.id,
            status: 'superseded',
            supersededBy: replacementMessageId,
            supersededAt: replacementCreatedAt
        };
        try {
            fs.writeFileSync(`${fullPath}.superseded.meta`, JSON.stringify(marker, null, 2));
        } catch {
            // Marker is best-effort. Archiving still proceeds.
        }

        archiveSwitchboardFileSync(workspaceRoot, fullPath);
        if (fs.existsSync(resultPath)) archiveSwitchboardFileSync(workspaceRoot, resultPath);
        if (fs.existsSync(receiptPath)) archiveSwitchboardFileSync(workspaceRoot, receiptPath);
        supersededIds.push(parsed.id);
    }

    return supersededIds;
}

function buildDispatchMetadata(messageMetadata, messageId, createdAtIso, senderName, action) {
    const existingDispatch = (messageMetadata?.dispatch && typeof messageMetadata.dispatch === 'object' && !Array.isArray(messageMetadata.dispatch))
        ? { ...messageMetadata.dispatch }
        : {};

    const defaultTtlMinutes = 480;
    const ttlMinutes = coercePositiveInt(
        existingDispatch.ttl_minutes ?? messageMetadata?.dispatch_ttl_minutes,
        defaultTtlMinutes
    );
    const explicitExpires = sanitizeIsoTimestamp(existingDispatch.expires_at);
    const expiresAt = explicitExpires || new Date(Date.parse(createdAtIso) + ttlMinutes * 60000).toISOString();
    const queueMode = existingDispatch.queue_mode === 'keep' ? 'keep' : 'replace';

    return {
        ...existingDispatch,
        dispatch_id: messageId,
        created_at: createdAtIso,
        expires_at: expiresAt,
        queue_mode: queueMode,
        require_reply: true,
        reply_to: messageId,
        sender: senderName,
        action: action
    };
}

function normalizeReviewMetadata(rawReview, workspaceRoot) {
    if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) {
        return {};
    }
    const review = {};
    const authorizedPlan = resolveWorkspacePathToken(rawReview.authorized_plan, workspaceRoot);
    const reportPath = resolveWorkspacePathToken(rawReview.report_path, workspaceRoot);
    const dispatchId = sanitizePathToken(rawReview.dispatch_id);
    const createdAt = sanitizeIsoTimestamp(rawReview.created_at);
    const expiresAt = sanitizeIsoTimestamp(rawReview.expires_at);

    if (authorizedPlan) review.authorized_plan = authorizedPlan;
    if (reportPath) review.report_path = reportPath;
    if (dispatchId) review.dispatch_id = dispatchId;
    if (createdAt) review.created_at = createdAt;
    if (expiresAt) review.expires_at = expiresAt;
    return review;
}

function isExpiredReviewDispatch(message, nowMs) {
    const expiresAt = sanitizeIsoTimestamp(message?.metadata?.dispatch?.expires_at)
        || sanitizeIsoTimestamp(message?.metadata?.review?.expires_at);
    if (!expiresAt) return false;
    return Date.parse(expiresAt) < nowMs;
}

// [REMOVED] writePendingDispatchMeta - Outbox system deprecated in Switchboard 2.0 (Blind Send)

function normalizePhaseGateMetadata(metadata, workspaceRoot) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = metadata.phase_gate;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error("metadata.phase_gate must be an object when provided.");
    }

    const normalized = {};
    if (raw.phase !== undefined) {
        if (typeof raw.phase !== 'string') {
            throw new Error("metadata.phase_gate.phase must be a string.");
        }
        const phase = raw.phase.trim().toLowerCase();
        if (!PhaseGatePhaseEnum.options.includes(phase)) {
            throw new Error(`metadata.phase_gate.phase must be one of: ${PhaseGatePhaseEnum.options.join(', ')}.`);
        }
        normalized.phase = phase;
    }

    if (raw.authorized_plan !== undefined) {
        const authorizedPlan = resolveWorkspacePathToken(raw.authorized_plan, workspaceRoot);
        if (!authorizedPlan) {
            throw new Error("metadata.phase_gate.authorized_plan must be a non-empty plan path.");
        }
        normalized.authorized_plan = authorizedPlan;
    }

    if (raw.enforce_persona !== undefined) {
        if (typeof raw.enforce_persona !== 'string' || !raw.enforce_persona.trim()) {
            throw new Error("metadata.phase_gate.enforce_persona must be a non-empty string.");
        }
        normalized.enforce_persona = raw.enforce_persona.trim();
    }

    return normalized;
}

function buildPhaseGateForMessage(action, payload, messageMetadata, workspaceRoot) {
    const explicit = normalizePhaseGateMetadata(messageMetadata, workspaceRoot) || {};
    const inferredPlanRaw = inferAuthorizedPlanPath(payload);
    const inferredPlan = resolveWorkspacePathToken(inferredPlanRaw, workspaceRoot);

    if (action === 'delegate_task') {
        const authorizedPlan = explicit.authorized_plan || inferredPlan || undefined;
        const phase = explicit.phase || (authorizedPlan ? 'execution' : 'planning');
        const enforcePersona = explicit.enforce_persona || (authorizedPlan ? 'task_runner' : undefined);

        if (phase === 'execution' && !authorizedPlan) {
            throw new Error("delegate_task with phase_gate.phase='execution' requires phase_gate.authorized_plan or a plan path in payload.");
        }

        const phaseGate = { phase };
        if (authorizedPlan) phaseGate.authorized_plan = authorizedPlan;
        if (enforcePersona) phaseGate.enforce_persona = enforcePersona;
        return phaseGate;
    }

    if (Object.keys(explicit).length > 0) {
        return explicit;
    }

    return null;
}

/**
 * checkPersonaToolGate — Returns an ERR_PERSONA_VIOLATION error string if the tool
 * is prohibited for the active workflow persona, or null if the call is allowed.
 */
function checkPersonaToolGate(activeWorkflow, toolName) {
    if (!activeWorkflow || !toolName) return null;
    const wfDef = getWorkflow(activeWorkflow);
    if (!wfDef || !Array.isArray(wfDef.prohibitedTools)) return null;
    if (wfDef.prohibitedTools.includes(toolName)) {
        return `ERR_PERSONA_VIOLATION: Permission denied for tool '${toolName}' in '${activeWorkflow}' mode. ` +
            `This tool is restricted for the active persona. ` +
            `Stop the current workflow with stop_workflow() before using this tool.`;
    }
    return null;
}

function popSuspendedSessionWorkflow(session) {
    if (!session || !Array.isArray(session.suspendedWorkflows) || session.suspendedWorkflows.length === 0) {
        return null;
    }
    return session.suspendedWorkflows.pop() || null;
}

function appendWorkflowToolInvocation(node, tool) {
    if (!node || !node.activeWorkflow || !tool) return;
    if (!Array.isArray(node.workflowToolInvocations)) {
        node.workflowToolInvocations = [];
    }

    const phase = Number(node.currentStep || 0) + 1;
    node.workflowToolInvocations.push({
        workflow: node.activeWorkflow,
        phase,
        tool: String(tool),
        calledAt: new Date().toISOString()
    });

    if (node.workflowToolInvocations.length > 500) {
        node.workflowToolInvocations = node.workflowToolInvocations.slice(-500);
    }
}

function resolveNodeForSenderEvidence(state, senderName) {
    const senderContext = getSenderWorkflowContext(state, senderName);
    if (senderContext.scope === 'agent') {
        const node = state.terminals?.[senderContext.senderName] || state.chatAgents?.[senderContext.senderName];
        if (node) return node;
    }
    if (!state.session) {
        state.session = { status: "IDLE", currentStep: 0, activeWorkflowPhase: 0, suspendedWorkflows: [] };
    }
    return state.session;
}

function resolveNodeForAgentEvidence(state, agentName) {
    if (!agentName || RESERVED_SYSTEM_AGENT_NAMES.has(agentName)) {
        if (!state.session) {
            state.session = { status: "IDLE", currentStep: 0, activeWorkflowPhase: 0, suspendedWorkflows: [] };
        }
        return state.session;
    }

    const exactMatch = state.terminals?.[agentName] || state.chatAgents?.[agentName];
    if (exactMatch) return exactMatch;

    const resolvedName = resolveAgentName(state, agentName);
    if (resolvedName) {
        return state.terminals?.[resolvedName] || state.chatAgents?.[resolvedName] || state.session;
    }

    if (!state.session) {
        state.session = { status: "IDLE", currentStep: 0, activeWorkflowPhase: 0, suspendedWorkflows: [] };
    }
    return state.session;
}

// --- Workflow Enforcement ---

/**
 * Checks if a payload contains restricted "brain" paths.
 * Returns true if leakage detected.
 */
function isBrainLeakage(payload) {
    if (!payload) return false;
    // Match any path containing the global brain directory
    return payload.includes('.gemini/antigravity/brain/') ||
        payload.includes('.gemini\\antigravity\\brain\\');
}

/**
 * Maps message actions to the workflows that MUST be active to use them.
 * If an agent tries to use a workflow-bound action without the right workflow,
 * the tool call is REJECTED Ã¢â‚¬â€ not warned, rejected.
 */
const ACTION_REQUIRED_WORKFLOWS = {
    'execute': ['handoff', 'challenge', 'handoff-lead'],
    'delegate_task': ['handoff'],
};

/**
 * Checks if the current action requires an active workflow and validates it.
 * Returns null if OK, error string if blocked.
 */
async function enforceWorkflowForAction(action, state, sender, recipient, payload, metadata) {
    const senderContext = getSenderWorkflowContext(state, sender);

    // 1. LEAKAGE DETECTOR
    // Restricted: execution/delegation actions must NOT reference the internal brain.
    if (action === 'execute' || action === 'delegate_task') {
        if (isBrainLeakage(payload)) {
            return `LEAKAGE DETECTED: Message payload contains restricted internal brain paths. You MUST stage artifacts to '.switchboard/' first and reference the workspace paths instead. Path found in: ${payload}`;
        }
    }

    const requiredWorkflows = ACTION_REQUIRED_WORKFLOWS[action];
    if (requiredWorkflows) {
        const activeWorkflow = senderContext.activeWorkflow;

        if (!activeWorkflow) {
            const hint = senderContext.scope === 'agent'
                ? `Call start_workflow(name: "...", targetAgent: "${senderContext.senderName}") first.`
                : `Call start_workflow() first.`;
            return `Action '${action}' requires an active workflow (one of: ${requiredWorkflows.join(', ')}). ` +
                `No workflow is currently active for sender '${senderContext.senderName}'. ${hint}`;
        }

        if (!requiredWorkflows.includes(activeWorkflow)) {
            // Build valid-actions hint for the current workflow
            const validActions = Object.entries(ACTION_REQUIRED_WORKFLOWS)
                .filter(([, workflows]) => workflows.includes(activeWorkflow))
                .map(([act]) => act);
            const validActionsHint = validActions.length > 0
                ? ` Valid actions for '${activeWorkflow}': [${validActions.join(', ')}].`
                : ` No send_message actions are supported by workflow '${activeWorkflow}'.`;
            return `Action '${action}' is not valid for workflow '${activeWorkflow}'.${validActionsHint} ` +
                `Did you mean action: '${validActions[0] || action}'?`;
        }

        // 2. PHASE-GATE ENFORCEMENT
        // Block execution/delegation until critical preparation phases are done.
        if (action === 'execute' || action === 'delegate_task') {
            const currentStep = senderContext.scope === 'agent'
                ? (state.terminals?.[senderContext.senderName]?.currentStep || state.chatAgents?.[senderContext.senderName]?.currentStep || 0)
                : (state.session?.currentStep || 0);

            // HANDOFF Gate: Must complete Phase 1 (Stage/Prepare)
            if (activeWorkflow === 'handoff' && currentStep < 1) {
                if (!metadata?.all) {
                    return `PHASE-GATE BLOCKED: Phase 1 (Stage Artifacts) must be completed before '${action}'.\n\nRequired: Call complete_workflow_phase(phase: 1, workflow: '${activeWorkflow}', artifacts: [{ path: '.switchboard/handoff/...', description: '...' }])\n\nEvidence expected: Staged artifacts in .switchboard/handoff/ or .switchboard/plans/\n\nTip: Use --all flag to bypass split/stage requirement if appropriate.`;
                }
            }

            // HANDOFF-LEAD Gate: Must complete Phase 1 (Stage/Prepare)
            if (activeWorkflow === 'handoff-lead' && action === 'execute' && currentStep < 1) {
                if (!metadata?.all) { // --all flag bypasses split/stage requirement if intended
                    return `PHASE-GATE BLOCKED: Phase 1 (Stage Artifacts) must be completed before '${action}'.\n\nRequired: Call complete_workflow_phase(phase: 1, workflow: 'handoff-lead', artifacts: [{ path: '.switchboard/handoff/lead_request.md', description: '...' }])\n\nEvidence expected: Staged request in .switchboard/handoff/lead_request.md\n\nTip: Use --all flag to bypass split/stage requirement if appropriate.`;
                }
            }

        }
    }

    const recipientAgent = getAgentRecord(state, recipient);
    if (recipientAgent?.activeWorkflow) {
        const isSelfMessage = senderContext.scope === 'agent' && senderContext.senderName === recipient;

        // Strict async isolation: no sender may interrupt another agent's active workflow.
        if (!isSelfMessage) {
            return `Recipient '${recipient}' is workflow-locked by '${recipientAgent.activeWorkflow}'. ` +
                `Sender '${senderContext.senderName}' cannot disturb another agent's active workflow.`;
        }
    }

    return null; // Workflow matches
}

// --- Persona Injection System ---

const ROLE_TO_PERSONA_FILE = {
    'lead': 'lead.md',
    'coder': 'coder.md',
    'coder 1': 'coder.md', // Backwards compatibility
    'coder 2': 'coder.md', // Backwards compatibility
    'reviewer': 'reviewer.md',
    'planner': 'planner.md',
    'tester': 'tester.md',
    'researcher': 'researcher.md',
    'task runner': 'task_runner.md',
    'execution': 'task_runner.md' // Backwards compatibility
};

function normalizePersonaKey(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    return normalized || null;
}

// --- Cooldown Management ---

const SENDER_COOLDOWN_SECONDS = 30;

/**
 * Check if a dispatch is within the cooldown window
 * Uses atomic lock files per sender-recipient-action triplet
 */
function checkDispatchCooldown(workspaceRoot, sender, recipient, action) {
    const cooldownDir = path.join(workspaceRoot, '.switchboard', 'cooldowns');
    if (!fs.existsSync(cooldownDir)) {
        fs.mkdirSync(cooldownDir, { recursive: true });
    }

    const lockKey = `${sender}_${recipient}_${action}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const lockFile = path.join(cooldownDir, `${lockKey}.lock`);

    try {
        if (fs.existsSync(lockFile)) {
            const stats = fs.statSync(lockFile);
            const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;

            if (ageSeconds < SENDER_COOLDOWN_SECONDS) {
                const remaining = Math.ceil(SENDER_COOLDOWN_SECONDS - ageSeconds);
                return {
                    inCooldown: true,
                    remainingSeconds: remaining
                };
            }
        }

        // Update/create lock file
        fs.writeFileSync(lockFile, JSON.stringify({
            sender,
            recipient,
            action,
            timestamp: new Date().toISOString()
        }, null, 2), 'utf8');

        return { inCooldown: false };
    } catch (error) {
        console.error('[Cooldown] Error checking cooldown:', error);
        return { inCooldown: false }; // Fail open
    }
}

/**
 * Clean up old cooldown lock files
 */
function cleanupOldCooldowns(workspaceRoot) {
    try {
        const cooldownDir = path.join(workspaceRoot, '.switchboard', 'cooldowns');
        if (!fs.existsSync(cooldownDir)) return;

        const now = Date.now();
        const files = fs.readdirSync(cooldownDir);

        for (const file of files) {
            if (!file.endsWith('.lock')) continue;

            const filePath = path.join(cooldownDir, file);
            const stats = fs.statSync(filePath);
            const ageSeconds = (now - stats.mtimeMs) / 1000;

            // Clean up locks older than 5 minutes
            if (ageSeconds > 300) {
                fs.unlinkSync(filePath);
            }
        }
    } catch (error) {
        console.error('[Cooldown] Cleanup failed:', error);
    }
}

function resolvePersonaByRoleKey(roleKey) {
    const normalizedRole = normalizePersonaKey(roleKey);
    if (!normalizedRole || normalizedRole === 'none') return null;

    const personaFile = ROLE_TO_PERSONA_FILE[normalizedRole];
    if (!personaFile) return null;

    const workspaceRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
    const personaPath = path.join(workspaceRoot, '.agent', 'personas', 'roles', personaFile);

    try {
        if (!fs.existsSync(personaPath)) return null;
        return fs.readFileSync(personaPath, 'utf8').trim();
    } catch {
        return null;
    }
}

function resolvePersonaForRecipient(state, recipient, options = {}) {
    const enforcedPersona = options?.enforcePersona;
    if (enforcedPersona) {
        const forced = resolvePersonaByRoleKey(enforcedPersona);
        if (forced) return forced;
    }

    const recipientRecord = getAgentRecord(state, recipient);
    let role = recipientRecord?.role || state.terminals?.[recipient]?.role || state.chatAgents?.[recipient]?.role;
    if (!role) {
        const normalizedRecipient = normalizePersonaKey(recipient);
        if (CANONICAL_ROLE_TO_INBOX[normalizedRecipient]) {
            role = normalizedRecipient;
        }
    }
    if (!role || role === 'none') return null;

    return resolvePersonaByRoleKey(role);
}

function getCanonicalInboxForAgent(state, agentName) {
    const normalized = normalizePersonaKey(agentName);
    if (normalized && CANONICAL_RECIPIENT_ALIASES[normalized]) {
        return CANONICAL_RECIPIENT_ALIASES[normalized];
    }

    const record = getAgentRecord(state, agentName);
    const roleKey = normalizePersonaKey(record?.role);
    if (roleKey && CANONICAL_ROLE_TO_INBOX[roleKey]) {
        return CANONICAL_ROLE_TO_INBOX[roleKey];
    }

    return null;
}

function getIdentityEquivalenceKey(state, name) {
    const canonicalInbox = getCanonicalInboxForAgent(state, name);
    if (canonicalInbox) {
        return `inbox:${canonicalInbox}`;
    }

    const resolved = resolveAgentName(state, name);
    if (resolved) {
        return `agent:${resolved}`;
    }

    return `raw:${normalizePersonaKey(name) || String(name || '').trim()}`;
}

function getExecutionGuardrail(action, originalMessage, phaseGate, dispatchMetadata) {
    // Generalize guardrail for any delegation
    if (!['delegate_task', 'execute'].includes(action)) return '';

    const explicitPlan = sanitizePathToken(phaseGate?.authorized_plan);
    const inferredPlan = inferAuthorizedPlanPath(originalMessage);
    const authorizedPlan = explicitPlan || inferredPlan;
    const dispatchId = sanitizePathToken(dispatchMetadata?.dispatch_id);
    const createdAt = sanitizeIsoTimestamp(dispatchMetadata?.created_at);
    const expiresAt = sanitizeIsoTimestamp(dispatchMetadata?.expires_at);

    const parts = [`pre-authorized ${action}`];

    if (authorizedPlan) {
        parts.push(`plan=${authorizedPlan}`);
    }

    if (dispatchId) {
        parts.push(`dispatch=${dispatchId}`);
    }
    if (createdAt) {
        parts.push(`created=${createdAt}`);
    }
    if (expiresAt) {
        parts.push(`expires=${expiresAt}`);
    }
    if (dispatchId || createdAt || expiresAt) {
        parts.push('newest-unexpired-only');
    }

    parts.push('questions=hard-blockers-only');
    return `\n\n[GUARDRAIL] ${parts.join(' | ')}`;
}

function truncateWithEllipsis(text, maxChars) {
    const value = String(text || '');
    if (maxChars <= 0) return '';
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return '.'.repeat(maxChars);
    return `${value.slice(0, maxChars - 3)}...`;
}

function normalizeCompactLine(line) {
    return String(line || '')
        .replace(/^#+\s*/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/[*_`>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function compactPersona(persona) {
    const lines = String(persona || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) return '';

    const heading = lines.find(line => /^#/.test(line));
    const title = normalizeCompactLine(heading || lines[0]) || 'Role Persona';
    return `Role: ${title}`;
}

function composeDispatchPayload(personaBlock, originalMessage, guardrail) {
    const prefix = personaBlock
        ? `---PERSONA---\n${personaBlock}\n---END PERSONA---\n\n`
        : '';
    const body = String(originalMessage || '');
    const suffix = String(guardrail || '');

    const full = `${prefix}${body}${suffix}`;
    if (full.length <= MAX_ENRICHED_DISPATCH_PAYLOAD_CHARS) {
        return full;
    }

    const truncationNote = '\n\n[Payload truncated to fit delivery limit]';
    const reserved = prefix.length + suffix.length + truncationNote.length;
    const availableBodyChars = Math.max(0, MAX_ENRICHED_DISPATCH_PAYLOAD_CHARS - reserved);
    const truncatedBody = truncateWithEllipsis(body, availableBodyChars);

    return `${prefix}${truncatedBody}${suffix}${truncationNote}`;
}

function formatPersonaMessage(persona, originalMessage, action, phaseGate, dispatchMetadata) {
    const guardrail = getExecutionGuardrail(action, originalMessage, phaseGate, dispatchMetadata);
    const personaBlock = compactPersona(persona);
    return composeDispatchPayload(personaBlock, originalMessage, guardrail);
}

function enrichPayloadForDispatch(persona, originalMessage, action, phaseGate, dispatchMetadata) {
    if (persona) {
        return formatPersonaMessage(persona, originalMessage, action, phaseGate, dispatchMetadata);
    }
    const guardrail = getExecutionGuardrail(action, originalMessage, phaseGate, dispatchMetadata);
    return composeDispatchPayload('', originalMessage, guardrail);
}

// --- Process Helpers ---

function normalizePid(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
}

async function getProcessStartTime(pid) {
    const safePid = normalizePid(pid);
    if (!safePid) return null;

    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync(
                'powershell',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    "(Get-Process -Id $args[0]).StartTime.ToString('yyyy-MM-dd HH:mm:ss.fff')",
                    String(safePid)
                ],
                { windowsHide: true }
            );
            return stdout ? stdout.trim() : null;
        } else {
            const { stdout } = await execFileAsync('ps', ['-p', String(safePid), '-o', 'lstart=']);
            return stdout ? stdout.trim() : null;
        }
    } catch (e) {
        return null;
    }
}

// --- Internal Registration Helper ---

async function handleInternalRegistration(args) {
    const { name, purpose, role, pid, childPid, commandId, friendlyName, color, icon, status, skipParentResolution, ideName } = args;

    // F-04 SECURITY: Validate agent name at registration ingress to prevent path traversal
    if (!isValidAgentName(name)) {
        throw new Error(`Rejected registration: invalid agent name '${name}'. Must contain only alphanumeric characters, spaces, dashes, or underscores.`);
    }

    let hostPid = normalizePid(pid);
    let effectiveChildPid = normalizePid(childPid) || hostPid;
    if (!skipParentResolution && !hostPid) {
        throw new Error(`Rejected registration: invalid pid '${pid}'.`);
    }

    if (process.platform === 'win32' && !skipParentResolution) {
        try {
            const registrationPid = hostPid;
            const { stdout: nameStdout } = await execFileAsync(
                'powershell',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    '(Get-Process -Id $args[0]).ProcessName',
                    String(registrationPid)
                ],
                { windowsHide: true }
            );
            const procName = nameStdout.trim().toLowerCase();

            if (procName === 'pwsh' || procName === 'powershell' || procName === 'cmd') {
                const { stdout } = await execFileAsync(
                    'powershell',
                    [
                        '-NoProfile',
                        '-NonInteractive',
                        '-Command',
                        'Get-CimInstance Win32_Process -Filter "ProcessId = $($args[0])" | Select-Object -ExpandProperty ParentProcessId',
                        String(registrationPid)
                    ],
                    { windowsHide: true }
                );
                const parentPid = parseInt(stdout.trim());
                if (!isNaN(parentPid) && parentPid > 0) {
                    hostPid = parentPid;
                    effectiveChildPid = registrationPid;
                    console.error(`[MCP] Resolved Host PID: ${hostPid} for Shell PID: ${registrationPid}`);
                }
            } else {
                console.error(`[MCP] PID ${registrationPid} (${procName}) looks like a host or unknown. Skipping parent resolution.`);
            }
        } catch (e) {
            // Fallback to original pid if parent resolution fails
        }
    }

    let startTime = await getProcessStartTime(hostPid);
    if (!startTime) {
        if (skipParentResolution) {
            startTime = new Date().toISOString();
            console.error(`[MCP] PID ${hostPid} not accessible. Using current time as fallback for external terminal.`);
        } else {
            throw new Error(`PID ${hostPid} is not active or accessible.`);
        }
    }

    await updateState(state => {
        if (!state.terminals) state.terminals = {};
        state.terminals[name] = {
            purpose,
            role: role || state.terminals[name]?.role || 'none', // Preserves existing role if not provided
            pid: hostPid || null,
            childPid: effectiveChildPid || null,
            commandId,
            startTime,
            status: status || 'active',
            friendlyName: friendlyName || name,
            icon: icon || (purpose === 'review' ? 'eye' : (purpose === 'jules' ? 'rocket' : (purpose === 'coding' ? 'code' : 'terminal'))),
            color: color || (purpose === 'review' ? 'orange' : (purpose === 'jules' ? 'purple' : (purpose === 'coding' ? 'blue' : 'cyan'))),
            lastSeen: new Date().toISOString(),
            ideName: args.ideName,
            activeWorkflow: state.terminals[name]?.activeWorkflow || null,
            currentStep: state.terminals[name]?.currentStep || 0,
            activeWorkflowPhase: state.terminals[name]?.activeWorkflowPhase || 0,
            activePersona: state.terminals[name]?.activePersona || null
        };

        if (state.session.provisioningStatus === "WAITING_FOR_PROVISION" && state.session.pendingPurpose === purpose) {
            state.session.provisioningStatus = "PROVISIONED";
            delete state.session.pendingPurpose;
        }

        return state;
    });
    return true;
}

// --- IPC Helpers ---

const pendingIpcInputRequests = new Map();

// Listen for IPC responses from the extension
process.on('message', (message) => {
    if (message && message.type === 'sendToTerminalResponse' && message.id) {
        const { id, success, error } = message;
        const pending = pendingIpcInputRequests.get(id);
        if (pending) {
            pendingIpcInputRequests.delete(id);
            if (success) {
                pending.resolve({
                    content: [{ type: "text", text: `Ã¢Å“â€¦ Sent input to '${pending.name}' (VS Code terminal)` }]
                });
            } else {
                pending.reject(new Error(error || 'Failed to send input to terminal'));
            }
        }
    }
});

async function sendInputViaIpc(name, input, paced = false, source = null) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const inputSource = buildInputSource(source);

    return new Promise((resolve, reject) => {
        pendingIpcInputRequests.set(requestId, { resolve, reject, name });

        const timeout = setTimeout(() => {
            if (pendingIpcInputRequests.has(requestId)) {
                pendingIpcInputRequests.delete(requestId);
                reject(new Error("IPC Input Timeout (10s)"));
            }
        }, 10000);

        if (!process.send) {
            clearTimeout(timeout);
            pendingIpcInputRequests.delete(requestId);
            reject(new Error("IPC not available (standalone mode)"));
            return;
        }

        process.send({
            type: 'sendToTerminal',
            id: requestId,
            name,
            input,
            paced,
            source: inputSource
        });
    });
}

function buildInputSource(source = null) {
    const now = new Date().toISOString();
    const fallbackActor = process.env.SWITCHBOARD_AGENT_NAME || process.env.SWITCHBOARD_SENDER || 'mcp-server';
    const fallback = {
        actor: fallbackActor,
        tool: 'run_in_terminal',
        pid: process.pid,
        createdAt: now,
        allowBroadcast: false
    };

    if (!source || typeof source !== 'object') {
        return fallback;
    }

    const actor = typeof source.actor === 'string' && source.actor.trim()
        ? source.actor.trim()
        : fallback.actor;
    const tool = typeof source.tool === 'string' && source.tool.trim()
        ? source.tool.trim()
        : fallback.tool;
    const allowBroadcast = source.allowBroadcast === true;

    return {
        actor,
        tool,
        pid: Number.isFinite(source.pid) ? source.pid : process.pid,
        createdAt: typeof source.createdAt === 'string' && source.createdAt.trim() ? source.createdAt.trim() : now,
        allowBroadcast,
        messageId: typeof source.messageId === 'string' ? source.messageId : undefined,
        action: typeof source.action === 'string' ? source.action : undefined,
        workflow: typeof source.workflow === 'string' ? source.workflow : undefined
    };
}

function buildTerminalDirectMessage(message) {
    // Deliver only the payload to the terminal — no protocol headers.
    // Metadata (action, sender, id, persona, guardrail) is preserved in the
    // JSON message object for auditing and is not needed by the receiving agent.
    return message.payload || '';
}

async function pushMessageToTerminal(name, message, paced = true) {
    const input = buildTerminalDirectMessage(message);
    const source = {
        actor: message?.sender || 'mcp-server',
        tool: 'pushMessageToTerminal',
        messageId: message?.id,
        action: message?.action,
        allowBroadcast: false
    };

    try {
        if (!process.send) {
            return {
                delivered: false,
                route: 'ipc',
                error: 'IPC transport required: bridge fallback has been removed.'
            };
        }

        await sendInputViaIpc(name, input, paced, source);
        return { delivered: true, route: 'ipc' };
    } catch (e) {
        return {
            delivered: false,
            route: 'ipc',
            error: e?.message || String(e)
        };
    }
}

// ============================================================
// registerTools(server)
// Main factory Ã¢â‚¬â€ registers ALL Switchboard tools on the given McpServer instance.
// ============================================================

function registerTools(server) {
    const { ResourceTemplate } = require("@modelcontextprotocol/sdk/server/mcp.js");
    // Tool: start_workflow
    server.tool(
        "start_workflow",
        {
            name: z.string().min(1),
            initialContext: z.string().optional(),
            targetAgent: z.string().optional().describe("Optional terminal/chat-agent name. If omitted, starts workflow on session."),
            force: z.boolean().optional().describe("If true, forcibly stop any active workflow on the target before starting the new one.")
        },
        async ({ name, initialContext, targetAgent, force }) => {
            const requestedWorkflowName = String(name || '').trim();
            const normalizedWorkflowName = requestedWorkflowName.toLowerCase().replace(/[_\s]+/g, '-');
            const workflowAliases = {
                'jules-plan': 'julesplan',
                'remote-plan': 'julesplan',
                'switchboard': 'chat',
                'quick-start': 'chat'
            };
            let workflowName = workflowAliases[normalizedWorkflowName] || normalizedWorkflowName;
            let workflowDef = getWorkflow(workflowName);

            if (!workflowDef) {
                const workspaceRoot = getWorkspaceRoot();
                const declaredWorkflowMd = path.join(workspaceRoot, '.agent', 'workflows', `${workflowName}.md`);
                if (fs.existsSync(declaredWorkflowMd)) {
                    return {
                        isError: true,
                        content: [{
                            type: "text",
                            text: `STALE_RUNTIME: Workflow '${workflowName}' exists at '.agent/workflows/${workflowName}.md' but is missing from runtime registry. Restart MCP server and verify it is loading the updated workspace server script.`
                        }]
                    };
                }
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: `ERROR: Unknown workflow: ${requestedWorkflowName}. Available workflows: ${Object.keys(WORKFLOWS).join(', ')}`
                    }]
                };
            }

            let rejection = null;
            let targetLabel = targetAgent ? `agent '${targetAgent}'` : 'session';
            let forcedStopWorkflow = null;
            let autoDetectedPlanPath = null;

            await updateState((current) => {
                const target = resolveWorkflowTarget(current, targetAgent);
                if (!target) {
                    rejection = `ERROR: Unknown targetAgent '${targetAgent}'. Must be a registered terminal or chat agent.`;
                    return current;
                }

                targetLabel = target.kind === 'session' ? 'session' : `agent '${target.name}'`;
                const active = target.node.activeWorkflow;
                if (active) {
                    const activeDef = getWorkflow(active);
                    const activeStep = Number(target.node.currentStep || 0);
                    const activePhase = Number(target.node.activeWorkflowPhase || 0);
                    const totalSteps = Number(activeDef?.steps?.length || 0);
                    const staleCompletedLock =
                        (totalSteps > 0 && activeStep >= totalSteps) ||
                        activePhase >= 3;

                    if (staleCompletedLock) {
                        target.node.activeWorkflow = null;
                        target.node.activePersona = null;
                        target.node.currentStep = 0;
                        target.node.activeWorkflowPhase = 0;
                    }
                }

                const activeAfterStaleCleanup = target.node.activeWorkflow;
                if (activeAfterStaleCleanup) {
                    const activeStep = Number(target.node.currentStep || 0);
                    const activeTotalSteps = Number(getWorkflow(activeAfterStaleCleanup)?.steps?.length || 0);
                    const activeInProgress = activeTotalSteps > 0 && activeStep < activeTotalSteps;
                    if (force === true && activeAfterStaleCleanup === 'autoplan' && workflowName !== 'autoplan' && activeInProgress) {
                        rejection = `WORKFLOW SAFETY BLOCK: Cannot force-switch from in-progress 'autoplan' on ${targetLabel} at step ${activeStep}/${activeTotalSteps}. ` +
                            `Treat the next user reply as autoplan idea payload, or stop explicitly with stop_workflow(reason: "Autoplan abort: ...").`;
                        return current;
                    }

                    if (force === true) {
                        forcedStopWorkflow = activeAfterStaleCleanup;
                        target.node.activeWorkflow = null;
                        target.node.activePersona = null;
                        target.node.currentStep = 0;
                        target.node.activeWorkflowPhase = 0;
                        if (target.kind === 'session') {
                            target.node.status = "IDLE";
                            target.node.endTime = new Date().toISOString();
                            target.node.lastOutcome = `Force-stopped workflow '${activeAfterStaleCleanup}' before starting '${workflowName}'.`;
                        }
                    }

                    if (target.node.activeWorkflow) {
                        const step = target.node.currentStep || 0;
                        const totalSteps = getWorkflow(activeAfterStaleCleanup)?.steps?.length || '?';
                        rejection = `WORKFLOW LOCK: Cannot start '${workflowName}' on ${targetLabel} because '${activeAfterStaleCleanup}' is active at step ${step}/${totalSteps}. Stop it first with stop_workflow() or retry with force=true.\n\nTip: Use force=true to auto-replace the stale workflow and continue.`;
                        return current;
                    }
                }

                const now = new Date().toISOString();
                let normalizedInitialContext = typeof initialContext === 'string' ? initialContext : '';

                if (target.kind === 'session') {
                    target.node.id = `sess_${Date.now()}`;
                    target.node.status = "IN_PROGRESS";
                    target.node.startTime = now;
                } else {
                    target.node.workflowStartTime = now;
                }
                // Always reset workflow start context unless explicitly provided.
                // This prevents stale command payload reuse between autoplan invocations.
                target.node.initialContext = normalizedInitialContext;

                target.node.activeWorkflow = workflowName;
                target.node.activePersona = workflowDef.persona;
                target.node.currentStep = 0;
                target.node.activeWorkflowPhase = 0;
                target.node.workflowToolInvocations = [];
                return current;
            });

            if (rejection) {
                return { isError: true, content: [{ type: "text", text: rejection }] };
            }

            await appendWorkflowAuditEvent('workflow_event', {
                action: 'start_workflow',
                workflow: workflowName,
                target: targetLabel,
                forcedStopWorkflow: forcedStopWorkflow || null
            });

            return {
                content: [{
                    type: "text",
                    text: `${forcedStopWorkflow ? `Force-stopped '${forcedStopWorkflow}' on ${targetLabel}.\n` : ''}Started workflow '${workflowDef.name}' on ${targetLabel}.\nPersona: ${workflowDef.persona}\nStep 1: ${workflowDef.steps[0].instruction}${autoDetectedPlanPath ? `\n\nAuto-detected plan: ${autoDetectedPlanPath}\nYou may skip Phase 1 (staging) and proceed directly to dispatch. Use this path as the review scope in your send_message payload.` : ''}`
                }]
            };
        }
    );

    // Tool: get_workflow_state
    server.tool(
        "get_workflow_state",
        {},
        async () => {
            const state = await loadState();
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(state, null, 2)
                }]
            };
        }
    );
    // Tool: stop_workflow
    server.tool(
        "stop_workflow",
        {
            reason: z.string().optional().describe("Outcome or reason for stopping the workflow (e.g., 'Completed', 'Cancelled')"),
            targetAgent: z.string().optional().describe("Optional terminal/chat-agent name. If omitted, stops session workflow.")
        },
        async ({ reason, targetAgent }) => {
            let rejection = null;
            let prevWorkflow = null;
            let targetLabel = targetAgent ? `agent '${targetAgent}'` : 'session';
            const AUTOPLAN_ABORT_REASON_RE = /\b(abort|aborted|cancel|cancelled|canceled|fail|failed|error|timeout|timed\s*out|halt|missing|recovery|unexpected|blocked)\b/i;
            const AUTOPLAN_BYPASS_REASON_RE = /\b(continue|resume|switch|implementation|unlock|bypass|clear\s*lock|workaround)\b/i;
            const AUTOPLAN_EXPLICIT_ABORT_RE = /^\s*autoplan\s+abort\s*:/i;
            const AUTOPLAN_EXPLICIT_ABORT_ALT_RE = /\b(abort|cancel|cancelled|canceled|halt|stop)\s+autoplan\b/i;

            await updateState(current => {
                const target = resolveWorkflowTarget(current, targetAgent);
                if (!target) {
                    rejection = `ERROR: Unknown targetAgent '${targetAgent}'. Must be a registered terminal or chat agent.`;
                    return current;
                }

                targetLabel = target.kind === 'session' ? 'session' : `agent '${target.name}'`;
                prevWorkflow = target.node.activeWorkflow;
                if (!prevWorkflow) {
                    rejection = `ERROR: No active workflow to stop on ${targetLabel}.`;
                    return current;
                }

                const currentStep = Number(target.node.currentStep || 0);
                const totalSteps = Number(getWorkflow(prevWorkflow)?.steps?.length || 0);
                const isInProgress = totalSteps > 0 && currentStep < totalSteps;

                if (prevWorkflow === 'autoplan' && isInProgress) {
                    const hasExplicitAbortMarker = !!reason &&
                        (AUTOPLAN_EXPLICIT_ABORT_RE.test(reason) || AUTOPLAN_EXPLICIT_ABORT_ALT_RE.test(reason));
                    if (!reason || !hasExplicitAbortMarker || !AUTOPLAN_ABORT_REASON_RE.test(reason) || AUTOPLAN_BYPASS_REASON_RE.test(reason)) {
                        rejection = `WORKFLOW SAFETY BLOCK: Refusing to stop in-progress 'autoplan' at step ${currentStep}/${totalSteps} without an explicit abort/failure reason. ` +
                            `Do not use stop_workflow to bypass phase locks. Use an explicit reason prefix (e.g., "Autoplan abort: missing dependency") and report the failure artifact.`;
                        return current;
                    }
                }

                target.node.activeWorkflow = null;
                target.node.activePersona = null;
                target.node.currentStep = 0;
                target.node.activeWorkflowPhase = 0;
                target.node.endTime = new Date().toISOString();
                if (reason) target.node.lastOutcome = reason;

                if (target.kind === 'session') {
                    const resumed = popSuspendedSessionWorkflow(target.node);
                    if (resumed?.workflow) {
                        target.node.activeWorkflow = resumed.workflow;
                        target.node.activePersona = resumed.activePersona || getWorkflow(resumed.workflow)?.persona || null;
                        target.node.currentStep = Number.isFinite(resumed.currentStep) ? resumed.currentStep : 0;
                        target.node.activeWorkflowPhase = Number.isFinite(resumed.activeWorkflowPhase)
                            ? resumed.activeWorkflowPhase
                            : target.node.currentStep;
                        target.node.workflowToolInvocations = Array.isArray(resumed.workflowToolInvocations)
                            ? [...resumed.workflowToolInvocations]
                            : [];
                        target.node.startTime = resumed.startTime || new Date().toISOString();
                        target.node.status = "IN_PROGRESS";
                    } else {
                        target.node.status = "IDLE";
                    }
                }

                return current;
            });

            if (rejection) {
                return { isError: true, content: [{ type: "text", text: rejection }] };
            }

            await appendWorkflowAuditEvent('workflow_event', {
                action: 'stop_workflow',
                workflow: prevWorkflow,
                target: targetLabel,
                reason: reason || 'Not specified'
            });

            return {
                content: [{
                    type: "text",
                    text: `Stopped workflow '${prevWorkflow}' on ${targetLabel}.\nStatus: IDLE\nReason: ${reason || 'Not specified'}`
                }]
            };
        }
    );

    // Tool: run_in_terminal
    server.tool(
        "run_in_terminal",
        {
            name: z.string().describe("ID of the terminal to send input to"),
            input: z.string().describe("The string to send to stdin (automatically appends newline)")
        },
        async ({ name, input }) => {
            try {
                const state = await loadState();
                const senderContext = getSenderWorkflowContext(state);
                const senderCurrentStep = senderContext.scope === 'agent'
                    ? (state.terminals?.[senderContext.senderName]?.currentStep || state.chatAgents?.[senderContext.senderName]?.currentStep || 0)
                    : (state.session?.currentStep || 0);
                if (senderContext.activeWorkflow === 'autoplan' && senderCurrentStep < 1) {
                    return {
                        isError: true,
                        content: [{
                            type: "text",
                            text: "❌ WORKFLOW VIOLATION: run_in_terminal is blocked during autoplan Phase 1 (Collect Idea). Ask the user for the idea and complete phase 1 first."
                        }]
                    };
                }

                // Persona tool gate — blocks prohibited tools for the active workflow persona
                const personaError = checkPersonaToolGate(senderContext.activeWorkflow, 'run_in_terminal');
                if (personaError) {
                    return { isError: true, content: [{ type: "text", text: personaError }] };
                }

                const source = {
                    actor: process.env.SWITCHBOARD_AGENT_NAME || process.env.SWITCHBOARD_SENDER || 'mcp-server',
                    tool: 'run_in_terminal',
                    allowBroadcast: false
                };
                if (!process.send) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: "❌ IPC transport required: run_in_terminal is only available when launched by the extension." }]
                    };
                }
                const result = await sendInputViaIpc(name, input, false, source);

                // Log successful invocation for workflow sanity checks
                if (!result.isError) {
                    try {
                        const senderName = senderContext.senderName;
                        await updateState(current => {
                            const node = resolveNodeForSenderEvidence(current, senderName);
                            appendWorkflowToolInvocation(node, 'run_in_terminal');
                            return current;
                        });
                    } catch {
                        // Non-fatal: best-effort invocation logging
                    }
                }
                return result;
            } catch (e) {
                return { isError: true, content: [{ type: "text", text: `Ã¢ Å’ Error: ${e.message}` }] };
            }
        }
    );

    // Tool: get_team_roster (unified discovery Ã¢â‚¬â€ replaces list_active_terminals, list_chat_agents, get_teams, list_agents)
    server.tool(
        "get_team_roster",
        {},
        async () => {
            const state = await loadState();
            const terminals = state.terminals || {};
            const chatAgents = state.chatAgents || {};
            const teams = state.teams || {};
            const roster = {};

            // Include ALL registered terminals (not just role-assigned ones)
            for (const [name, data] of Object.entries(terminals)) {
                roster[name] = {
                    type: 'terminal',
                    role: data.role || 'none',
                    purpose: data.purpose,
                    status: data.statusState || data.status || 'active',
                    statusMessage: data.statusMessage || null,
                    activeWorkflow: data.activeWorkflow || null,
                    friendlyName: data.friendlyName || name,
                    team: data.team || null
                };
            }
            // Include ALL registered chat agents
            for (const [name, data] of Object.entries(chatAgents)) {
                roster[name] = {
                    type: 'chat',
                    role: data.role || 'none',
                    interface: data.interface,
                    status: data.status || 'away',
                    activeWorkflow: data.activeWorkflow || null,
                    friendlyName: data.friendlyName || name,
                    team: data.team || null
                };
            }

            const teamSummary = {};
            for (const [id, team] of Object.entries(teams)) {
                teamSummary[id] = {
                    name: team.name,
                    isComposite: team.isComposite || false,
                    capabilities: team.capabilities || [],
                    memberCount: (team.members || []).length,
                    members: team.members || []
                };
            }

            if (Object.keys(roster).length === 0 && Object.keys(teamSummary).length === 0) {
                return { content: [{ type: "text", text: "Ã°Å¸â€œÂ­ No agents registered and no teams defined. Use the sidebar to register terminals and set up your organization." }] };
            }

            const result = { agents: roster };
            if (Object.keys(teamSummary).length > 0) {
                result.teams = teamSummary;
            }
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
    );

    // Tool: handoff_clipboard
    server.tool(
        "handoff_clipboard",
        { file: z.string() },
        async ({ file }) => {
            const workspaceRoot = getWorkspaceRoot();
            const resolved = resolveWorkspacePathToken(file, workspaceRoot);
            if (!resolved) {
                return { isError: true, content: [{ type: "text", text: "❌ Invalid file path." }] };
            }

            // F-04: Use path.relative to prevent workspace boundary bypass
            const isSafe = isPathWithinRoot(resolved, workspaceRoot);

            if (!isSafe) {
                return { isError: true, content: [{ type: "text", text: "Ã¢ Å’ Security Error: Cannot read outside workspace." }] };
            }

            if (!fs.existsSync(resolved)) {
                return { isError: true, content: [{ type: "text", text: "Ã¢ Å’ File not found." }] };
            }

            const content = fs.readFileSync(resolved, 'utf8');

            try {
                const cmd = process.platform === 'win32' ? 'clip' : 'pbcopy';
                const child = require('child_process').spawn(cmd, { stdio: ['pipe', 'ignore', 'ignore'] });
                child.stdin.write(content);
                child.stdin.end();
                return { content: [{ type: "text", text: "Ã¢Å“â€¦ Content copied to clipboard (Secure Read)." }] };
            } catch (e) {
                return { isError: true, content: [{ type: "text", text: `Ã¢ Å’ Clipboard failed: ${e.message}` }] };
            }
        }
    );

    // Tool: set_agent_status (unified Ã¢â‚¬â€ replaces set_terminal_status + update_chat_agent_status)
    server.tool(
        "set_agent_status",
        {
            name: z.string().describe("Name of the registered terminal or chat agent"),
            status: z.string().describe("Current status. Terminals: 'working'|'thinking'|'idle'|'error'. Chat agents: 'active'|'away'."),
            message: z.string().optional().describe("Short description (e.g., 'Refactoring utils.ts')")
        },
        async ({ name, status, message }) => {
            // F-03: Validate agent name to prevent arbitrary directory creation
            if (!isValidAgentName(name)) {
                return { isError: true, content: [{ type: "text", text: `❌ Invalid agent name: must contain only alphanumeric characters, dashes, or underscores.` }] };
            }
            const chatLikeStatuses = new Set(['active', 'away', 'planning']);
            const now = new Date().toISOString();
            let updated = false;
            let autoRegisteredChat = false;

            await updateState(current => {
                if (current.terminals && current.terminals[name]) {
                    current.terminals[name].statusState = status;
                    current.terminals[name].statusMessage = message || null;
                    current.terminals[name].statusUpdatedAt = now;
                    updated = true;
                }
                if (current.chatAgents && current.chatAgents[name]) {
                    current.chatAgents[name].status = status;
                    current.chatAgents[name].statusMessage = message || null;
                    current.chatAgents[name].lastSeen = now;
                    updated = true;
                }

                // Resilience: if an agent sets chat-like status before explicit registration,
                // auto-register a minimal chat agent record so it appears in the sidebar immediately.
                if (!updated && chatLikeStatuses.has(status)) {
                    if (!current.chatAgents) current.chatAgents = {};
                    const existing = current.chatAgents[name] || {};
                    current.chatAgents[name] = {
                        type: 'chat',
                        interface: existing.interface || 'unknown',
                        role: existing.role || undefined,
                        status,
                        statusMessage: message || null,
                        activeWorkflow: existing.activeWorkflow || null,
                        currentStep: existing.currentStep || 0,
                        activeWorkflowPhase: existing.activeWorkflowPhase || 0,
                        activePersona: existing.activePersona || null,
                        capabilities: existing.capabilities || ['chat'],
                        friendlyName: existing.friendlyName || name,
                        icon: existing.icon || 'comment-discussion',
                        color: existing.color || 'purple',
                        registeredAt: existing.registeredAt || now,
                        lastSeen: now
                    };
                    if (!current.context || typeof current.context !== 'object') {
                        current.context = {};
                    }
                    if (!current.context.defaultChatAgent) {
                        current.context.defaultChatAgent = name;
                    }
                    updated = true;
                    autoRegisteredChat = true;
                }
                return current;
            });

            if (!updated) {
                return {
                        isError: true,
                        content: [{
                            type: "text",
                            text: `Ã¢ Å’ Agent '${name}' not found in terminals or chat agents. Register it via the Switchboard sidebar, or set a chat-like status first using set_agent_status(name: "${name}", status: "active").`
                        }]
                    };
                }

            if (autoRegisteredChat) {
                const workspaceRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
                const inboxDir = path.join(workspaceRoot, '.switchboard', 'inbox', name);
                if (!fs.existsSync(inboxDir)) {
                    fs.mkdirSync(inboxDir, { recursive: true });
                }
            }

            const label = message ? `${status} Ã¢â‚¬â€ ${message}` : status;
            const autoNote = autoRegisteredChat ? " (auto-registered chat agent)" : "";
            return { content: [{ type: "text", text: `Ã¢Å“â€¦ Agent '${name}' status: ${label}${autoNote}` }] };
        }
    );


    // Tool: send_message
    server.tool(
        "send_message",
        {
            // Recipient REMOVED - always auto-routed
            action: z.enum(['delegate_task', 'execute']).describe("Message action type"),
            payload: z.string().describe("Message content (task description, review request, result summary, etc.)"),
            metadata: z.object({
                phase_gate: PhaseGateSchema.optional()
            }).catchall(z.unknown()).optional().describe("Optional key-value metadata. phase_gate can enforce resume mode (phase/authorized_plan/enforce_persona).")
        },
        async ({ action, payload, metadata }) => {
            try {
                const workspaceRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
                const state = await loadState();
                const envSender = sanitizePathToken(process.env.SWITCHBOARD_AGENT_NAME || process.env.SWITCHBOARD_SENDER);
                const inferredEnvSender = envSender ? (resolveAgentName(state, envSender) || envSender) : null;

                // --- 1. SENDER RESOLUTION ---
                let senderName = inferredEnvSender;

                // Use temp sender name if not provided to resolve context, will refine later
                const tempSenderContext = getSenderWorkflowContext(state, senderName);

                if (!senderName && tempSenderContext.senderName) {
                    senderName = tempSenderContext.senderName;
                }
                if (!senderName) {
                    senderName = 'orchestrator';
                }

                // --- 2. RECIPIENT RESOLUTION & ROUTING ---
                let recipient = null;
                let dispatchMeta = null;
                let senderActiveWorkflow = tempSenderContext.activeWorkflow;
                let routingDecision = null;

                // CASE 1: Delegation actions (execute, delegate_task)
                if (['execute', 'delegate_task'].includes(action)) {
                    const activeWorkflow = tempSenderContext.activeWorkflow;
                    senderActiveWorkflow = activeWorkflow;

                    if (!activeWorkflow) {
                        return { isError: true, content: [{ type: "text", text: `âŒ No active workflow. Action '${action}' requires a workflow context. Call start_workflow() first.` }] };
                    }

                    const routingKey = WORKFLOW_ACTION_ROUTING[activeWorkflow];
                    if (!routingKey || !routingKey[action]) {
                        const validActions = routingKey ? Object.keys(routingKey) : [];
                        const validActionsText = validActions.length > 0
                            ? `Valid actions for '${activeWorkflow}': [${validActions.map(a => `'${a}'`).join(', ')}].`
                            : 'This workflow does not support cross-agent delegation.';
                        return { isError: true, content: [{ type: "text", text: `âŒ Action '${action}' is not valid for workflow '${activeWorkflow}'. ${validActionsText}\n\nDid you mean action: '${validActions[0] || 'execute'}'?` }] };
                    }

                    const requiredRole = routingKey[action];
                    // Map role to canonical recipient (simple for now)
                    recipient = CANONICAL_ROLE_TO_INBOX[requiredRole] || requiredRole;

                    // Special Case: Lead Handoff needs to dispatch immediately in Step 1
                    if (activeWorkflow === 'handoff-lead' && action === 'delegate_task') {
                        recipient = 'lead-coder';
                    }

                    const supportsPlannerReviewRouting =
                        action === 'execute' &&
                        activeWorkflow === 'autoplan';
                    if (supportsPlannerReviewRouting) {
                        const planIntent = isPlanReviewIntent(payload, metadata, workspaceRoot);
                        const defaultRecipient = recipient;

                        if (planIntent.isPlan) {
                            const plannerRecipient = findPreferredRoleRecipient(state, 'planner');
                            if (plannerRecipient) {
                                recipient = plannerRecipient;
                                routingDecision = {
                                    selected: plannerRecipient,
                                    default: defaultRecipient,
                                    overridden: plannerRecipient !== defaultRecipient,
                                    reason: planIntent.reason,
                                    plan_path: planIntent.planPath || undefined,
                                    fallback: null
                                };
                            } else {
                                routingDecision = {
                                    selected: defaultRecipient,
                                    default: defaultRecipient,
                                    overridden: false,
                                    reason: planIntent.reason,
                                    plan_path: planIntent.planPath || undefined,
                                    fallback: 'planner_unavailable'
                                };
                            }
                        } else {
                            routingDecision = {
                                selected: defaultRecipient,
                                default: defaultRecipient,
                                overridden: false,
                                reason: planIntent.reason,
                                fallback: null
                            };
                        }
                    }
                }

                // At this point, recipient is resolved.
                if (!recipient) {
                    return { isError: true, content: [{ type: "text", text: `âŒ Internal error: recipient resolution failed for action '${action}'.` }] };
                }

                const effectiveRecipient = recipient;

                // --- 3. VALIDATION ---
                // GATE: Validate recipient exists (individual agent)
                // Keep execute permissive: attempt delivery even if recipient is not
                // currently registered in MCP state. Users can target terminal names
                // directly and the extension may recover from live terminal list.
                const bypassRecipientValidation =
                    action === 'execute' ||
                    CANONICAL_INBOX_RECIPIENTS.has(effectiveRecipient);
                const recipientError = bypassRecipientValidation
                    ? null
                    : await validateRecipient(effectiveRecipient, state);
                if (recipientError) {
                    return { isError: true, content: [{ type: "text", text: `Ã¢ Å’ REJECTED: ${recipientError}` }] };
                }

                // Resolve the actual agent name
                const resolvedRecipient = resolveAgentName(state, effectiveRecipient) || effectiveRecipient;
                if (!isValidAgentName(resolvedRecipient)) {
                    return { isError: true, content: [{ type: "text", text: `❌ Invalid recipient name: must contain only alphanumeric characters, spaces, dashes, or underscores.` }] };
                }
                if (routingDecision) {
                    routingDecision.selected = resolvedRecipient;
                    routingDecision.default = resolveAgentName(state, routingDecision.default) || routingDecision.default;
                }

                // GATE: Enforce workflow requirement for this action
                const workflowError = await enforceWorkflowForAction(action, state, senderName, resolvedRecipient, payload, metadata);
                if (workflowError) {
                    return { isError: true, content: [{ type: "text", text: `Ã¢ Å’ WORKFLOW VIOLATION: ${workflowError}` }] };
                }

                // GATE: Check cooldown for dispatch actions (unless opted out)
                const shouldCheckCooldown = ['delegate_task', 'execute', 'request_review'].includes(action);
                const cooldownOptOut = metadata?.no_cooldown === true;

                if (shouldCheckCooldown && !cooldownOptOut) {
                    const cooldownCheck = checkDispatchCooldown(workspaceRoot, senderName, resolvedRecipient, action);
                    if (cooldownCheck.inCooldown) {
                        return {
                            isError: true,
                            content: [{
                                type: "text",
                                text: `⛔ COOLDOWN ACTIVE: Duplicate ${action} to ${resolvedRecipient} blocked. Wait ${cooldownCheck.remainingSeconds}s before retrying. (Use metadata.no_cooldown: true to override)`
                            }]
                        };
                    }
                }

                // --- 4. EXECUTION ---
                const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const createdAt = new Date().toISOString();
                let persona = null;
                const messageMetadata = (metadata && typeof metadata === 'object')
                    ? { ...metadata }
                    : {};
                if (routingDecision) {
                    messageMetadata.routing = routingDecision;
                }
                const phaseGate = buildPhaseGateForMessage(action, payload, messageMetadata, workspaceRoot);
                if (phaseGate) {
                    messageMetadata.phase_gate = phaseGate;
                }
                const enforcedPersona = dispatchMeta?.phase_gate?.enforce_persona || phaseGate?.enforce_persona;
                persona = resolvePersonaForRecipient(
                    state,
                    resolvedRecipient,
                    enforcedPersona ? { enforcePersona: enforcedPersona } : undefined
                );
                if (action === 'execute' && typeof messageMetadata.paced !== 'boolean') {
                    messageMetadata.paced = senderName !== resolvedRecipient;
                }

                let newDispatchMetadata = null;
                let supersededCount = 0;

                if (['delegate_task', 'execute'].includes(action)) {
                    if (typeof messageMetadata.resumeMode !== 'string') {
                        messageMetadata.resumeMode = 'execute_from_plan_if_present';
                    }

                    newDispatchMetadata = buildDispatchMetadata(messageMetadata, messageId, createdAt, senderName, action);
                    messageMetadata.dispatch = newDispatchMetadata;

                    if (action === 'delegate_task' && newDispatchMetadata.queue_mode !== 'keep') {
                        const superseded = supersedePendingDelegateTasks(workspaceRoot, resolvedRecipient, senderName, messageId, createdAt);
                        supersededCount = superseded.length;
                    }
                    // [REMOVED] writePendingDispatchMeta - Outbox is deprecated.
                    // Tracking now happens purely via the durable message bus (inbox -> archive).

                    // Update global index for reverse lookup
                    await updateState(s => {
                        if (!s.dispatchIndex) s.dispatchIndex = {};
                        s.dispatchIndex[messageId] = senderName;
                        // Clean up old entries? Maybe lazily.
                        return s;
                    });
                }

                // Keep payload clean — no persona/guardrail wrapping.
                // Metadata (persona, phase_gate, dispatch) is stored as separate
                // fields on the message object for auditing/tracking.
                const message = {
                    id: messageId,
                    action,
                    sender: senderName,
                    recipient: resolvedRecipient,
                    payload,
                    metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
                    createdAt
                };

                // F-08 SECURITY: Inject session token for dispatch messages
                if (['delegate_task', 'execute'].includes(action)) {
                    try {
                        const currentState = await loadState();
                        if (currentState?.session?.id) {
                            message.sessionToken = currentState.session.id;
                        }
                    } catch { /* state unreadable — omit token */ }

                    const auth = buildDispatchAuthEnvelope(message);
                    if (!auth && isStrictInboxAuthEnabledForDispatch()) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: "❌ Secure dispatch unavailable: signing key is missing. Restart extension runtime." }]
                        };
                    }
                    if (auth) {
                        message.auth = auth;
                    }
                }

                if (persona) {
                    message.persona = persona;
                }

                const shouldPushToTerminal = action === 'execute';
                const pacedResponsePush = typeof messageMetadata.paced === 'boolean'
                    ? messageMetadata.paced
                    : true;
                const terminalPushResult = shouldPushToTerminal
                    ? await pushMessageToTerminal(resolvedRecipient, message, pacedResponsePush)
                    : null;
                const deliveredDirectly = !!(terminalPushResult && terminalPushResult.delivered);

                const targetBox = 'inbox';
                const storageRecipient = resolvedRecipient;
                let filePath = '(direct push only)';
                let routeLabel = deliveredDirectly
                    ? 'terminal direct push (no inbox fallback needed)'
                    : `${targetBox} (durable delivery)`;

                // Only persist inbox fallback when direct terminal push fails (or is not attempted).
                // This prevents duplicate execution of the same execute payload by InboxWatcher.
                if (!deliveredDirectly) {
                    // F-04 SECURITY: Validate recipient name before using as path segment
                    if (!isValidAgentName(storageRecipient)) {
                        return { isError: true, content: [{ type: "text", text: `❌ Invalid recipient name for inbox write: must contain only alphanumeric characters, spaces, dashes, or underscores.` }] };
                    }
                    const targetDir = path.join(workspaceRoot, '.switchboard', targetBox, storageRecipient);
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                    filePath = path.join(targetDir, `${messageId}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(message, null, 2));
                }

                const terminalPushLabel = terminalPushResult
                    ? (terminalPushResult.delivered
                        ? ` + terminal direct push (${terminalPushResult.route})`
                        : ` + terminal direct push failed (${terminalPushResult.route})`)
                    : '';
                await updateState(current => {
                    const node = resolveNodeForSenderEvidence(current, senderName);
                    appendWorkflowToolInvocation(node, 'send_message');
                    return current;
                });
                const freshnessNote = supersededCount > 0
                    ? `\nSuperseded stale delegate_task backlog: ${supersededCount} message(s) archived.`
                    : '';
                const pushFailureNote = terminalPushResult && !terminalPushResult.delivered
                    ? `\nTerminal push failure (durable outbox fallback retained): ${terminalPushResult.error}`
                    : '';
                const routingNote = routingDecision
                    ? `\nRouting: selected=${routingDecision.selected}; default=${routingDecision.default}; reason=${routingDecision.reason}${routingDecision.fallback ? `; fallback=${routingDecision.fallback}` : ''}${routingDecision.overridden ? '; override=planner' : ''}`
                    : '';
                return {
                    content: [{
                        type: "text",
                        text: `Ã¢Å“â€¦ Message sent to '${storageRecipient}' via ${routeLabel}${terminalPushLabel}\nÃ°Å¸â€œÂ¨ ID: ${messageId}\nÃ°Å¸â€œâ€¹ Action: ${action}\nÃ°Å¸â€œ  Path: ${filePath}${routingNote}${freshnessNote}${pushFailureNote}`
                    }]
                };
            } catch (e) {
                return { isError: true, content: [{ type: "text", text: `Ã¢ Å’ Failed to send message: ${e.message}` }] };
            }
        }
    );

    // Tool: check_inbox (with validation logging for malformed JSON Ã¢â‚¬â€ Phase 1 improvement)
    server.tool(
        "check_inbox",
        {
            agent: z.string().describe("Agent name whose messages to check"),
            box: z.enum(['inbox', 'outbox']).default('outbox').describe("Which box to check (inbox = pending messages, outbox = delivered/results)"),
            filter: z.enum(['all', 'delegate_task', 'execute']).optional().describe("Filter by action type"),
            limit: z.number().optional().describe("Max messages to return (default 20)"),
            verbose: z.boolean().optional().describe("If true, return full message payloads. Default: truncated summaries to save tokens."),
            since: z.string().optional().describe("Optional ISO timestamp. If set, only messages created at/after this timestamp are returned.")
        },
        async ({ agent, box, filter, limit, verbose, since }) => {
            try {
                // F-02: Validate agent name to prevent path traversal
                if (!isValidAgentName(agent)) {
                    return { isError: true, content: [{ type: "text", text: `❌ Invalid agent name: must contain only alphanumeric characters, dashes, or underscores.` }] };
                }
                const workspaceRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT || process.cwd();
                const state = await loadState();
                await updateState(current => {
                    const node = resolveNodeForAgentEvidence(current, agent);
                    appendWorkflowToolInvocation(node, 'check_inbox');
                    return current;
                });
                const requestedBox = box || 'outbox';
                const isInboxRequest = requestedBox === 'inbox';
                const agentRecord = state.chatAgents?.[agent] || state.terminals?.[agent];
                const canonicalInboxAgent = isInboxRequest ? getCanonicalInboxForAgent(state, agent) : null;
                const storageAgent = canonicalInboxAgent || agent;
                const targetDir = path.join(workspaceRoot, '.switchboard', requestedBox, storageAgent);

                let effectiveSince = since;

                const sinceMs = effectiveSince ? Date.parse(effectiveSince) : NaN;
                const hasSince = Number.isFinite(sinceMs);

                if (!fs.existsSync(targetDir)) {
                    return {
                        content: [{
                            type: "text",
                            text: `Ã°Å¸â€œÂ­ No ${requestedBox} found for '${agent}'. No messages.`
                        }]
                    };
                }

                const files = fs.readdirSync(targetDir)
                    .filter(f => f.endsWith('.json') && !f.endsWith('.result.json') && !f.endsWith('.receipt.json'))
                    .sort();

                const maxMessages = limit || 20;
                let messages = [];
                const malformed = [];
                let staleExpiredReviews = 0;
                let staleSupersededReviews = 0;
                const filesToInspect = files.slice(-maxMessages);

                for (const file of filesToInspect) {
                    try {
                        const content = JSON.parse(fs.readFileSync(path.join(targetDir, file), 'utf8'));
                        if (filter && filter !== 'all' && content.action !== filter) continue;
                        if (hasSince) {
                            const createdAtMs = Date.parse(content.createdAt);
                            if (!Number.isFinite(createdAtMs) || createdAtMs < sinceMs) continue;
                        }
                        messages.push(content);
                        if (messages.length >= maxMessages) break;
                    } catch (parseError) {
                        malformed.push({ file, error: parseError.message });
                        console.error(`[check_inbox] Malformed JSON in ${path.join(targetDir, file)}: ${parseError.message}`);
                    }
                }

                if (isInboxRequest && messages.length > 0) {
                    const nowMs = Date.now();
                    const latestReviewBySender = new Set();
                    const filtered = [];
                    const reviewOrdered = [...messages].sort((a, b) => {
                        const aMs = Date.parse(a?.createdAt || '');
                        const bMs = Date.parse(b?.createdAt || '');
                        const safeA = Number.isFinite(aMs) ? aMs : 0;
                        const safeB = Number.isFinite(bMs) ? bMs : 0;
                        return safeB - safeA;
                    });

                    for (const message of reviewOrdered) {
                        if (message?.action !== 'request_review') {
                            filtered.push(message);
                            continue;
                        }

                        if (isExpiredReviewDispatch(message, nowMs)) {
                            staleExpiredReviews++;
                            continue;
                        }

                        const senderKey = String(message?.sender || 'unknown').trim().toLowerCase();
                        if (latestReviewBySender.has(senderKey)) {
                            staleSupersededReviews++;
                            continue;
                        }
                        latestReviewBySender.add(senderKey);
                        filtered.push(message);
                    }

                    messages = filtered.reverse();
                }

                if (messages.length === 0 && malformed.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: `Ã°Å¸â€œÂ­ No ${filter ? `'${filter}' ` : ''}messages in ${requestedBox} for '${agent}'.`
                        }]
                    };
                }

                const MAX_PAYLOAD_CHARS = 200;
                const output = verbose ? messages : messages.map(m => ({
                    id: m.id,
                    action: m.action,
                    sender: m.sender,
                    recipient: m.recipient,
                    replyTo: m.replyTo,
                    createdAt: m.createdAt,
                    payload: m.payload && m.payload.length > MAX_PAYLOAD_CHARS
                        ? m.payload.substring(0, MAX_PAYLOAD_CHARS) + `... (${m.payload.length} chars, use verbose=true for full)`
                        : m.payload
                }));

                let text = `Ã°Å¸â€œÂ¬ ${messages.length} message(s) in ${requestedBox} for '${agent}':\n\n${JSON.stringify(output, null, 2)}`;
                if (hasSince) {
                    text = `Ã°Å¸â€¢â€™ Applied since filter: ${effectiveSince}\n` + text;
                }
                if (malformed.length > 0) {
                    text += `\n\nÃ¢Å¡Â Ã¯Â¸  ${malformed.length} malformed message(s) skipped:\n${malformed.map(m => `  Ã¢â‚¬Â¢ ${m.file}: ${m.error}`).join('\n')}`;
                }
                if (staleExpiredReviews > 0 || staleSupersededReviews > 0) {
                    text += `\n\nIgnored stale review requests: expired=${staleExpiredReviews}, superseded=${staleSupersededReviews}`;
                }

                return { content: [{ type: "text", text }] };
            } catch (e) {
                return { isError: true, content: [{ type: "text", text: `Ã¢ Å’ Failed to check inbox: ${e.message}` }] };
            }
        }
    );

    // Tool: complete_workflow_phase
    server.tool(
        "complete_workflow_phase",
        {
            workflow: z.string().describe("Workflow name (e.g., 'handoff')"),
            phase: z.number().describe("Phase number that was just completed"),
            artifacts: z.array(z.object({
                path: z.string(),
                description: z.string().optional()
            })).optional().describe("Required artifacts to validate before marking phase complete"),
            notes: z.string().optional().describe("Optional notes about this phase completion"),
            skipReason: z.string().optional().describe("If skipping phases, provide an explicit justification here"),
            targetAgent: z.string().optional().describe("Optional terminal/chat-agent name. If omitted, targets session.")
        },
        async ({ workflow, phase, artifacts, notes, skipReason, targetAgent }) => {
            const workspaceRoot = getWorkspaceRoot();
            if (artifacts && artifacts.length > 0) {
                const missing = [];
                for (const artifact of artifacts) {
                    const fullPath = resolveWorkspacePathToken(artifact.path, workspaceRoot);
                    if (!fullPath) {
                        missing.push(artifact.path);
                        continue;
                    }

                    if (!fs.existsSync(fullPath)) {
                        missing.push(artifact.path);
                        continue;
                    }

                    // F-07 SECURITY: Restrict artifact checks to workspace-relative paths
                    // while accepting both relative and absolute inputs after normalization.
                    if (!isPathWithinRoot(fullPath, workspaceRoot)) {
                        missing.push(artifact.path);
                    }
                }

                if (missing.length > 0) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Ã¢ Å’ PHASE ${phase} INCOMPLETE: Missing required artifacts: ${missing.join(', ')}` }]
                    };
                }
            }

            if (!Number.isInteger(phase) || phase < 1) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Ã¢ Å’ PHASE ${phase} REJECTED: Phase must be a positive integer.` }]
                };
            }

            const workflowDef = getWorkflow(workflow);
            if (!workflowDef || !Array.isArray(workflowDef.steps) || workflowDef.steps.length === 0) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Ã¢ Å’ PHASE ${phase} REJECTED: Workflow '${workflow}' has no registered steps.` }]
                };
            }

            const totalSteps = workflowDef.steps.length;
            if (phase > totalSteps) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Ã¢ Å’ PHASE ${phase} REJECTED: Workflow '${workflow}' has ${totalSteps} phase(s).` }]
                };
            }

            const stepIndex = phase - 1;
            const stepDef = workflowDef.steps[stepIndex] || null;
            let requiredTools = [];
            const phaseNotes = typeof notes === 'string' ? notes.trim() : '';
            const autoplanIdeaNotesSatisfied =
                workflow === 'autoplan' &&
                phase === 1 &&
                phaseNotes.length >= 8;
            if (stepDef && stepDef.requiredEvidence && !autoplanIdeaNotesSatisfied) {
                if (!artifacts || artifacts.length === 0) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `âŒ PHASE ${phase} REJECTED: Workflow '${workflow}' step '${stepDef.id}' requires evidence '${stepDef.requiredEvidence}'. You must provide at least one artifact.` }]
                    };
                }
            }
            if (stepDef && Array.isArray(stepDef.requiredTools)) {
                requiredTools = stepDef.requiredTools
                    .filter(tool => typeof tool === 'string')
                    .map(tool => tool.trim())
                    .filter(Boolean);
            }

            const prohibitedTools = Array.isArray(workflowDef.prohibitedTools) ? workflowDef.prohibitedTools : [];
            let rejection = null;
            let targetLabel = targetAgent ? `agent '${targetAgent}'` : 'session';

            try {
                await updateState(current => {
                    const target = resolveWorkflowTarget(current, targetAgent);
                    if (!target) {
                        rejection = `ERROR: Unknown targetAgent '${targetAgent}'. Must be a registered terminal or chat agent.`;
                        return current;
                    }

                    targetLabel = target.kind === 'session' ? 'session' : `agent '${target.name}'`;

                    if (!target.node.activeWorkflow) {
                        rejection = `Ã¢ Å’ PHASE ${phase} REJECTED: No active workflow on ${targetLabel}. Call start_workflow('${workflow}') first.`;
                        return current;
                    }

                    if (target.node.activeWorkflow !== workflow) {
                        rejection = `Ã¢ Å’ PHASE ${phase} REJECTED: Active workflow on ${targetLabel} is '${target.node.activeWorkflow}', not '${workflow}'. Stop the active workflow first.`;
                        return current;
                    }

                    const currentStep = target.node.currentStep || 0;
                    const expectedPhase = currentStep + 1;

                    if (phase <= currentStep) {
                        rejection = `Ã¢ Å’ PHASE ${phase} REJECTED: Already completed (current step: ${currentStep}).`;
                        return current;
                    }

                    if (phase > expectedPhase && !skipReason) {
                        rejection = `Ã¢ Å’ PHASE ${phase} REJECTED: Expected phase ${expectedPhase} (current step: ${currentStep}). To skip, provide a skipReason parameter.`;
                        return current;
                    }

                    if (workflow === 'autoplan' && phase > expectedPhase) {
                        rejection = `Ã¢ Å’ PHASE ${phase} REJECTED: Workflow 'autoplan' does not allow skipping phases. Expected phase ${expectedPhase}.`;
                        return current;
                    }

                    if (workflow === 'autoplan' && phase === 1) {
                        const noteText = typeof notes === 'string' ? notes.trim() : '';
                        if (!noteText || noteText.length < 8) {
                            rejection = `Ã¢ Å’ PHASE 1 REJECTED: Workflow 'autoplan' requires captured idea notes. Call complete_workflow_phase with notes like 'Captured idea: ...'.`;
                            return current;
                        }
                    }

                    const isSkippedJump = phase > expectedPhase && !!skipReason;
                    if (!isSkippedJump && requiredTools.length > 0) {
                        const invocationLog = Array.isArray(target.node.workflowToolInvocations)
                            ? target.node.workflowToolInvocations
                            : [];
                        const missingTools = requiredTools.filter(requiredTool => !invocationLog.some(entry =>
                            entry &&
                            entry.workflow === workflow &&
                            Number(entry.phase) === Number(phase) &&
                            entry.tool === requiredTool
                        ));
                        if (missingTools.length > 0) {
                            const stepId = stepDef?.id || `phase-${phase}`;
                            rejection = `Ã¢ Å’ PHASE ${phase} REJECTED: Workflow '${workflow}' step '${stepId}' is missing required tool evidence: ${missingTools.join(', ')}.`;
                            return current;
                        }
                    }

                    // Sanity check: verify no prohibited tools were called during this phase
                    if (!isSkippedJump && prohibitedTools.length > 0) {
                        const invocationLog = Array.isArray(target.node.workflowToolInvocations)
                            ? target.node.workflowToolInvocations
                            : [];
                        const violations = invocationLog.filter(entry =>
                            entry &&
                            entry.workflow === workflow &&
                            Number(entry.phase) === Number(phase) &&
                            prohibitedTools.includes(entry.tool)
                        );
                        if (violations.length > 0) {
                            const stepId = stepDef?.id || `phase-${phase}`;
                            const violatedTools = [...new Set(violations.map(v => v.tool))].join(', ');
                            rejection = `\u274C PHASE ${phase} REJECTED: Persona violation in '${workflow}' step '${stepId}'. Prohibited tool(s) called: ${violatedTools}. These tools are not permitted under the active persona.`;
                            return current;
                        }
                    }

                    if (target.kind === 'session' && target.node.provisioningStatus === "WAITING_FOR_PROVISION") {
                        rejection = `Ã¢ Å’ PHASE ${phase} INCOMPLETE: You MUST provision and register a '${target.node.pendingPurpose}' terminal first.`;
                        return current;
                    }

                    if (!target.node.completedPhases) {
                        target.node.completedPhases = {};
                    }
                    if (!target.node.completedPhases[workflow]) {
                        target.node.completedPhases[workflow] = [];
                    }

                    target.node.completedPhases[workflow].push({
                        phase,
                        completedAt: new Date().toISOString(),
                        notes: notes || "",
                        skipped: skipReason ? { from: expectedPhase, reason: skipReason } : undefined
                    });

                    // Persist artifact paths for cross-workflow discovery
                    if (artifacts && artifacts.length > 0) {
                        if (!current.lastCompletedArtifacts) {
                            current.lastCompletedArtifacts = {};
                        }
                        current.lastCompletedArtifacts[workflow] = {
                            phase,
                            completedAt: new Date().toISOString(),
                            artifacts: artifacts.map(a => ({ path: a.path, description: a.description || '' }))
                        };
                    }

                    target.node.currentStep = phase;
                    target.node.activeWorkflowPhase = phase;
                    return current;
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[complete_workflow_phase] Failed while persisting phase ${phase} for workflow '${workflow}': ${message}`);
                return {
                    isError: true,
                    content: [{ type: "text", text: `Ã¢ Å’ PHASE ${phase} FAILED: Could not update workflow state (${message}).` }]
                };
            }

            if (rejection) {
                return { isError: true, content: [{ type: "text", text: rejection }] };
            }

            const artifactCount = artifacts ? artifacts.length : 0;
            const artifactText = artifactCount > 0 ? ` (${artifactCount} artifacts validated)` : "";
            const notesText = notes ? `\nÃ°Å¸â€œ  Notes: ${notes}` : "";
            const skipText = skipReason ? `\nÃ¢ Â­Ã¯Â¸  Skip: ${skipReason}` : "";

            // AUTO-STOP LOGIC: If this is the final phase, automatically close the workflow
            let autoStopText = "";
            console.error(`[complete_workflow_phase] Check Auto-Stop: Phase ${phase} / ${totalSteps} (Workflow: ${workflow})`);

            if (workflowDef && phase >= totalSteps) {
                console.error(`[complete_workflow_phase] Triggering Auto-Stop for '${workflow}' on ${targetLabel}`);
                try {
                    await updateState(current => {
                        const target = resolveWorkflowTarget(current, targetAgent);
                        if (target) {
                            target.node.activeWorkflow = null;
                            target.node.activeWorkflowPhase = 0;

                            if (target.kind === 'session') {
                                const resumed = popSuspendedSessionWorkflow(target.node);
                                if (resumed?.workflow) {
                                    target.node.activeWorkflow = resumed.workflow;
                                    target.node.activePersona = resumed.activePersona || getWorkflow(resumed.workflow)?.persona || null;
                                    target.node.currentStep = Number.isFinite(resumed.currentStep) ? resumed.currentStep : 0;
                                    target.node.activeWorkflowPhase = Number.isFinite(resumed.activeWorkflowPhase)
                                        ? resumed.activeWorkflowPhase
                                        : target.node.currentStep;
                                    target.node.workflowToolInvocations = Array.isArray(resumed.workflowToolInvocations)
                                        ? [...resumed.workflowToolInvocations]
                                        : [];
                                    target.node.startTime = resumed.startTime || new Date().toISOString();
                                    target.node.status = "IN_PROGRESS";
                                } else {
                                    target.node.status = "IDLE";
                                }
                            }
                            target.node.endTime = new Date().toISOString();
                            target.node.lastOutcome = `Completed ${workflow}`;
                        }
                        return current;
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(`[complete_workflow_phase] Auto-stop failed for workflow '${workflow}' on ${targetLabel}: ${message}`);
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Ã¢ Å’ PHASE ${phase} FAILED: Auto-stop could not update workflow state (${message}).` }]
                    };
                }
                autoStopText = " (Workflow Auto-Stopped)";
            } else {
                console.error(`[complete_workflow_phase] Auto-Stop NOT Triggered: ${phase} < ${totalSteps}`);
            }

            await appendWorkflowAuditEvent('workflow_event', {
                action: 'complete_workflow_phase',
                workflow,
                phase,
                target: targetLabel,
                artifacts: Array.isArray(artifacts) ? artifacts.map(a => ({ path: a.path, description: a.description || '' })) : [],
                autoStopped: workflowDef && phase >= totalSteps
            });

            return {
                content: [{
                    type: "text",
                    text: `Ã¢Å“â€¦ PHASE ${phase} COMPLETE: ${workflow}${artifactText}${notesText}${skipText}${autoStopText}`
                }]
            };
        }
    );

    // --- Resources ---
    server.resource(
        "switchboard://active-rules",
        new ResourceTemplate("switchboard://active-rules", { list: undefined }),
        async (uri, { request }) => {
            const state = await loadState();
            const activeWorkflow = state.session.activeWorkflow;
            const wf = getWorkflow(activeWorkflow);

            if (!wf) {
                return {
                    contents: [{
                        uri: uri.href,
                        text: "No active workflow. You are in standard assistance mode."
                    }]
                };
            }

            // Build structured protocol anchor for the active persona
            const protocolLines = [];
            if (wf.ephemeral) {
                protocolLines.push(wf.ephemeral);
            } else {
                protocolLines.push(`[PROTOCOL STATUS: ${activeWorkflow.toUpperCase()} WORKFLOW ACTIVE]`);
            }
            if (Array.isArray(wf.prohibitedTools) && wf.prohibitedTools.length > 0) {
                protocolLines.push(`[RESTRICTED MCP TOOLS: ${wf.prohibitedTools.join(', ')}]`);
            }
            protocolLines.push('');
            protocolLines.push(wf.persona);

            return {
                contents: [{
                    uri: uri.href,
                    text: protocolLines.join('\n')
                }]
            };
        }
    );

}

module.exports = {
    registerTools,
    enforceWorkflowForAction,
    isBrainLeakage,
    validateRecipient,
    handleInternalRegistration
};


