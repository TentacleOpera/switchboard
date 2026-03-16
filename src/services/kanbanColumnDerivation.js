'use strict';

function hasCustomAgentRole(customAgents, role) {
    if (!Array.isArray(customAgents) || !role) {
        return false;
    }
    return customAgents.some(agent => agent && typeof agent.role === 'string' && agent.role.toLowerCase() === role);
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

        if (workflow.includes('reviewer') || workflow === 'review') {
            return 'CODE REVIEWED';
        }

        if (workflow === 'lead' || workflow === 'coder' || workflow === 'handoff' || workflow === 'team' || workflow === 'handoff-lead' || workflow === 'jules') {
            return 'CODED';
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
