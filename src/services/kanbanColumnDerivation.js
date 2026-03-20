'use strict';

function hasCustomAgentRole(customAgents, role) {
    if (!Array.isArray(customAgents) || !role) {
        return false;
    }
    return customAgents.some(agent => agent && typeof agent.role === 'string' && agent.role.toLowerCase() === role);
}

function deriveSyntheticMoveColumn(workflow, customAgents) {
    if (!workflow || (!workflow.startsWith('reset-to-') && !workflow.startsWith('move-to-'))) {
        return null;
    }

    const target = workflow.startsWith('reset-to-')
        ? workflow.slice('reset-to-'.length)
        : workflow.slice('move-to-'.length);
    if (!target) {
        return null;
    }

    if (target === 'created') return 'CREATED';
    if (target === 'plan-reviewed') return 'PLAN REVIEWED';
    if (target === 'coded' || target === 'lead-coded') return 'LEAD CODED';
    if (target === 'coder-coded') return 'CODER CODED';
    if (target === 'code-reviewed') return 'CODE REVIEWED';
    if (hasCustomAgentRole(customAgents, target)) {
        return target;
    }

    return null;
}

function deriveKanbanColumn(events = [], customAgents = []) {
    if (!Array.isArray(events) || events.length === 0) {
        return 'CREATED';
    }

    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        const workflow = String(event?.workflow || '').toLowerCase();
        if (!workflow) {
            continue;
        }

        const syntheticMoveColumn = deriveSyntheticMoveColumn(workflow, customAgents);
        if (syntheticMoveColumn) {
            return syntheticMoveColumn;
        }

        if (workflow.includes('reviewer') || workflow === 'review') {
            return 'CODE REVIEWED';
        }

        if (workflow === 'lead' || workflow === 'handoff-lead' || workflow === 'team' || workflow === 'coded') {
            return 'LEAD CODED';
        }

        if (workflow === 'coder' || workflow === 'handoff' || workflow === 'jules') {
            return 'CODER CODED';
        }

        if (
            workflow === 'planner' ||
            workflow === 'challenge' ||
            workflow === 'enhance' ||
            workflow === 'improve-plan' ||
            workflow === 'accuracy' ||
            workflow === 'sidebar-review' ||
            workflow === 'enhanced plan' ||
            workflow === 'improved plan'
        ) {
            return 'PLAN REVIEWED';
        }

        if (workflow.startsWith('custom-agent:')) {
            const role = workflow.slice('custom-agent:'.length);
            if (hasCustomAgentRole(customAgents, role)) {
                return role;
            }
        }
    }

    return 'CREATED';
}

module.exports = { deriveKanbanColumn };