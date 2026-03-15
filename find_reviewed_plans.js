const fs = require('fs');
const path = require('path');

const sessionsDir = path.join(__dirname, '.switchboard', 'sessions');
const plansDir = path.join(__dirname, '.switchboard', 'plans');

function deriveColumn(events) {
    if (!events || events.length === 0) { return 'CREATED'; }
    
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const wf = (e.workflow || '').toLowerCase();
        if (wf.includes('reviewer') || wf === 'review') return 'CODE REVIEWED';
        if (wf === 'lead' || wf === 'coder' || wf === 'handoff' || wf === 'team' || wf === 'handoff-lead') return 'CODED';
        if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan') return 'PLAN REVIEWED';
    }
    return 'CREATED';
}

const reviewedPlans = [];
const files = fs.readdirSync(sessionsDir);

for (const file of files) {
    if (!file.endsWith('.json') || file === 'activity.json') continue;
    
    try {
        const sessionPath = path.join(sessionsDir, file);
        const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        
        if (session.completed) continue;
        
        const column = deriveColumn(session.events || []);
        
        if (column === 'PLAN REVIEWED') {
            const planFile = session.planFile;
            if (planFile) {
                const planPath = path.join(__dirname, planFile.replace(/\\/g, '/'));
                if (fs.existsSync(planPath)) {
                    reviewedPlans.push({
                        sessionId: session.sessionId,
                        planFile: planFile,
                        topic: session.topic,
                        planPath: planPath
                    });
                }
            }
        }
    } catch (e) {
        console.error(`Error processing ${file}:`, e.message);
    }
}

console.log('Plans in PLAN REVIEWED column:');
console.log(JSON.stringify(reviewedPlans, null, 2));
