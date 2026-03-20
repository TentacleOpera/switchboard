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

function getComplexity(planContent) {
    const bandMatch = planContent.match(/Band ([ABC])\s*\([^)]+\)/i);
    if (bandMatch) {
        return bandMatch[1];
    }
    return null;
}

function isImplemented(planContent) {
    return planContent.includes('Reviewer-Executor Pass') || 
           planContent.includes('Reviewer Verdict') ||
           planContent.includes('Files Changed in This Reviewer Pass');
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
                    const planContent = fs.readFileSync(planPath, 'utf8');
                    const complexity = getComplexity(planContent);
                    const implemented = isImplemented(planContent);
                    
                    reviewedPlans.push({
                        sessionId: session.sessionId,
                        planFile: planFile,
                        topic: session.topic,
                        planPath: planPath,
                        complexity: complexity,
                        implemented: implemented
                    });
                }
            }
        }
    } catch (e) {
        console.error(`Error processing ${file}:`, e.message);
    }
}

console.log('Plans in PLAN REVIEWED column:');
console.log('================================');
reviewedPlans.forEach(plan => {
    const status = plan.implemented ? '✓ IMPLEMENTED' : '⚠ NOT IMPLEMENTED';
    const complexity = plan.complexity ? `Band ${plan.complexity}` : 'Unknown';
    console.log(`[${status}] [${complexity}] ${plan.topic}`);
    console.log(`  File: ${plan.planFile}`);
    console.log('');
});

console.log('\nLow complexity (Band A) plans NOT yet implemented:');
console.log('======================================================');
const lowComplexityUnimplemented = reviewedPlans.filter(p => p.complexity === 'A' && !p.implemented);
lowComplexityUnimplemented.forEach(plan => {
    console.log(`- ${plan.topic}`);
    console.log(`  File: ${plan.planFile}`);
    console.log(`  Session ID: ${plan.sessionId}`);
    console.log(`  Path: ${plan.planPath}`);
    console.log('');
});
