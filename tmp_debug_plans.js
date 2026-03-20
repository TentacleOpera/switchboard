
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const workspaceRoot = 'c:\\Users\\patvu\\Documents\\GitHub\\switchboard';
const registryPath = path.join(workspaceRoot, '.switchboard', 'plan_registry.json');
const identityPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');

function getStablePath(p) {
    const normalized = path.normalize(p);
    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const root = path.parse(stable).root;
    return stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
}

function getAntigravityHash(rawPath) {
    const normalized = path.normalize(rawPath);
    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const root = path.parse(stable).root;
    const stablePath = stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
    return crypto.createHash('sha256').update(stablePath).digest('hex');
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
const workspaceId = identity.workspaceId;

console.log('Current workspaceId:', workspaceId);

const ownedActiveEntries = Object.values(registry.entries).filter((entry) =>
    entry.ownerWorkspaceId === workspaceId && entry.status === 'active'
);

console.log('Owned active entries count:', ownedActiveEntries.length);

const tealPlanId = 'c6f14e9e0ebe8d5d749c1a9d8d3ca4d07f61746196f67bf61cc9608cd7771d51';
const tealEntry = registry.entries[tealPlanId];

if (tealEntry) {
    console.log('Found Teal Entry in registry:', tealEntry.topic);
    console.log('Teal Entry workspaceId:', tealEntry.ownerWorkspaceId);
    console.log('Match?', tealEntry.ownerWorkspaceId === workspaceId);
} else {
    console.log('Teal Entry NOT FOUND in registry keys!');
}

const files = fs.readdirSync(sessionsDir);
for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const content = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
    const sheet = JSON.parse(content);
    
    if (sheet.sessionId.includes('c6f1')) {
        console.log('Checking runsheet:', file);
        console.log('brainSourcePath:', sheet.brainSourcePath);
        
        let planId = sheet.brainSourcePath ? getAntigravityHash(sheet.brainSourcePath) : sheet.sessionId;
        console.log('Calculated PlanId:', planId);
        console.log('Matches Teal PlanId?', planId === tealPlanId);
        
        const entry = registry.entries[planId];
        console.log('Registry Entry exists?', !!entry);
        if (entry) {
            console.log('Entry owned?', entry.ownerWorkspaceId === workspaceId);
            console.log('Entry status:', entry.status);
        }
    }
}
