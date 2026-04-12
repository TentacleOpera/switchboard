const separatorSource = "^###\\s*PLAN\\s*\\d+\\s*START$";
const splitRegex = new RegExp(`(${separatorSource})`, 'gm');
const markerTest = new RegExp(separatorSource, 'm');

const text = `### PLAN 1 START
# Plan 1 Title
Some content
### PLAN 2 START
# Plan 2 Title
More content`;

const rawParts = text.split(splitRegex);
console.log("Raw parts:", JSON.stringify(rawParts));

const parts = rawParts.filter(p => p.trim());
console.log("Filtered parts:", JSON.stringify(parts));

const plans = [];
let currentPlan = null;
let importedCount = 0;

for (const part of parts) {
    if (markerTest.test(part)) {
        if (currentPlan && currentPlan.lines.length > 0) {
            const content = currentPlan.lines.join('\n').trim();
            if (content) {
                const h1Match = content.match(/^#\s+(.+)$/m);
                importedCount++;
                const title = h1Match ? h1Match[1].trim() : `Imported Plan ${importedCount}`;
                plans.push({ title, content });
            }
        }
        currentPlan = { marker: part, lines: [] };
    } else {
        if (!currentPlan) currentPlan = { lines: [] };
        currentPlan.lines.push(part);
    }
}
if (currentPlan && currentPlan.lines.length > 0) {
    const content = currentPlan.lines.join('\n').trim();
    if (content) {
        const h1Match = content.match(/^#\s+(.+)$/m);
        importedCount++;
        const title = h1Match ? h1Match[1].trim() : `Imported Plan ${importedCount}`;
        plans.push({ title, content });
    }
}

console.log("Plans:", plans);
