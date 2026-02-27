const path = require('path');
const os = require('os');
const fs = require('fs');

function getStablePath(p) {
    const normalized = path.normalize(p);
    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const root = path.parse(stable).root;
    return stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
}

function isPathWithin(parentDir, filePath) {
    const normalizedParent = getStablePath(path.resolve(parentDir));
    const normalizedFile = getStablePath(path.resolve(filePath));
    return normalizedFile === normalizedParent || normalizedFile.startsWith(normalizedParent + path.sep);
}

function isBrainMirrorCandidate(brainDir, filePath) {
    const resolvedBrainDir = path.resolve(brainDir);
    const resolvedFilePath = path.resolve(filePath);
    const normalizedBrainDir = getStablePath(resolvedBrainDir);
    const normalizedFilePath = getStablePath(resolvedFilePath);

    console.log('--- isBrainMirrorCandidate ---');
    console.log('brainDir:', brainDir);
    console.log('filePath:', filePath);
    console.log('normalizedBrainDir:', normalizedBrainDir);
    console.log('normalizedFilePath:', normalizedFilePath);

    if (!isPathWithin(normalizedBrainDir, normalizedFilePath)) {
        console.log('FAIL: isPathWithin');
        return false;
    }

    const relativePath = path.relative(normalizedBrainDir, normalizedFilePath);
    console.log('relativePath:', relativePath);
    const parts = relativePath.split(path.sep).filter(Boolean);
    console.log('parts:', parts);
    if (parts.length !== 2) {
        console.log('FAIL: parts.length ===', parts.length);
        return false;
    }

    return true;
}

const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const myArtifact = 'C:\\Users\\patvu\\.gemini\\antigravity\\brain\\acd0ee75-1c3b-4a95-9073-cba2cbf43685\\implementation_plan.md';

const result = isBrainMirrorCandidate(brainDir, myArtifact);
console.log('RESULT:', result);
