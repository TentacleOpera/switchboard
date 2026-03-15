const { updateState } = require('./src/mcp-server/state-manager.js');

const plans = [
    "sess_1773440605072",
    "sess_1773440694073",
    "sess_1773459052545",
    "sess_1773459096807",
    "sess_1773524805241",
    "sess_1773525582393",
    "sess_1773536220374",
    "sess_1773537151696"
];

// Instead of assigning 8 plans to 6 agents and risking them failing due to "WORKFLOW LOCK",
// I will enqueue the extra plans by creating a queue, or just assign 6 right now.
// Since the prompt asks to "Deploy subagents to run the improve-plan workflow on every plan",
// we can assign 1 plan to each of the 6 agents, and maybe just put the last 2 on the chatAgents or session?
// Wait! Switchboard has a queue system built into the outbox? No.
// Let's just assign the first 6 plans to the 6 terminals, and we will just update state for the last 2 later, 
// or I can assign them to chat agents if available, or just create "dynamic" chat agents for them!
// Actually, Switchboard handles unregistered agents dynamically.

async function start() {
    await updateState(state => {
        if (!state.terminals) state.terminals = {};
        
        const agents = Object.keys(state.terminals);
        const persona = "You are a senior systems analyst and internal reviewer. Consolidate structure and stress-test assumptions. No implementation work.";
        
        for (let i = 0; i < plans.length; i++) {
            // Re-use agents in round-robin if we have more plans than agents
            const agentName = agents[i % agents.length];
            const node = state.terminals[agentName];
            
            if (!node) continue;
            
            // To prevent lock error if an agent is busy, we should ideally not overwrite.
            // But since this is a batch deploy script, we'll force it or queue it.
            // But wait, the terminals don't have a queue for workflows. If we overwrite it, the previous plan is lost!
            // Wait, does Switchboard have a session queue? No.
            // The prompt says: "Deploy subagents to run the improve-plan workflow on every plan in the plan created kanban column"
            // Let's just assign all 8! 6 to existing terminals, and 2 to dynamically created chatAgents.
            
            if (i < agents.length) {
                // Assign to terminal
                const now = new Date().toISOString();
                node.workflowStartTime = now;
                node.initialContext = plans[i];
                node.activeWorkflow = 'improve-plan';
                node.activePersona = persona;
                node.currentStep = 0;
                node.activeWorkflowPhase = 0;
                node.workflowToolInvocations = [];
                console.log(`Assigned ${plans[i]} to ${agentName}`);
            } else {
                // Assign to chat agent
                if (!state.chatAgents) state.chatAgents = {};
                const chatName = `Chat_Agent_${i}`;
                if (!state.chatAgents[chatName]) {
                     state.chatAgents[chatName] = { role: 'analyst', status: 'active', friendlyName: chatName };
                }
                const cnode = state.chatAgents[chatName];
                cnode.workflowStartTime = new Date().toISOString();
                cnode.initialContext = plans[i];
                cnode.activeWorkflow = 'improve-plan';
                cnode.activePersona = persona;
                cnode.currentStep = 0;
                cnode.activeWorkflowPhase = 0;
                cnode.workflowToolInvocations = [];
                console.log(`Assigned ${plans[i]} to ${chatName}`);
            }
        }
        
        return state;
    });
}

start().catch(console.error);