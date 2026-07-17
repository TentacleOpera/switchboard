const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROVIDERS = [
    { name: 'Design', file: 'src/services/DesignPanelProvider.ts', switchPattern: /switch\s*\(message\.type\)/ },
    { name: 'TaskViewer', file: 'src/services/TaskViewerProvider.ts', switchPattern: /switch\s*\(data\.type\)/ },
    { name: 'Setup', file: 'src/services/SetupPanelProvider.ts', switchPattern: /switch\s*\(message\?\.type\)/ },
];

function findSwitchBlock(file, pattern) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let switchLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) { switchLineIdx = i; break; }
    }
    if (switchLineIdx === -1) return null;
    let depth = 0, started = false;
    let end = -1;
    for (let i = switchLineIdx; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) { end = i; break; }
    }
    if (end === -1) return null;
    return lines.slice(switchLineIdx, end + 1).join('\n');
}

for (const p of PROVIDERS) {
    const full = path.join(REPO_ROOT, p.file);
    const block = findSwitchBlock(full, p.switchPattern);
    if (!block) { console.log(p.name, 'switch not found'); continue; }
    console.log(`\n=== ${p.name} ===`);
    const patterns = new Map();
    const re = /vscode\.[a-zA-Z]+(?:\.[a-zA-Z]+|\.<[^>]+>)?/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        const key = m[0];
        patterns.set(key, (patterns.get(key) || 0) + 1);
    }
    const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted) {
        console.log(`  ${v}x ${k}`);
    }
}
