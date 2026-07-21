/**
 * Per-verb input schemas — Verb Engine · 1 (A2b foundations)
 *
 * `handleServiceVerb` is a network boundary: webview postMessage input was
 * trusted (the extension authored the webview), but `POST /<panel>/verb/<name>`
 * input is not. This module holds a data-driven schema registry consulted at
 * the dispatch boundary, after the allowlist check and before `_handleMessage`.
 *
 * Rules:
 *  - A verb WITHOUT a schema passes through unvalidated (zero per-verb code for
 *    un-migrated verbs — the generic-dispatch contract). Subtasks 2–6 add a
 *    schema for each arm as it is migrated.
 *  - A verb WITH a schema has its payload validated: declared fields are
 *    type-checked, `required` fields must be present. Undeclared payload fields
 *    are allowed (arms historically tolerate extras; rejecting them would break
 *    byte-compat with existing webview payloads).
 *  - Validation failures throw at the dispatcher, so the HTTP rail returns
 *    `{ success: false, error }` instead of running the arm on garbage. The
 *    webview postMessage path does NOT validate (trusted, byte-compat).
 *
 * Deliberately dependency-free (no ajv — the VSIX bundles every dependency and
 * these shapes are flat).
 */

export type VerbFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface VerbFieldSchema {
    /** Accepted type(s) for the field when present. */
    type: VerbFieldType | VerbFieldType[];
    /** Field must be present (and non-null). Default: optional. */
    required?: boolean;
}

export interface VerbSchema {
    /** Field-level constraints. Fields not listed are passed through. */
    fields: Record<string, VerbFieldSchema>;
}

export type ProviderKey = 'kanban' | 'planning' | 'design' | 'setup' | 'taskViewer';

function typeOf(value: any): VerbFieldType | 'null' | 'other' {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
    return 'other';
}

export function validateVerbPayload(
    provider: ProviderKey,
    verb: string,
    payload: any
): { ok: true } | { ok: false; error: string } {
    const schema = VERB_SCHEMAS[provider]?.[verb];
    if (!schema) return { ok: true };

    const body = payload ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'payload must be a JSON object' };
    }

    for (const [field, spec] of Object.entries(schema.fields)) {
        const value = (body as any)[field];
        if (value === undefined || value === null) {
            if (spec.required) {
                return { ok: false, error: `missing required field '${field}'` };
            }
            continue;
        }
        const accepted = Array.isArray(spec.type) ? spec.type : [spec.type];
        const actual = typeOf(value);
        if (!accepted.includes(actual as VerbFieldType)) {
            return { ok: false, error: `field '${field}' must be ${accepted.join(' | ')}, got ${actual}` };
        }
    }
    return { ok: true };
}

// ─── Schemas ─────────────────────────────────────────────────────────────
// Populated per-batch as arms are migrated (Verb Engine subtasks 2–6).
// Schema shapes mirror the fields the arm actually reads.

const FOLDER_LIST_SCHEMA: VerbSchema = {
    fields: {
        workspaceRoot: { type: 'string' },
    },
};

const FOLDER_ADD_SCHEMA: VerbSchema = {
    fields: {
        workspaceRoot: { type: 'string' },
        // Optional direct path — when present the arm skips the host folder
        // picker (an HTTP client has no dialog to answer).
        folderPath: { type: 'string' },
    },
};

const FOLDER_REMOVE_SCHEMA: VerbSchema = {
    fields: {
        workspaceRoot: { type: 'string' },
        folderPath: { type: 'string', required: true },
    },
};

const DESIGN_VERB_SCHEMAS: Record<string, VerbSchema> = {
    listDesignFolders: FOLDER_LIST_SCHEMA,
    addDesignFolder: FOLDER_ADD_SCHEMA,
    removeDesignFolder: FOLDER_REMOVE_SCHEMA,
    listHtmlFolders: FOLDER_LIST_SCHEMA,
    addHtmlFolder: FOLDER_ADD_SCHEMA,
    removeHtmlFolder: FOLDER_REMOVE_SCHEMA,
    listClaudeFolders: FOLDER_LIST_SCHEMA,
    addClaudeFolder: FOLDER_ADD_SCHEMA,
    removeClaudeFolder: FOLDER_REMOVE_SCHEMA,
    listImagesFolders: FOLDER_LIST_SCHEMA,
    addImagesFolder: FOLDER_ADD_SCHEMA,
    removeImagesFolder: FOLDER_REMOVE_SCHEMA,
    listStitchFolders: FOLDER_LIST_SCHEMA,
    addStitchFolder: FOLDER_ADD_SCHEMA,
    removeStitchFolder: FOLDER_REMOVE_SCHEMA,
    listBriefsFolders: FOLDER_LIST_SCHEMA,
    addBriefsFolder: FOLDER_ADD_SCHEMA,
    removeBriefsFolder: FOLDER_REMOVE_SCHEMA,
    createBrief: {
        fields: {
            workspaceRoot: { type: 'string' },
            sourceFolder: { type: 'string', required: true },
            title: { type: 'string', required: true },
        },
    },
    deleteBrief: {
        fields: {
            workspaceRoot: { type: 'string' },
            sourceFolder: { type: 'string', required: true },
            docId: { type: 'string', required: true },
        },
    },
    persistTabState: {
        fields: {
            tabKey: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
            state: { type: ['object', 'array', 'string', 'number', 'boolean'] },
        },
    },
    activeTabChanged: {
        fields: {
            tab: { type: 'string', required: true },
        },
    },
    stitchSaveApiKey: {
        fields: {
            apiKey: { type: 'string' },
        },
    },
    copyStitchTweakPrompt: {
        fields: {
            prompt: { type: 'string', required: true },
        },
    },
    copyHtmlTweakPrompt: {
        fields: {
            prompt: { type: 'string', required: true },
        },
    },
};

// ─── Kanban (Verb Engine · 4) ────────────────────────────────────────────
// Move/dispatch payloads are validated strictly — these are the most-called
// external endpoints (/kanban/move, /kanban/dispatch route through them).

const KANBAN_VERB_SCHEMAS: Record<string, VerbSchema> = {
    // Dispatch hot path
    triggerAction: {
        fields: {
            sessionId: { type: 'string', required: true },
            targetColumn: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
            apiOriginated: { type: 'boolean' },
        },
    },
    triggerBatchAction: {
        fields: {
            sessionIds: { type: 'array', required: true },
            targetColumn: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    // Moves
    moveCardForward: {
        fields: {
            sessionIds: { type: 'array', required: true },
            targetColumn: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    moveCardBackwards: {
        fields: {
            sessionIds: { type: 'array', required: true },
            targetColumn: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    moveSelected: {
        fields: {
            sessionIds: { type: 'array', required: true },
            column: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    moveAll: {
        fields: {
            column: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    promptOnDrop: {
        fields: {
            // The arm accepts either sessionIds[] or a single sessionId.
            sessionIds: { type: 'array' },
            sessionId: { type: 'string' },
            sourceColumn: { type: 'string' },
            targetColumn: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    promptSelected: {
        fields: {
            sessionIds: { type: 'array', required: true },
            column: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    promptAll: {
        fields: {
            column: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    // Plan lifecycle
    selectPlan: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
        },
    },
    openPlanByPath: {
        fields: {
            planPath: { type: 'string', required: true },
        },
    },
    completePlan: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    completeSelected: {
        fields: {
            sessionIds: { type: 'array', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    uncompleteCard: {
        fields: {
            sessionIds: { type: 'array', required: true },
            targetColumn: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    sendToBacklog: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    sendToNew: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    reassignPlansWorkspace: {
        fields: {
            sessionIds: { type: 'array', required: true },
            targetWorkspaceRoot: { type: 'string', required: true },
            sourceWorkspaceRoot: { type: 'string' },
            targetProject: { type: 'string' },
        },
    },
    rePlanSelected: {
        fields: {
            sessionIds: { type: 'array', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    testingFailed: {
        fields: {
            sessionIds: { type: 'array', required: true },
            feedback: { type: 'string', required: true },
            action: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    dispatchManagerForSelected: {
        fields: {
            sessionIds: { type: 'array', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    // Projects
    addProject: {
        fields: {
            projectName: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    deleteProject: {
        fields: {
            projectName: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    assignSelectedToProject: {
        fields: {
            projectName: { type: 'string', required: true },
            planIds: { type: 'array', required: true },
        },
    },
    copyPrdPrompt: {
        fields: {
            projectName: { type: 'string', required: true },
            description: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    // Settings
    saveSetting: {
        fields: {
            key: { type: 'string', required: true },
        },
    },
    getSetting: {
        fields: {
            key: { type: 'string', required: true },
        },
    },
    fileExists: {
        fields: {
            path: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    focusTerminal: {
        fields: {
            terminalName: { type: 'string', required: true },
        },
    },
    // Worktrees
    createWorktree: {
        fields: {
            workspaceRoot: { type: 'string' },
            featureTopic: { type: 'string' },
            repoName: { type: 'string' },
            featureId: { type: ['string', 'number'] },
            project: { type: 'string' },
        },
    },
    createWorktreeForFeature: {
        fields: {
            featureId: { type: ['string', 'number'], required: true },
            featureTopic: { type: 'string' },
            repoName: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    createWorktreeForProject: {
        fields: {
            project: { type: 'string', required: true },
            repoName: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    openWorktreeTerminals: {
        fields: {
            worktreeId: { type: ['number', 'string'], required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    copyWorktreeMergePrompt: {
        fields: {
            worktreeId: { type: ['number', 'string'], required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    cleanupWorktree: {
        fields: {
            worktreeId: { type: ['number', 'string'], required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    abandonWorktree: {
        fields: {
            worktreeId: { type: ['number', 'string'], required: true },
            branch: { type: 'string' },
            wtPath: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    // Features
    addSubtaskToFeature: {
        fields: {
            featureSessionId: { type: 'string', required: true },
            subtaskSessionId: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    removeSubtaskFromFeature: {
        fields: {
            subtaskSessionId: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    promoteToFeature: {
        fields: {
            planId: { type: 'string', required: true },
            name: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    createFeature: {
        fields: {
            name: { type: 'string' },
            subtaskPlanIds: { type: 'array' },
            description: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    deleteFeature: {
        fields: {
            sessionId: { type: 'string', required: true },
            deleteSubtasks: { type: 'boolean' },
            workspaceRoot: { type: 'string' },
        },
    },
    getFeatureDetails: {
        fields: {
            sessionId: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
};

export const SETUP_VERB_SCHEMAS: Record<string, VerbSchema> = {
    applyClickUpConfig: {
        fields: {
            token: { type: 'string' },
            options: { type: 'object' },
        },
    },
    applyLinearConfig: {
        fields: {
            token: { type: 'string' },
            options: { type: 'object' },
        },
    },
    applyNotionConfig: {
        fields: {
            token: { type: 'string' },
        },
    },
    saveWorkspaceMappings: {
        fields: {
            mappings: { type: 'array' },
        },
    },
    setCustomDbPath: {
        fields: {
            customDbPath: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    executeControlPlaneMigration: {
        fields: {
            parentDir: { type: 'string' },
            generateWorkspaceFile: { type: 'boolean' },
            cleanupConfirmed: { type: 'array' },
        },
    },
    updateGitIgnoreConfig: {
        fields: {
            rules: { type: 'object' },
        },
    },
    setProtocolTarget: {
        fields: {
            value: { type: 'string' },
        },
    },
    setRemoteConfig: {
        fields: {
            enabled: { type: 'boolean' },
            linearConfig: { type: 'object' },
            notionConfig: { type: 'object' },
        },
    },
};

export const VERB_SCHEMAS: Record<ProviderKey, Record<string, VerbSchema>> = {
    kanban: KANBAN_VERB_SCHEMAS,
    planning: {},
    design: DESIGN_VERB_SCHEMAS,
    setup: SETUP_VERB_SCHEMAS,
    taskViewer: {},
};

