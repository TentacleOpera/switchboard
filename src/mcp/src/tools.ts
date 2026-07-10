// Curated MCP tools mapping 1:1 to Switchboard LocalApiServer endpoints.
//
// Hybrid granularity: ~14 hand-schema'd core verbs (good Desktop UX — the
// catalog carries zero payload schemas, so auto-generated tools would have
// empty input schemas) plus one generic switchboard_request passthrough for
// the long tail and future endpoints. Read endpoints unwrap .data; mutations
// return {success, ...fields} verbatim.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { call, type CallOptions, type CallSuccess, type SwitchboardError } from './bootstrap.js';
import { MUTATING_RULES } from './persona.js';

export interface ToolContext {
    workspaceRoot: string;
    token: string | null;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: any): ToolResult {
    const payload = data === null ? { success: true } : data;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text', text }] };
}

function err(e: SwitchboardError): ToolResult {
    const body = { error: e.error, code: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

/** Convert a call() result into a ToolResult. */
function toResult(r: CallSuccess | SwitchboardError): ToolResult {
    if ('ok' in r) return ok(r.data);
    return err(r);
}

/** Read endpoints unwrap .data; mutations return the body verbatim. */
function toReadResult(r: CallSuccess | SwitchboardError): ToolResult {
    if ('ok' in r) {
        const data = r.data && typeof r.data === 'object' && 'data' in r.data ? (r.data as any).data : r.data;
        return ok(data);
    }
    return err(r);
}

const workspaceRootSchema = z.string().optional().describe('Workspace root path (only needed for multi-root setups; defaults to the configured workspace).');

/**
 * Register all curated tools + the passthrough on the given McpServer.
 * The console discipline is baked into the mutating-tool descriptions (the
 * only passive persona channel on Claude Desktop).
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
    const { workspaceRoot, token } = ctx;
    // Bind the ctx defaults (default workspace root + token) into every call.
    // call() is a 3-arg pure helper (opts, defaultRoot, defaultToken); each tool
    // supplies only the per-request opts and lets the closure inject the defaults.
    const doCall = (o: CallOptions) => call(o, workspaceRoot, token);

    // --- Read tools ---

    server.registerTool('board_read', {
        description: 'Read the full Switchboard kanban board (all columns, cards, and plan summaries). On entry: summarize to a ONE-LINE column-count snapshot (never dump cards), present the two-tier menu (1. Plan 2. Code 3. Board 4. Automate · More: design & artifacts, external PM, setup & tour), then wait for direction.',
        inputSchema: { workspaceRoot: workspaceRootSchema }
    }, async (args) => toReadResult(await doCall({ method: 'GET', path: '/kanban/board', workspaceRoot: args.workspaceRoot, token })));

    server.registerTool('health_read', {
        description: 'Liveness + registered terminal agents: GET /health → {status, port, roots, terminals, terminalCount}. terminalCount 0 while plans exist usually means the user forgot to open their agent terminals (AGENT SETUP tab / saved grid) — card_dispatch will 409 until one is live; suggest opening terminals before Guided setup.',
        inputSchema: {}
    }, async () => toResult(await doCall({ method: 'GET', path: '/health', token })));

    server.registerTool('columns_read', {
        description: 'Read the kanban column layout ({builtIn, custom}).',
        inputSchema: { workspaceRoot: workspaceRootSchema }
    }, async (args) => toReadResult(await doCall({ method: 'GET', path: '/kanban/columns', workspaceRoot: args.workspaceRoot, token })));

    server.registerTool('plan_read', {
        description: 'Read a single plan (including its .data.content) by planId, or list plans by column/featureId. Pass planId for a single plan; pass column or featureId for a list.',
        inputSchema: {
            planId: z.string().optional().describe('Plan ID for a single plan read.'),
            column: z.string().optional().describe('Column name to list plans in.'),
            featureId: z.string().optional().describe('Feature ID to list plans assigned to a feature.'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        if (args.planId) {
            return toReadResult(await doCall({ method: 'GET', path: `/kanban/plan?planId=${encodeURIComponent(args.planId)}`, workspaceRoot: args.workspaceRoot, token }));
        }
        const params = new URLSearchParams();
        if (args.column) params.set('column', args.column);
        if (args.featureId) params.set('featureId', args.featureId);
        const qs = params.toString();
        return toReadResult(await doCall({ method: 'GET', path: `/kanban/plans${qs ? '?' + qs : ''}`, workspaceRoot: args.workspaceRoot, token }));
    });

    server.registerTool('catalog_read', {
        description: 'Read the LocalApiServer protocol catalog (apiEndpoints[] with {path, method, prefix}). Auth-gated.',
        inputSchema: { workspaceRoot: workspaceRootSchema }
    }, async (args) => toReadResult(await doCall({ method: 'GET', path: '/catalog', workspaceRoot: args.workspaceRoot, token })));

    server.registerTool('worktree_list', {
        description: 'List orchestration worktrees.',
        inputSchema: { workspaceRoot: workspaceRootSchema }
    }, async (args) => toReadResult(await doCall({ method: 'GET', path: '/worktree/list', workspaceRoot: args.workspaceRoot, token })));

    // --- Plan CRUD ---

    server.registerTool('plan_create', {
        description: 'Create a new plan. Returns 201 + assigned planId. 409 if a plan file with the slug already exists; 400 on a path-traversal slug.' + MUTATING_RULES,
        inputSchema: {
            title: z.string().describe('Plan title.'),
            content: z.string().optional().describe('Plan markdown body.'),
            column: z.string().optional().describe('Initial column (defaults to Created).'),
            project: z.string().optional().describe('Project to pin the plan to.'),
            complexity: z.number().optional().describe('Complexity score (1-10).'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => toResult(await doCall({ method: 'POST', path: '/kanban/plans', body: args, workspaceRoot: args.workspaceRoot, token })));

    server.registerTool('plan_delete', {
        description: 'Delete a plan by planId. Pass deleteFile=true to also remove the .md file; without deleteFile the file remains and the plan re-appears on the next import_plans scan.' + MUTATING_RULES,
        inputSchema: {
            planId: z.string().describe('Plan ID to delete.'),
            deleteFile: z.boolean().optional().describe('Also delete the underlying .md file (path-traversal-guarded to .switchboard/plans/).'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        const params = new URLSearchParams({ planId: args.planId });
        if (args.deleteFile) params.set('deleteFile', 'true');
        return toResult(await doCall({ method: 'DELETE', path: `/kanban/plans?${params.toString()}`, workspaceRoot: args.workspaceRoot, token }));
    });

    server.registerTool('plan_set_project', {
        description: 'Set/clear a plan\'s project pin.' + MUTATING_RULES,
        inputSchema: {
            planId: z.string(),
            project: z.string().nullable().describe('Project name, or null/empty to unpin.'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => toResult(await doCall({ method: 'PUT', path: '/kanban/plans/project', body: { planId: args.planId, project: args.project, workspaceRoot: args.workspaceRoot }, workspaceRoot: args.workspaceRoot, token })));

    server.registerTool('plan_set_complexity', {
        description: 'Set a plan\'s complexity score (1-10).' + MUTATING_RULES,
        inputSchema: {
            planId: z.string(),
            complexity: z.number().min(1).max(10),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => toResult(await doCall({ method: 'PUT', path: '/kanban/plans/complexity', body: { planId: args.planId, complexity: args.complexity, workspaceRoot: args.workspaceRoot }, workspaceRoot: args.workspaceRoot, token })));

    // --- Movement ---

    server.registerTool('card_move', {
        description: 'Move a kanban card by planId or sessionId to a target column (move only — fires no agent; use card_dispatch to advance AND dispatch). Column IDs are canonical uppercase display names ("LEAD CODED", never the slug "lead-coded" — a slug written verbatim strands the card between views on older servers; current servers canonicalize and 400 on unknown columns). Returns 502 on upstream move failure.' + MUTATING_RULES,
        inputSchema: {
            planId: z.string().optional().describe('Plan ID to move.'),
            sessionId: z.string().optional().describe('Session ID to move (alternative to planId).'),
            targetColumn: z.string().describe('Target column label.'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        const body: Record<string, unknown> = { targetColumn: args.targetColumn };
        if (args.planId) body.planId = args.planId;
        if (args.sessionId) body.sessionId = args.sessionId;
        if (args.workspaceRoot) body.workspaceRoot = args.workspaceRoot;
        return toResult(await doCall({ method: 'POST', path: '/kanban/move', body, workspaceRoot: args.workspaceRoot, token }));
    });

    server.registerTool('card_dispatch', {
        description: 'ONE-call advance-and-dispatch (POST /kanban/dispatch): move a plan to a coding column AND fire that column\'s configured agent prompt — the same path a board drag takes, with the move persisted before the dispatch. OMIT targetColumn to auto-route by the plan\'s complexity through the board\'s own rule (default bands: 1-4 → INTERN CODED, 5-6 → CODER CODED, 7+/unknown → LEAD CODED; honors custom routing maps and the pair-programming bypass; the decision comes back in `routing`) — never hardcode LEAD CODED. The response is verified against the DB: {success, moved, dispatched, role, routing, dispatchedAgent, dispatchedAt} — success:true means the card landed AND a dispatch was observed, never just "request parsed". A 409 "no live terminal agent" usually means the user forgot to open their agent terminals (suggest AGENT SETUP tab / saved grid before Guided setup). The board\'s CLI-triggers setting does NOT gate this call.' + MUTATING_RULES,
        inputSchema: {
            plan: z.string().describe('Plan reference: planId, sessionId, or plan-file path.'),
            targetColumn: z.string().optional().describe('Canonical column ID (e.g. "LEAD CODED"). Omit (or pass "auto") to route by complexity.'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        const body: Record<string, unknown> = { plan: args.plan };
        if (args.targetColumn) body.targetColumn = args.targetColumn;
        if (args.workspaceRoot) body.workspaceRoot = args.workspaceRoot;
        return toResult(await doCall({ method: 'POST', path: '/kanban/dispatch', body, workspaceRoot: args.workspaceRoot, token }));
    });

    // --- Features ---

    server.registerTool('features_reconcile', {
        description: 'Reconcile a feature\'s subtasks (imperative verb dispatch). Pass verb + payload to hit /kanban/feature, /kanban/feature/assign, /kanban/feature/remove, /kanban/feature/delete, /kanban/feature/split, or /kanban/features/assign, /kanban/features/reconcile.' + MUTATING_RULES,
        inputSchema: {
            verb: z.string().describe('Imperative verb: "create", "assign", "remove", "delete", "split", "features-assign", or "reconcile".'),
            payload: z.record(z.unknown()).describe('Verb-specific request body.'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        const verbMap: Record<string, string> = {
            'create': '/kanban/feature',
            'assign': '/kanban/feature/assign',
            'remove': '/kanban/feature/remove',
            'delete': '/kanban/feature/delete',
            'split': '/kanban/feature/split',
            'features-assign': '/kanban/features/assign',
            'reconcile': '/kanban/features/reconcile'
        };
        const p = verbMap[args.verb] || '/kanban/features/reconcile';
        return toResult(await doCall({ method: 'POST', path: p, body: { ...args.payload, workspaceRoot: args.workspaceRoot }, workspaceRoot: args.workspaceRoot, token }));
    });

    // --- Orchestration ---

    server.registerTool('orchestration_dispatch', {
        description: 'Dispatch orchestration coding to a feature\'s subtasks. Path is /kanban/orchestration/dispatch. Workspace root defaults to the configured workspace — only pass it to target a different root in a multi-root setup.' + MUTATING_RULES,
        inputSchema: {
            featurePlanId: z.string().describe('Feature plan ID to dispatch.'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        // Desktop's model has no filesystem/env access and cannot know the
        // absolute root, so default to the env-configured ctx root (which the
        // server would also fall back to). Only override for multi-root.
        const root = args.workspaceRoot?.trim() ? args.workspaceRoot : workspaceRoot;
        return toResult(await doCall({ method: 'POST', path: '/kanban/orchestration/dispatch', body: { featurePlanId: args.featurePlanId, workspaceRoot: root }, workspaceRoot: root, token }));
    });

    // --- Worktree cleanup ---

    server.registerTool('worktree_cleanup', {
        description: 'Clean up / mark merged an orchestration worktree by worktreeId or branch. Returns 502 on upstream failure.' + MUTATING_RULES,
        inputSchema: {
            worktreeId: z.string().optional(),
            branch: z.string().optional(),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => {
        const body: Record<string, unknown> = {};
        if (args.worktreeId) body.worktreeId = args.worktreeId;
        if (args.branch) body.branch = args.branch;
        if (args.workspaceRoot) body.workspaceRoot = args.workspaceRoot;
        return toResult(await doCall({ method: 'POST', path: '/worktree/cleanup', body, workspaceRoot: args.workspaceRoot, token }));
    });

    // --- ClickUp / Linear raw proxy (tokens stay server-side) ---

    server.registerTool('clickup_request', {
        description: 'Raw proxy to the ClickUp API via LocalApiServer (POST /api/clickup). The ClickUp token stays server-side; pass the upstream ClickUp request body.',
        inputSchema: {
            body: z.record(z.unknown()).describe('ClickUp API request body (passed through to LocalApiServer).'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => toResult(await doCall({ method: 'POST', path: '/api/clickup', body: args.body, workspaceRoot: args.workspaceRoot, token })));

    server.registerTool('linear_request', {
        description: 'Raw proxy to the Linear API via LocalApiServer (POST /api/linear). The Linear token stays server-side; pass the upstream Linear GraphQL request body.',
        inputSchema: {
            body: z.record(z.unknown()).describe('Linear API request body (passed through to LocalApiServer).'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => toResult(await doCall({ method: 'POST', path: '/api/linear', body: args.body, workspaceRoot: args.workspaceRoot, token })));

    // --- Generic passthrough (long tail + future endpoints) ---

    server.registerTool('switchboard_request', {
        description: 'Generic passthrough to LocalApiServer: provide method + path + optional body. Use for endpoints not covered by a curated tool. Path is appended to http://127.0.0.1:<port>.',
        inputSchema: {
            method: z.string().describe('HTTP method (GET/POST/PUT/DELETE).'),
            path: z.string().describe('API path (e.g. /kanban/features). Query params may be included.'),
            body: z.record(z.unknown()).optional().describe('Request body (for POST/PUT).'),
            workspaceRoot: workspaceRootSchema
        }
    }, async (args) => toResult(await doCall({ method: args.method.toUpperCase(), path: args.path, body: args.body, workspaceRoot: args.workspaceRoot, token })));
}
