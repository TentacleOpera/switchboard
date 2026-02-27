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
                instruction: "Initialize task.md and read WORKFLOW_INTEGRITY.md",
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
    'handoff-lead': {
        name: "Handoff - Lead Coder (One-Shot)",
        persona: "You are the Lead Coder Liaison. You delegate large one-shot feature requests to the Lead Coder.",
        steps: [
            {
                id: "stage",
                instruction: "Stage the request context and relevant files to .switchboard/handoff/lead_request.md. Verify payload size is under 1200 chars. If not, reference the staged file path.",
                requiredEvidence: "request_staged"
            },
            {
                id: "send",
                instruction: "Call send_message with action: 'execute' to dispatch work to the lead coder. metadata: { phase_gate: { enforce_persona: 'lead' } }.",
                requiredEvidence: "message_sent",
                requiredTools: ["send_message"]
            },
            {
                id: "review",
                instruction: "Wait for confirmation.",
                requiredEvidence: "work_verified"
            }
        ]
    },
    handoff: {
        name: "Handoff - Terminal Delegation",
        persona: "You are the Delegation Manager. You split tasks and send them to an external agent via execute action.",
        steps: [
            {
                id: "split",
                instruction: "Split tasks into Band A (delegatable) and Band B (complex). Skip if ALL flag.",
                requiredEvidence: "task_split"
            },
            {
                id: "send",
                instruction: "Call send_message with action: 'execute' to inject tasks into the target terminal.",
                requiredEvidence: "message_sent",
                requiredTools: ["send_message"]
            },
            {
                id: "review",
                instruction: "Wait for explicit user confirmation that delegated work has completed. Optional inbox polling may be used for visibility only (not completion correlation). Verify and merge changes.",
                requiredEvidence: "work_verified"
            }
        ]
    },
    "handoff-chat": {
        name: "Handoff - Chat Clipboard Delegation",
        persona: "You are the Delegation Manager. You split tasks and prepare a clipboard-ready handoff payload for chat-based delegation.",
        steps: [
            {
                id: "split",
                instruction: "Split tasks into Band A (delegatable) and Band B (complex). Skip if ALL flag.",
                requiredEvidence: "task_split"
            },
            {
                id: "prepare_clipboard",
                instruction: "Prepare a delegation artifact and copy it to clipboard for chat handoff.",
                requiredEvidence: "clipboard_payload_ready"
            },
            {
                id: "review",
                instruction: "Wait for explicit user confirmation that delegated work has completed, then verify and merge.",
                requiredEvidence: "work_verified"
            }
        ]
    },
    "handoff-relay": {
        name: "Handoff - Relay Mode",
        persona: "You are the Delegation Manager. You execute complex work now, stage delegated remainder, then pause for model switch.",
        steps: [
            {
                id: "split",
                instruction: "Split tasks into Band A (delegatable) and Band B (complex). Skip if ALL flag.",
                requiredEvidence: "task_split"
            },
            {
                id: "relay_stage",
                instruction: "Execute Band B locally, stage relay batch artifact for delegation, and stop workflow for model switch.",
                requiredEvidence: "relay_staged"
            },
            {
                id: "pause_and_relay",
                instruction: "Finalize relay summary, confirm handoff context is staged, and pause for user-confirmed model switch.",
                requiredEvidence: "relay_paused"
            }
        ]
    },
    enhance: {
        name: "Enhance - Deep Planning & Structural Audit",
        persona: "You are a senior systems analyst. Harden plans via complexity and edge-case analysis. No implementation work.",
        prohibitedTools: ['run_in_terminal'],
        steps: [
            {
                id: "context_loading",
                instruction: "Load the current implementation plan and any staged antigravity planning artifacts.",
                requiredEvidence: "context_loaded"
            },
            {
                id: "analysis",
                instruction: "Perform complexity and edge-case audits (Band A vs Band B, race/security/side effects).",
                requiredEvidence: "analysis_completed"
            },
            {
                id: "hardening",
                instruction: "Rewrite the planning document with detailed, verifiable execution and validation steps.",
                requiredEvidence: "plan_hardened"
            },
            {
                id: "presentation",
                instruction: "Summarize improvements and recommend the next workflow transition (/challenge or /handoff).",
                requiredEvidence: "findings_presented"
            }
        ]
    },
    challenge: {
        name: "Challenge (Internal Adversarial Review)",
        persona: "You run internal adversarial review only. Produce a strict grumpy critique followed by a balanced lead synthesis.",
        steps: [
            {
                id: "scope",
                instruction: "Confirm review scope and target artifacts for an internal review pass.",
                requiredEvidence: "scope_selected"
            },
            {
                id: "dependency_check",
                instruction: "MANDATORY: Read the code of any service, utility, or module being modified or worked around. Do not assume black-box behavior. Verify actual implementation before review.",
                requiredEvidence: "dependencies_verified"
            },
            {
                id: "execute",
                instruction: "Generate grumpy_critique.md and balanced_review.md locally using the two-pass adversarial format.",
                requiredEvidence: "review_executed"
            },
            {
                id: "present",
                instruction: "Read and present internal findings and recommended actions.",
                requiredEvidence: "findings_presented"
            },
            {
                id: "finalize",
                instruction: "Finalize internal review artifacts and close the workflow.",
                requiredEvidence: "review_finalized"
            }
        ]
    },
    chat: {
        name: "Chat Consultation Mode",
        persona: "You are the Switchboard Operator & Product Manager. You are consultative and discussion-first: gather requirements, challenge assumptions, and shape a plan before routing implementation.",
        prohibitedTools: ['run_in_terminal'],
        steps: [
            {
                id: "activate_persona",
                instruction: "Read .agent/personas/switchboard_operator.md and adopt Switchboard Operator constraints.",
                requiredEvidence: "persona_activated"
            },
            {
                id: "onboard",
                instruction: "Identify the core problem/opportunity and mention the /chat -> /enhance -> /challenge progression.",
                requiredEvidence: "topic_confirmed"
            },
            {
                id: "iterate",
                instruction: "Iterate on requirements and draft a minimalist plan when What/Why are clear.",
                requiredEvidence: "plan_drafted"
            },
            {
                id: "transition",
                instruction: "Route ready plans to /handoff, or recommend /enhance when deeper structure is needed.",
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

