import * as path from 'path';

/**
 * Sanitise a project NAME into a filesystem-safe slug for the per-project PRD
 * directory. Projects are name-based (there is no project_id FK on plans), so
 * the PRD path is derived from the name. The output is restricted to
 * `[a-z0-9_-]`, which guarantees no path separators and no `..` traversal — a
 * malicious / accidental project name (e.g. "../../etc") can never escape
 * `.switchboard/projects/`. The PRD content is injected verbatim into every
 * dispatched prompt, so it shares the constitution's trust boundary.
 *
 * Note: distinct names can collide on the same slug (e.g. "Front End" and
 * "front-end" both → "front-end"). This is acceptable — the PRD is a
 * convenience doc and project names are user-curated and few.
 */
export function sanitizeProjectSlug(projectName: string): string {
    const slug = String(projectName || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')  // anything unsafe (/, ., .., spaces, …) → hyphen
        .replace(/-+/g, '-')            // collapse runs
        .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
        .slice(0, 80)
        .replace(/-+$/g, '');           // re-trim after the length cap
    return slug || 'project';
}

/**
 * Absolute path to a project's PRD file: `.switchboard/projects/<slug>/prd.md`.
 * Mirrors constitutionUtils.getConstitutionPath, but is project-scoped (keyed on
 * the project NAME) rather than workspace-scoped.
 */
export function getProjectPrdPath(workspaceRoot: string, projectName: string): string {
    const slug = sanitizeProjectSlug(projectName);
    return path.join(workspaceRoot, '.switchboard', 'projects', slug, 'prd.md');
}

/**
 * Shared output shape + authoring rules for every PRD-builder prompt, so a PRD
 * produced via any path (planner build, copy-prompt, or the board writer) has
 * the same durable, injection-friendly structure. The PRD is injected VERBATIM
 * into every dispatched coding prompt for the project, so the rules optimise for
 * that: durable/status-free, lean, and — crucially — carrying the cross-cutting
 * Constraints & Invariants a coder relies on. Edited once; used by every builder.
 */
function prdFormatAndRules(projectName: string, prdPath: string): string {
    return `A PRD here is the durable product contract for this project: it is respected across every plan (independent of features) and INJECTED VERBATIM INTO EVERY CODING PROMPT for the project. So it must be:
- Durable & status-free — capture WHAT the product must be and the rules every plan must honour; never progress, task status, or "do not start / do not dispatch" notes (status lives in the feature and plan files).
- Lean — it is paid for on every dispatch; no filler, no unresolved "open questions", no metrics dashboards.
- Binding — it MUST carry the cross-cutting Constraints & Invariants every plan honours: compatibility/backward-compat guarantees on shipped or live surfaces, quality/security/accessibility bars, "must-never" behaviours, and reuse-don't-fork rules. These are product-quality requirements a coder relies on (WHAT must always hold, not HOW to build a feature). It is NOT a technical spec or a constitution.

Format the output document strictly as:

# ${projectName} — PRD

> **Vision:** [one sentence]

## Target Users
[who they are and their main pain point]

## Key Capabilities
- **[Name]:** [one sentence — WHAT, not HOW]

## Constraints & Invariants (honoured by every plan)
- [a binding rule every plan must respect]

## Non-Goals
- [an explicit exclusion for the current scope]

Keep it durable and status-free. Save the result to ${prdPath}`;
}

/**
 * Interactive PRD builder prompt — the planner co-authors the PRD with the user
 * via a short Q&A. Used by the Project panel's "Build via Planner" / "Copy Build
 * Prompt" actions.
 */
export function buildPrdBuilderPrompt(projectName: string, workspaceRoot: string): string {
    const prdPath = getProjectPrdPath(workspaceRoot, projectName);
    return `Please act as a product manager. I want to build a Product Requirements Document (PRD) for the project "${projectName}" in the workspace at ${workspaceRoot}.

Please help me draft it — ask me these one at a time if I have not already answered them:
1. Vision: one sentence — the project's primary purpose.
2. Target Users: who they are and their main pain point.
3. Key Capabilities: 3-7 core capabilities, each a short name + one sentence (WHAT, not HOW).
4. Constraints & Invariants: the rules EVERY plan in this project must honour — compatibility/backward-compat guarantees on shipped or live surfaces, quality/security/accessibility bars, "must-never" behaviours, reuse-don't-fork rules. This is the section a coder relies on most.
5. Non-Goals: explicit exclusions for the current scope.

${prdFormatAndRules(projectName, prdPath)}`;
}

/**
 * One-shot PRD writer prompt — an agent generates the PRD from a short
 * description without a Q&A. Used by the board's "create project + copy PRD
 * prompt" action.
 */
export function buildPrdWriterPrompt(projectName: string, workspaceRoot: string, description?: string): string {
    const prdPath = getProjectPrdPath(workspaceRoot, projectName);
    const desc = (description || '').trim();
    return `You are a product requirements document (PRD) writer. Create a concise, durable PRD for the project "${projectName}".${desc ? `\n\nProject description: ${desc}` : ''}

${prdFormatAndRules(projectName, prdPath)}`;
}
