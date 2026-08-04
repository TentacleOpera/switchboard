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
    fields?: Record<string, VerbFieldSchema>;
}

export type ProviderKey = 'kanban' | 'planning' | 'design' | 'setup' | 'taskViewer' | 'tickets';

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

    for (const [field, spec] of Object.entries(schema.fields || {})) {
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
    stitchSaveAuthConfig: {
        fields: {
            apiKey: { type: 'string' },
        },
    },
    saveFileContent: {
        fields: {
            filePath: { type: 'string', required: true },
            content: { type: 'string' },
            originalContent: { type: 'string' },
            tab: { type: 'string' },
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
    setPushScope: {
        fields: {
            project: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    // `initiatorProject` (optional, never required — a required field would reject
    // valid payloads from shipped webview builds) is the initiating client's own
    // view filter; the arm prefers it over the last-writer-wins DB row. The
    // validator accepts an explicit null for non-required fields, which is a
    // meaningful sentinel here ("no project"), so `type: 'string'` is correct.
    // `name` required: createFeatureFromPlanIds rejects an empty name, so the
    // schema mirrors the arm's real requirement. `subtaskPlanIds` optional: the
    // arm defaults a missing value to [] (the blank-feature contract), so
    // requiring it would reject a valid API payload (PRD contract #5).
    createFeature: {
        fields: {
            name: { type: 'string', required: true },
            subtaskPlanIds: { type: 'array' },
            description: { type: 'string' },
            workspaceRoot: { type: 'string' },
            initiatorProject: { type: 'string' },
        },
    },
    chatCopyPrompt: {
        fields: {
            sessionIds: { type: 'array' },
            workspaceRoot: { type: 'string' },
            initiatorProject: { type: 'string' },
        },
    },
    // `name` optional: the arm falls back to the plan's existing topic when no
    // custom name is supplied (KanbanProvider promoteToFeature arm), matching
    // the planning-panel schema for the same verb. Requiring it would reject a
    // valid keep-the-title API payload the arm handles fine (PRD contract #5).
    promoteToFeature: {
        fields: {
            planId: { type: 'string', required: true },
            name: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    addSubtaskToFeature: {
        fields: {
            featureSessionId: { type: 'string', required: true },
            subtaskSessionId: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    // Read verb backing the browser Automation tab. The arm dereferences nothing off
    // `msg`, so every field is optional — a stricter schema would reject valid
    // webview payloads on shipped installs (PRD contract #5).
    getAutobanConfig: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    // Dispatch hot path
    triggerAction: {
        fields: {
            sessionId: { type: 'string', required: true },
            targetColumn: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
            apiOriginated: { type: 'boolean' },
            bypassTriggerGate: { type: 'boolean' },
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
    improvePlan: {
        fields: {
            planId: { type: 'string' },
            planFile: { type: 'string', required: true },
            topic: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
};

export const PLANNING_VERB_SCHEMAS: Record<string, VerbSchema> = {
    // Features
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
            initiatorProject: { type: 'string' },
        },
    },
    createPlansPasteBack: {
        fields: {
            markdown: { type: 'string' },
            workspaceRoot: { type: 'string' },
            initiatorProject: { type: 'string' },
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
    createPlan: {
        fields: {
            topic: { type: 'string' },
            project: { type: 'string' },
            description: { type: 'string' },
            targetColumn: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    importPlansFromClipboard: {
        fields: {
            content: { type: 'string' },
            workspaceRoot: { type: 'string' },
            project: { type: 'string' },
        },
    },
    deleteKanbanPlan: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    moveKanbanPlanColumn: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
            column: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    setKanbanPlanComplexity: {
        fields: {
            planId: { type: 'string' },
            sessionId: { type: 'string' },
            complexity: { type: ['string', 'number'], required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    // ── 2d: convertToSubtask schema moved to TICKETS_VERB_SCHEMAS. ──
    improveFeature: {
        fields: {
            planId: { type: 'string' },
            planFile: { type: 'string', required: true },
            title: { type: 'string' },
            subtaskCount: { type: 'number' },
            workspaceRoot: { type: 'string' },
        },
    },
    updateFeatureConfig: {
        fields: {
            key: { type: 'string', required: true },
            value: { type: ['string', 'number', 'boolean', 'object', 'array'] },
            workspaceRoot: { type: 'string' },
        },
    },
    resolveDuplicate: {
        fields: {
            duplicatePlanId: { type: 'string', required: true },
            canonicalPlanId: { type: 'string' },
            action: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    // ─── P2: Docs / PRD / Constitution / Insights / Previews / Attachments ───
    // Permissive + field-accurate: only the fields the arm dereferences are
    // declared; `required` is reserved for fields the arm hard-requires (an
    // HTTP caller omitting them gets a deterministic rejection instead of a
    // silent no-op). The webview postMessage path bypasses validation.
    saveFileContent: {
        fields: {
            filePath: { type: 'string', required: true },
            content: { type: 'string' },
            originalContent: { type: 'string' },
            tab: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    saveProjectPrd: {
        fields: {
            projectName: { type: 'string', required: true },
            content: { type: 'string', required: true },
            mode: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    createLocalDoc: {
        fields: {
            folderPath: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            withAgent: { type: 'boolean' },
            workspaceRoot: { type: 'string' },
        },
    },
    deleteLocalDoc: {
        fields: {
            docId: { type: 'string', required: true },
            docName: { type: 'string' },
            sourceFolder: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    saveConstitutionFile: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
            content: { type: 'string' },
            governanceFile: { type: 'string' },
            mode: { type: 'string' },
        },
    },
    deleteConstitutionFile: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
            governanceFile: { type: 'string' },
        },
    },
    addConstitutionPath: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
        },
    },
    removeConstitutionPath: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
            relativePath: { type: 'string', required: true },
        },
    },
    setConstitutionPath: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
            relativePath: { type: 'string', required: true },
        },
    },
    createOnlineDocument: {
        fields: {
            sourceId: { type: 'string', required: true },
            parentId: { type: 'string' },
            title: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    saveOnlineDocFile: {
        fields: {
            slugPrefix: { type: 'string', required: true },
            content: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    syncDocToOnline: {
        fields: {
            localDocPath: { type: 'string', required: true },
            sourceId: { type: 'string', required: true },
            parentId: { type: 'string' },
            mode: { type: 'string' },
            rememberLocation: { type: 'boolean' },
            docName: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    importFullDoc: {
        fields: {
            sourceId: { type: 'string' },
            docId: { type: 'string' },
            docName: { type: 'string' },
            sourceFolder: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    importResearchDoc: {
        fields: {
            docTitle: { type: 'string' },
            folderPath: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    deleteImportedDoc: {
        fields: {
            slugPrefix: { type: 'string', required: true },
            docName: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    updateInsightStatus: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
            filename: { type: 'string', required: true },
            status: { type: 'string', required: true },
        },
    },
    deleteInsight: {
        fields: {
            workspaceRoot: { type: 'string', required: true },
            filename: { type: 'string', required: true },
        },
    },
    uploadPlanAttachment: {
        fields: {
            planFile: { type: 'string', required: true },
            topic: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    setUploadLocation: {
        fields: {
            sourceId: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    linkToDocument: {
        fields: {
            sourceId: { type: 'string' },
            docId: { type: 'string' },
            docName: { type: 'string' },
            sourceFolder: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    linkToFolder: {
        fields: {
            folderPath: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    addLocalFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
            // Optional direct path — when present the arm skips the host folder
            // picker (an HTTP client has no dialog to answer).
            folderPath: { type: 'string' },
        },
    },
    removeLocalFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderPath: { type: 'string', required: true },
        },
    },
    addPlanningHtmlFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderPath: { type: 'string' },
        },
    },
    removePlanningHtmlFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderPath: { type: 'string', required: true },
        },
    },
    setProjectContextEnabled: {
        fields: {
            workspaceRoot: { type: 'string' },
            enabled: { type: 'boolean' },
        },
    },
    // ─── Tickets family (P3) — ClickUp / Linear writes + provider config ───
    // ── 2f: clickupCreateTask, linearCreateIssue, syncAllTickets schemas moved
    //    to TICKETS_VERB_SCHEMAS (verbs moved to TicketsPanelProvider). ──
    // ── 2d: clickupUpdateTaskAssignees, clickupUpdateTaskPriority,
    //    clickupUpdateTaskTags schemas moved to TICKETS_VERB_SCHEMAS. ──
    // ── 2d: linearUpdateIssueAssignee, linearUpdateIssuePriority,
    //    linearUpdateIssueLabels, editTicket, moveTicket, changeTicketStatus,
    //    deleteTicketConfirmed schemas moved to TICKETS_VERB_SCHEMAS. ──
    // ── 2e: postTicketComment, postTicketReply, ticketAttachImage schemas
    //    moved to TICKETS_VERB_SCHEMAS. submitComment stays here — it serves
    //    the live kanban + project review-comment sidebars. ──
    submitComment: {
        fields: {
            sessionId: { type: 'string' },
            topic: { type: 'string' },
            planFileAbsolute: { type: 'string' },
            selectedText: { type: 'string' },
            comment: { type: 'string' },
        },
    },
    // ── 2d: pushTicket schema moved to TICKETS_VERB_SCHEMAS. ──
    // ── 2f: syncAllTickets schema moved to TICKETS_VERB_SCHEMAS. ──
    syncToSource: {
        fields: {
            slugPrefix: { type: 'string', required: true },
        },
    },
    // 2c: setupTicketsWatcher + saveLocalTicketFile moved to TICKETS_VERB_SCHEMAS.
};

// Ticket-source verbs moved to the Tickets panel (slice 2b). These schemas moved
// with their handlers: leaving them in PLANNING_VERB_SCHEMAS while the verbs are
// gated by TICKETS_VERBS silently disables payload validation on the /tickets rail,
// because validateVerbPayload('tickets', …) finds no declared shape and passes.
const TICKETS_VERB_SCHEMAS: Record<string, VerbSchema> = {
    switchTicketsProvider: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
        },
    },
    clickupSaveSpaceSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            spaceId: { type: ['string', 'number'] },
            spaceName: { type: 'string' },
        },
    },
    clickupSaveFolderSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderId: { type: ['string', 'number'] },
            folderName: { type: 'string' },
        },
    },
    clickupSaveListSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            listId: { type: ['string', 'number'] },
            listName: { type: 'string' },
            spaceId: { type: ['string', 'number'] },
            spaceName: { type: 'string' },
            folderId: { type: ['string', 'number'] },
            folderName: { type: 'string' },
        },
    },
    linearSaveProjectSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            projectName: { type: 'string' },
        },
    },
    addTicketsFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    removeTicketsFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderPath: { type: 'string', required: true },
        },
    },
    saveTicketsFolderPaths: {
        fields: {
            workspaceRoot: { type: 'string' },
            paths: { type: 'array' },
        },
    },
    saveTicketsFolder: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderPath: { type: 'string' },
        },
    },
    // ── 2c: ticket file load, sync-status, file watcher, delta pull ──
    setupTicketsWatcher: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    saveLocalTicketFile: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
            content: { type: 'string' },
        },
    },
    listLocalTicketFiles: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            listId: { type: ['string', 'number'] },
            projectId: { type: 'string' },
        },
    },
    readLocalTicketFile: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
        },
    },
    refreshTicketsDelta: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            listId: { type: ['string', 'number'] },
            projectId: { type: 'string' },
            includeClosed: { type: 'boolean' },
            forceFull: { type: 'boolean' },
        },
    },
    getTicketSyncStatuses: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            ids: { type: 'array' },
        },
    },
    ticketsRootChanged: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    ticketsDefaultRoot: {
        fields: {},
    },
    // ── 2d: ticket detail + mutation schemas moved from PLANNING_VERB_SCHEMAS ──
    convertToSubtask: {
        fields: {
            subtaskSessionId: { type: 'string', required: true },
            featureSessionId: { type: 'string', required: true },
            workspaceRoot: { type: 'string' },
        },
    },
    clickupUpdateTaskAssignees: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: ['string', 'number'], required: true },
            currentAssigneeIds: { type: 'array' },
            desiredAssigneeIds: { type: 'array' },
        },
    },
    clickupUpdateTaskPriority: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: ['string', 'number'], required: true },
            priority: { type: 'number' },
        },
    },
    clickupUpdateTaskTags: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: ['string', 'number'], required: true },
            tags: { type: 'array' },
        },
    },
    linearUpdateIssueAssignee: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            assigneeId: { type: 'string' },
        },
    },
    linearUpdateIssuePriority: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            priority: { type: 'number' },
        },
    },
    linearUpdateIssueLabels: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            labelIds: { type: 'array' },
        },
    },
    editTicket: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
        },
    },
    moveTicket: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            ticketId: { type: 'string', required: true },
            targetId: { type: ['string', 'number'], required: true },
        },
    },
    changeTicketStatus: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
            statusId: { type: ['string', 'number'], required: true },
        },
    },
    deleteTicketConfirmed: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
        },
    },
    pushTicket: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
        },
    },
    // ── 2e: comment manager, mention autocomplete and attachment schemas
    //    moved from PLANNING_VERB_SCHEMAS. ──
    postTicketComment: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
            comment: { type: 'string' },
            mentions: { type: 'array' },
        },
    },
    postTicketReply: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
            commentId: { type: 'string', required: true },
            commentText: { type: 'string' },
            mentions: { type: 'array' },
        },
    },
    // ── 2e: submitComment schema stays in PLANNING_VERB_SCHEMAS (live kanban +
    //    project review-comment sidebars route to PlanningPanelProvider). ──
    ticketAttachImage: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string', required: true },
            id: { type: 'string', required: true },
            requestId: { type: ['string', 'number'] },
        },
    },
    // ── 2f: schemas moved from PLANNING_VERB_SCHEMAS (verbs moved to
    //    TicketsPanelProvider). linearImportTask / clickupImportTask were only
    //    in TASK_VIEWER_VERB_SCHEMAS before; they are added here too so the
    //    /tickets rail validates payload (validateVerbPayload('tickets', …)
    //    otherwise treats "no declared shape" as a pass). ──
    clickupCreateTask: {
        fields: {
            workspaceRoot: { type: 'string' },
            listId: { type: ['string', 'number'] },
            parentId: { type: ['string', 'number'] },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'number' },
            assignees: { type: 'array' },
        },
    },
    linearCreateIssue: {
        fields: {
            workspaceRoot: { type: 'string' },
            projectName: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            parentId: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'number' },
            assigneeId: { type: 'string' },
        },
    },
    syncAllTickets: {
        fields: {
            workspaceRoot: { type: 'string' },
            provider: { type: 'string' },
        },
    },
    linearImportTask: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            includeSubtasks: { type: 'boolean' },
        },
    },
    clickupImportTask: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: 'string', required: true },
            includeSubtasks: { type: 'boolean' },
        },
    },
    // ── Plan 4: ClickUp/Linear config verb schemas moved out of
    //    SETUP_VERB_SCHEMAS. Leaving them in SETUP while the verbs are gated by
    //    TICKETS_VERBS silently disables payload validation on the /tickets rail,
    //    because validateVerbPayload('tickets', …) finds no declared shape and
    //    passes. ──
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
};


export const SETUP_VERB_SCHEMAS: Record<string, VerbSchema> = {
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

export const TASK_VIEWER_VERB_SCHEMAS: Record<string, VerbSchema> = {
    sendToTerminal: {
        fields: {
            name: { type: 'string', required: true },
            input: { type: 'string', required: true },
            paced: { type: 'boolean' },
            apiOriginated: { type: 'boolean' },
        },
    },
    ready: {},
    runSetup: {},
    runSetupIDEs: {},
    dispatchProjectManager: {},
    openKanban: {
        fields: {
            tab: { type: 'string' },
        },
    },
    openPlanningPanel: {},
    openDesignPanel: {},
    openSetupPanel: {
        fields: {
            section: { type: 'string' },
        },
    },
    openProjectPanel: {},
    linearLoadProject: {
        fields: {
            workspaceRoot: { type: 'string' },
            search: { type: 'string' },
            stateId: { type: 'string' },
        },
    },
    linearLoadProjects: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    linearLoadTaskDetails: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
        },
    },
    linearImportTask: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            includeSubtasks: { type: 'boolean' },
        },
    },
    clickupImportTask: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: 'string', required: true },
            includeSubtasks: { type: 'boolean' },
        },
    },
    linearImportAndSendToPlanner: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            includeSubtasks: { type: 'boolean' },
        },
    },
    clickupLoadProject: {
        fields: {
            workspaceRoot: { type: 'string' },
            listId: { type: 'string' },
            includeClosed: { type: 'boolean' },
            loadSeq: { type: 'number' },
        },
    },
    clickupLoadSpaces: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    clickupLoadFolders: {
        fields: {
            workspaceRoot: { type: 'string' },
            spaceId: { type: 'string', required: true },
        },
    },
    clickupLoadLists: {
        fields: {
            workspaceRoot: { type: 'string' },
            spaceId: { type: 'string' },
            folderId: { type: 'string' },
        },
    },
    clickupSaveListSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            listId: { type: 'string' },
            listName: { type: 'string' },
            spaceId: { type: 'string' },
            folderId: { type: 'string' },
        },
    },
    clickupSaveSpaceSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            spaceId: { type: 'string' },
        },
    },
    clickupSaveFolderSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            folderId: { type: 'string' },
        },
    },
    linearSaveProjectSelection: {
        fields: {
            workspaceRoot: { type: 'string' },
            projectName: { type: 'string' },
        },
    },
    clickupLoadTaskDetails: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: 'string', required: true },
        },
    },
    linearUpdateIssueLabels: {
        fields: {
            workspaceRoot: { type: 'string' },
            issueId: { type: 'string', required: true },
            labelIds: { type: 'array' },
        },
    },
    clickupUpdateTaskTags: {
        fields: {
            workspaceRoot: { type: 'string' },
            taskId: { type: 'string', required: true },
            tags: { type: 'array' },
        },
    },
    linearLoadAutomationCatalog: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    clickupLoadSpaceTags: {
        fields: {
            workspaceRoot: { type: 'string' },
            spaceId: { type: 'string', required: true },
        },
    },
    copyTextToClipboard: {
        fields: {
            text: { type: 'string', required: true },
            message: { type: 'string' },
        },
    },
    showInfo: {
        fields: {
            message: { type: 'string', required: true },
        },
    },
    showWarning: {
        fields: {
            message: { type: 'string', required: true },
        },
    },
    initializeProtocols: {},
    finishOnboarding: {},
    scaffoldMultiRepo: {
        fields: {
            parentDir: { type: 'string' },
            workspaceName: { type: 'string' },
            repoUrls: { type: 'array' },
            pat: { type: 'string' },
        },
    },
    openExternalUrl: {
        fields: {
            url: { type: 'string', required: true },
        },
    },
    openDocs: {},
    toggleSilentSetup: {
        fields: {
            value: { type: 'boolean' },
        },
    },
    setTerminalRole: {
        fields: {
            terminalName: { type: 'string', required: true },
            role: { type: 'string', required: true },
        },
    },
    focusTerminal: {
        fields: {
            terminalName: { type: 'string' },
            pid: { type: 'number' },
        },
    },
    focus: {
        fields: {
            terminalName: { type: 'string' },
            pid: { type: 'number' },
        },
    },
    closeTerminal: {
        fields: {
            terminalName: { type: 'string', required: true },
        },
    },
    executeRemote: {
        fields: {
            terminalName: { type: 'string', required: true },
            command: { type: 'string', required: true },
        },
    },
    executeLocal: {
        fields: {
            terminalName: { type: 'string', required: true },
            command: { type: 'string', required: true },
        },
    },
    renameTerminal: {
        fields: {
            terminalName: { type: 'string', required: true },
            alias: { type: 'string' },
        },
    },
    requestContextFile: {
        fields: {
            terminalName: { type: 'string', required: true },
        },
    },
    registerAllTerminals: {},
    deregisterAllTerminals: {},
    createAgentGrid: {},
    createAgentGridEditor: {},
    closeChatAgent: {
        fields: {
            agentName: { type: 'string', required: true },
        },
    },
    setChatAgentRole: {
        fields: {
            agentName: { type: 'string', required: true },
            role: { type: 'string', required: true },
        },
    },
    triggerAgentAction: {
        fields: {
            role: { type: 'string', required: true },
            sessionFile: { type: 'string', required: true },
            instruction: { type: 'string' },
        },
    },
    sendAnalystMessage: {
        fields: {
            instruction: { type: 'string', required: true },
        },
    },
    generateContextMap: {},
    reviewPlan: {
        fields: {
            sessionId: { type: 'string', required: true },
            planFile: { type: 'string' },
        },
    },
    viewPlan: {
        fields: {
            sessionId: { type: 'string', required: true },
        },
    },
    copyPlanLink: {
        fields: {
            sessionId: { type: 'string' },
            planId: { type: 'string' },
            column: { type: 'string' },
            workspaceRoot: { type: 'string' },
        },
    },
    deletePlan: {
        fields: {
            sessionId: { type: 'string', required: true },
        },
    },
    importPlans: {},
    completePlan: {
        fields: {
            sessionId: { type: 'string', required: true },
        },
    },
    recoverPlanFromSidebar: {
        fields: {
            sessionId: { type: 'string', required: true },
        },
    },
    claimPlan: {
        fields: {
            brainSourcePath: { type: 'string', required: true },
        },
    },
    createDraftPlanTicket: {},
    getRecoverablePlans: {},
    restorePlan: {
        fields: {
            planId: { type: 'string', required: true },
        },
    },
    saveStartupCommands: {
        fields: {
            commands: { type: 'array' },
        },
    },
    fetchNotionContent: {
        fields: {
            url: { type: 'string', required: true },
        },
    },
    getNotionFetchState: {},
    getStartupCommands: {},
    getVisibleAgents: {},
    getMcpMonitorConfig: {},
    setMcpMonitorConfig: {
        fields: {
            config: { type: 'object' },
        },
    },
    getAccurateCodingSetting: {},
    getAdvancedReviewerSetting: {},
    getLeadChallengeSetting: {},
    getJulesAutoSyncSetting: {},
    getDefaultPromptOverrides: {},
    saveDefaultPromptOverrides: {
        fields: {
            overrides: { type: 'object' },
        },
    },
    getDefaultPromptPreviews: {},
    setActiveTab: {
        fields: {
            tab: { type: 'string', required: true },
        },
    },
    setActiveSubTab: {
        fields: {
            tab: { type: 'string', required: true },
        },
    },
    memoLoad: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    memoSave: {
        fields: {
            workspaceRoot: { type: 'string' },
            content: { type: 'string' },
        },
    },
    memoClear: {
        fields: {
            workspaceRoot: { type: 'string' },
        },
    },
    memoGeneratePrompt: {
        fields: {
            workspaceRoot: { type: 'string' },
            content: { type: 'string' },
            action: { type: 'string' },
        },
    },
    getRecentActivity: {
        fields: {
            limit: { type: 'number' },
            before: { type: 'string' },
        },
    },
    updateAutobanState: {
        fields: {
            state: { type: 'object' },
        },
    },
    addAutobanTerminal: {
        fields: {
            role: { type: 'string', required: true },
            name: { type: 'string' },
        },
    },
    removeAutobanTerminal: {
        fields: {
            role: { type: 'string', required: true },
            terminalName: { type: 'string', required: true },
        },
    },
    resetAutobanPools: {},
    pipelineStart: {
        fields: {
            intervalSeconds: { type: 'number' },
        },
    },
    pipelineStop: {},
    pipelinePause: {},
    pipelineUnpause: {},
    pipelineSetInterval: {
        fields: {
            intervalSeconds: { type: 'number', required: true },
        },
    },
    airlock_sendToCoder: {
        fields: {
            text: { type: 'string', required: true },
        },
    },
    airlock_syncRepo: {},
    kanban_workflowEvent: {
        fields: {
            workflow: { type: 'string', required: true },
            sessionId: { type: 'string' },
        },
    },
    getDbPath: {},
    setLocalDb: {},
    editDbPath: {},
    testDbConnection: {},
    setCustomDbPath: {
        fields: {
            path: { type: 'string', required: true },
        },
    },
    setPresetDbPath: {
        fields: {
            preset: { type: 'string', required: true },
        },
    },
    queryArchives: {},
    resetDatabase: {},
};

export const VERB_SCHEMAS: Record<ProviderKey, Record<string, VerbSchema>> = {
    kanban: KANBAN_VERB_SCHEMAS,
    planning: PLANNING_VERB_SCHEMAS,
    design: DESIGN_VERB_SCHEMAS,
    setup: SETUP_VERB_SCHEMAS,
    taskViewer: TASK_VIEWER_VERB_SCHEMAS,
    tickets: TICKETS_VERB_SCHEMAS,
};

