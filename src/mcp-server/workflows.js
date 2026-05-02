/**
 * Switchboard Workflow Definitions
 * Defines the FSM (Finite State Machine) logic for each mode.
 */

const WORKFLOWS = {
    accuracy: {
        name: "Accuracy Mode",
        persona: "You are the Lead Engineer. Methodical, paranoid, and precise. You NEVER optimize for speed. You always VERIFY every step.",
        steps: [
            {
                id: "init",
                instruction: "Initialize task.md and read .agent/rules/WORKFLOW_INTEGRITY.md",
                requiredEvidence: "task_file_created"
            },
            {
                id: "planning",
                instruction: "Create implementation plan with atomic chunks.",
                requiredEvidence: "plan_file_created"
            },
            {
                id: "review",
                instruction: "Perform Grumpy/Lead Developer review (if complexity > 5).",
                requiredEvidence: "review_artifacts"
            },
            {
                id: "execution",
                instruction: "Execute chunks with immediate verification.",
                requiredEvidence: "verification_log"
            },
            {
                id: "finalize",
                instruction: "Final regression test and cleanup.",
                requiredEvidence: "final_success"
            }
        ]
    },
    'improve-plan': {
        name: "Improve Plan - Enhancement & Review",
        persona: "You are a senior systems analyst and internal reviewer. Consolidate structure and stress-test assumptions. No implementation work.",
        prohibitedTools: [],
        steps: [
            {
                id: "execute_all",
                instruction: "Read the plan, check dependencies, simulate Grumpy/Balanced review, and update the plan file in one continuous response.",
                requiredEvidence: "plan_updated"
            }
        ]
    },
    chat: {
        name: "Chat Consultation Mode",
        persona: "You are the Switchboard Operator & Product Manager. You are consultative and discussion-first: gather requirements, challenge assumptions, and shape a plan before routing implementation.",
        prohibitedTools: [],
        steps: [
            {
                id: "activate_persona",
                instruction: "Read .agent/personas/switchboard_operator.md and adopt Switchboard Operator constraints.",
                requiredEvidence: "persona_activated"
            },
            {
                id: "onboard",
                instruction: "Identify the core problem/opportunity and mention the /chat -> /improve-plan progression.",
                requiredEvidence: "topic_confirmed"
            },
            {
                id: "iterate",
                instruction: "Iterate on requirements and draft a minimalist plan when What/Why are clear.",
                requiredEvidence: "plan_drafted"
            },
            {
                id: "transition",
                instruction: "Route ready plans to the Kanban board for execution, or recommend /improve-plan when deeper structure is needed.",
                requiredEvidence: "next_step_selected"
            }
        ]
    },

};

/**
 * getWorkflow
 * Returns the definition for a given workflow ID.
 */
function getWorkflow(id) {
    return WORKFLOWS[id];
}

module.exports = {
    getWorkflow,
    WORKFLOWS // Export for dynamic Enum generation
};

