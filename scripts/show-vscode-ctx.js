const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const file = process.argv[2] || 'src/services/DesignPanelProvider.ts';
const patterns = {
    'DesignPanelProvider.ts': /switch\s*\(message\.type\)/,
    'TaskViewerProvider.ts': /switch\s*\(data\.type\)/,
    'SetupPanelProvider.ts': /switch\s*\(message\?\.type\)/,
};
const basename = path.basename(file);
const pattern = patterns[basename];
const full = path.join(REPO_ROOT, file);
const src = fs.readFileSync(full, 'utf8');
const lines = src.split('\n');
let switchLineIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) { switchLineIdx = i; break; }
}
if (switchLineIdx === -1) { console.log('switch not found'); process.exit(1); }
let depth = 0, started = false, end = -1;
for (let i = switchLineIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
    }
    if (started && depth === 0) { end = i; break; }
}
const startLine = switchLineIdx + 1;
const endLine = end + 1;
for (let i = switchLineIdx; i <= end; i++) {
    if (/vscode\./.test(lines[i])) {
        const a = Math.max(switchLineIdx, i - 2);
        const b = Math.min(end, i + 2);
        console.log(`\n--- lines ${i + 1} (switch ${startLine}-${endLine}) ---`);
        for (let j = a; j <= b; j++) {
            console.log(`${j + 1}: ${lines[j]}`);
        }
    }
}
