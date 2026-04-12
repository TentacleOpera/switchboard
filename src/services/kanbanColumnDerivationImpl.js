"use strict";

/**
 * Derive the Kanban column for a plan based on its event history.
 *
 * Scans from the most recent event backwards and maps the workflow name
 * to the corresponding Kanban column.  Manual move/reset workflows
 * (move-to-X, reset-to-X) are resolved first, followed by the standard
 * progression workflows.
 *
 * @param {Array<{workflow?: string|null}>} [events]
 * @param {Array<{role: string}>} [customAgents]
 * @returns {string} The derived Kanban column ID.
 */
function deriveKanbanColumn(events, customAgents) {
    if (!Array.isArray(events) || events.length === 0) {
        return 'CREATED';
    }

    // Slug (lowercased, hyphens) → built-in column ID
    const SLUG_MAP = {
        'created': 'CREATED',
        'plan-reviewed': 'PLAN REVIEWED',
        'intern-coded': 'INTERN CODED',
        'lead-coded': 'LEAD CODED',
        'coder-coded': 'CODER CODED',
        'code-reviewed': 'CODE REVIEWED',
        'acceptance-tested': 'ACCEPTANCE TESTED',
        'coded': 'CODED'
    };

    // Collect custom-agent column IDs (roles)
    const customRoles = new Set();
    if (Array.isArray(customAgents)) {
        for (const agent of customAgents) {
            if (agent && typeof agent.role === 'string' && agent.role.trim()) {
                customRoles.add(agent.role.trim());
            }
        }
    }

    // Scan from most-recent event backwards
    for (let i = events.length - 1; i >= 0; i--) {
        const raw = events[i] && events[i].workflow;
        if (!raw || typeof raw !== 'string') continue;
        const workflow = raw.trim().toLowerCase();
        if (!workflow) continue;

        // --- Manual move / reset workflows: move-to-X or reset-to-X ---
        const manualMatch = workflow.match(/^(?:move|reset)-to-(.+)$/);
        if (manualMatch) {
            const slug = manualMatch[1];

            // Built-in column slug
            if (SLUG_MAP[slug]) return SLUG_MAP[slug];

            // Custom-agent role (case-insensitive match)
            for (var role of customRoles) {
                if (role.toLowerCase() === slug) return role;
            }

            // Fallback: reconstruct column ID from slug
            return slug.replace(/-/g, ' ').toUpperCase();
        }

        // --- Standard workflow progression ---
        switch (workflow) {
            case 'initiate-plan':
                return 'CREATED';

            case 'improve-plan':
            case 'improved plan':
            case 'enhanced plan':
            case 'sidebar-review':
                return 'PLAN REVIEWED';

            case 'handoff':
            case 'handoff-lead':
            case 'handoff-chat':
            case 'handoff-relay':
            case 'implementation':
                return 'CODED';

            case 'review':
            case 'reviewer-pass':
                return 'CODE REVIEWED';

            case 'tester-pass':
                return 'ACCEPTANCE TESTED';

            // Workflows that do not determine column position — skip
            case 'accuracy':
            case 'challenge':
            case 'chat':
                continue;

            default: {
                // Check if the workflow name matches a custom-agent role
                for (var r of customRoles) {
                    if (r.toLowerCase() === workflow) return r;
                }
                // Unknown workflow — keep scanning
                continue;
            }
        }
    }

    return 'CREATED';
}

module.exports = { deriveKanbanColumn };
