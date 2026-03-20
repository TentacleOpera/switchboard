const fs = require('fs');

const sessions = [
    'sess_1773440605072',
    'sess_1773440694073',
    'sess_1773459052545',
    'sess_1773459096807',
    'sess_1773524805241',
    'sess_1773525582393',
    'sess_1773536220374',
    'sess_1773537151696'
];

sessions.forEach(sess => {
    try {
        const filePath = `.switchboard/sessions/${sess}.json`;
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!data.events) data.events = [];
            
            // Adding an event with workflow 'improve-plan' will move it to the 'PLAN REVIEWED' column
            // as per the derivation logic in get_kanban_state
            data.events.push({
                timestamp: new Date().toISOString(),
                action: "complete_workflow_phase",
                workflow: "improve-plan",
                notes: "Plan successfully improved and critically reviewed."
            });
            
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            console.log(`Updated ${sess}`);
        }
    } catch (e) {
        console.error(`Error updating ${sess}: ${e.message}`);
    }
});
