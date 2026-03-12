const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const workspaceRoot = process.cwd();
const sbDir = path.join(workspaceRoot, '.switchboard');
const registryPath = path.join(sbDir, 'plan_registry.json');
const identityPath = path.join(sbDir, 'workspace_identity.json');
const sessionsDir = path.join(sbDir, 'sessions');

if (!fs.existsSync(registryPath) || !fs.existsSync(identityPath)) {
    console.error('Error: Not a switchboard workspace or missing registry.');
    process.exit(1);
}

const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const workspaceId = identity.workspaceId;

function deriveColumn(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const wf = (e.workflow || '').toLowerCase();
        if (wf.includes('reviewer') || wf === 'review') return 'CODE REVIEWED';
        if (wf === 'lead' || wf === 'coder' || wf === 'handoff' || wf === 'team' || wf === 'handoff-lead') return 'CODED';
        if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan') return 'PLAN REVIEWED';
    }
    return 'CREATED';
}

const files = fs.readdirSync(sessionsDir);
const columns = {
    'CREATED': [],
    'PLAN REVIEWED': [],
    'CODED': [],
    'CODE REVIEWED': []
};

for (const file of files) {
    if (!file.endsWith('.json') || file === 'activity.json') continue;
    try {
        const sheet = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        if (sheet.completed) continue;

        // Workspace Scoping logic
        let planId = sheet.sessionId;
        if (sheet.brainSourcePath) {
            const normalized = path.normalize(path.resolve(sheet.brainSourcePath));
            const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
            const root = path.parse(stable).root;
            const stablePath = stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
            planId = crypto.createHash('sha256').update(stablePath).digest('hex');
        }

        const entry = registry.entries[planId];
        if (!entry || entry.ownerWorkspaceId !== workspaceId || entry.status !== 'active') continue;

        const col = deriveColumn(sheet.events || []);
        columns[col].push({
            topic: sheet.topic || sheet.planFile || 'Untitled',
            sessionId: sheet.sessionId,
            createdAt: sheet.createdAt
        });
    } catch (e) {}
}

console.log(JSON.stringify(columns, null, 2));
