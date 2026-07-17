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
    const vscodeCount = (block.match(/vscode\./g) || []).length;
    const execCount = (block.match(/executeCommand/g) || []).length;
    const getConfigCount = (block.match(/getConfiguration\s*\(\s*['"]switchboard['"]/g) || []).length;
    const fsCount = (block.match(/vscode\.workspace\.fs\./g) || []).length;
    const uriCount = (block.match(/vscode\.Uri\./g) || []).length;
    const clipboardCount = (block.match(/vscode\.env\.clipboard/g) || []).length;
    const showMsgCount = (block.match(/vscode\.window\.show(Info|Warning|Error)Message/g) || []).length;
    const breakCount = (block.match(/\bbreak\s*;/g) || []).length;
    const returnCount = (block.match(/\breturn\s+/g) || []).length;
    const caseRe = /case\s+(['"])([^'"]+)\1\s*:/g;
    const cases = [...new Set(Array.from(block.matchAll(caseRe)).map(m => m[2]))];
    console.log(`${p.name}: arms=${cases.length} cases, vscode=${vscodeCount}, execCmd=${execCount}, getConfig=${getConfigCount}, vscodeFs=${fsCount}, uri=${uriCount}, clipboard=${clipboardCount}, showMsg=${showMsgCount}, break=${breakCount}, return=${returnCount}`);
}
