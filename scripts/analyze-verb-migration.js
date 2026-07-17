const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROVIDERS = [
    { name: 'Kanban', file: 'src/services/KanbanProvider.ts', switchPattern: /switch\s*\(msg\.type\)/ },
    { name: 'Planning', file: 'src/services/PlanningPanelProvider.ts', switchPattern: /switch\s*\(msg\.type\)/ },
    { name: 'Design', file: 'src/services/DesignPanelProvider.ts', switchPattern: /switch\s*\(message\.type\)/ },
    { name: 'TaskViewer', file: 'src/services/TaskViewerProvider.ts', switchPattern: /switch\s*\(data\.type\)/ },
    { name: 'Setup', file: 'src/services/SetupPanelProvider.ts', switchPattern: /switch\s*\(message\?\.type\)/ },
];

function findSwitchBlock(file, pattern) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let switchLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) { switchLine = i; break; }
    }
    if (switchLine === -1) return null;
    let depth = 0, started = false;
    let end = -1;
    for (let i = switchLine; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) { end = i; break; }
    }
    if (end === -1) return null;
    const block = lines.slice(switchLine, end + 1).join('\n');
    return { start: switchLine + 1, end: end + 1, block };
}

for (const p of PROVIDERS) {
    const full = path.join(REPO_ROOT, p.file);
    const r = findSwitchBlock(full, p.switchPattern);
    if (!r) { console.log(p.name, 'switch not found'); continue; }
    const block = r.block;
    const caseRe = /case\s+(['"])([^'"]+)\1\s*:/g;
    const cases = Array.from(block.matchAll(caseRe)).map(m => m[2]);
    const uniqueCases = [...new Set(cases)];
    const breakCount = (block.match(/\bbreak\s*;/g) || []).length;
    const returnCount = (block.match(/\breturn\s+/g) || []).length;
    const vscodeCount = (block.match(/vscode\./g) || []).length;
    const executeCommandCount = (block.match(/executeCommand\(/g) || []).length;
    console.log(`${p.name}: lines ${r.start}-${r.end}, arms=${uniqueCases.length}, breaks=${breakCount}, returns=${returnCount}, vscode.=${vscodeCount}, executeCommand=${executeCommandCount}`);
}
