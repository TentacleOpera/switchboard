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

const READ_VERB_RE = /\bcase\s+['"]([^'"]*(?:get|fetch|load|list|browse|read)[^'"]*)['"]\s*:/gi;

function analyzeProviderSwitch(providerConfig) {
    const full = path.join(REPO_ROOT, providerConfig.file);
    const block = findSwitchBlock(full, providerConfig.switchPattern);
    if (!block) return null;

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

    // Read arm break analysis
    const readArms = cases.filter(c => /get|fetch|load|list|browse|read/i.test(c));
    
    // Count break statements specifically associated with read arms
    // Parse switch statement into cases to accurately classify breaks per case arm
    let readArmsWithBreak = 0;
    const armBlocks = block.split(/(?=case\s+['"])/);
    for (const arm of armBlocks) {
        const match = arm.match(/case\s+['"]([^'"]+)['"]/);
        if (match) {
            const caseName = match[1];
            if (/get|fetch|load|list|browse|read/i.test(caseName)) {
                if (/\bbreak\s*;/.test(arm)) {
                    readArmsWithBreak++;
                }
            }
        }
    }

    return {
        name: providerConfig.name,
        file: providerConfig.file,
        casesCount: cases.length,
        cases,
        readArms,
        readArmsWithBreak,
        vscodeCount,
        execCount,
        getConfigCount,
        fsCount,
        uriCount,
        clipboardCount,
        showMsgCount,
        breakCount,
        returnCount
    };
}

module.exports = {
    REPO_ROOT,
    PROVIDERS,
    findSwitchBlock,
    analyzeProviderSwitch
};
