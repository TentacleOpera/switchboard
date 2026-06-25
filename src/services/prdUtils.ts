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
