#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'protocol-catalog.json');

const PROVIDERS = [
    { name: 'Kanban', file: 'src/services/KanbanProvider.ts', serviceFile: 'src/services/kanbanService.ts' },
    { name: 'Planning', file: 'src/services/PlanningPanelProvider.ts', serviceFile: 'src/services/planningService.ts' },
    { name: 'Design', file: 'src/services/DesignPanelProvider.ts', serviceFile: 'src/services/designService.ts' },
    { name: 'TaskViewer', file: 'src/services/TaskViewerProvider.ts', serviceFile: 'src/services/taskViewerService.ts' },
    { name: 'Setup', file: 'src/services/SetupPanelProvider.ts', serviceFile: 'src/services/setupService.ts' },
];

function checkParity() {
    if (!fs.existsSync(CATALOG_PATH)) {
        console.error('❌ protocol-catalog.json not found. Run npm run catalog:generate first.');
        process.exit(1);
    }

    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    let totalCataloged = 0;
    let totalImplemented = 0;
    let totalGenuine = 0;
    let totalShims = 0;
    let errors = 0;

    console.log('=== Protocol Parity Check ===\n');

    for (const p of PROVIDERS) {
        const fullPath = path.join(REPO_ROOT, p.file);
        if (!fs.existsSync(fullPath)) {
            console.log(`⚠️  Provider file not found: ${p.file}`);
            continue;
        }

        const src = fs.readFileSync(fullPath, 'utf8');
        
        // Find handleServiceVerb switch block and extract case arms
        const match = src.match(/public async handleServiceVerb\([\s\S]*?switch\s*\(verb\)\s*\{([\s\S]*?)\n\s*\}/);
        const implementedVerbs = new Set();
        if (match) {
            const casesBlock = match[1];
            const caseMatches = casesBlock.matchAll(/case\s+['"]([^'"]+)['"]/g);
            for (const cm of caseMatches) {
                implementedVerbs.add(cm[1]);
            }
        }

        // Analyze service file for shims vs genuine extractions
        let shimsCount = 0;
        let genuineCount = 0;
        const serviceFullPath = path.join(REPO_ROOT, p.serviceFile);
        if (fs.existsSync(serviceFullPath)) {
            const serviceSrc = fs.readFileSync(serviceFullPath, 'utf8');
            for (const verb of implementedVerbs) {
                // Find method definition in service file
                // A simple regex match to find the method block of the verb
                const escapedVerb = verb.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const methodRe = new RegExp(`async\\s+["']?${escapedVerb}["']?\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\s*(?:async|\\}|$)`);
                const methodMatch = serviceSrc.match(methodRe);
                if (methodMatch) {
                    const body = methodMatch[1];
                    if (body.includes('handleMessage(') || body.includes('this._ctx.handleMessage')) {
                        shimsCount++;
                    } else {
                        genuineCount++;
                    }
                } else {
                    // Verb is handled by service but no direct async method matches or it's dynamically routed
                    shimsCount++;
                }
            }
        } else {
            shimsCount = implementedVerbs.size;
        }

        totalGenuine += genuineCount;
        totalShims += shimsCount;

        const catalogedVerbs = catalog.providers[p.name]?.verbs || [];
        totalCataloged += catalogedVerbs.length;
        totalImplemented += implementedVerbs.size;

        console.log(`${p.name} Panel:`);
        console.log(`  Cataloged: ${catalogedVerbs.length} verbs`);
        console.log(`  Implemented: ${implementedVerbs.size} verbs (Genuinely Extracted: ${genuineCount}, Shims: ${shimsCount})`);
        
        // Check if any implemented verb is NOT cataloged
        for (const iv of implementedVerbs) {
            if (!catalogedVerbs.includes(iv)) {
                console.error(`  ❌ Error: implemented verb "${iv}" is not in the protocol catalog!`);
                errors++;
            }
        }

        // Print progress of implemented verbs
        if (implementedVerbs.size > 0) {
            const list = Array.from(implementedVerbs).sort().join(', ');
            console.log(`  Mapped: [${list}]`);
        }
        console.log('');
    }

    const percentage = ((totalImplemented / totalCataloged) * 100).toFixed(1);
    console.log(`Overall coverage: ${totalImplemented}/${totalCataloged} verbs (${percentage}%)`);
    console.log(`  Genuinely Extracted: ${totalGenuine} verbs`);
    console.log(`  Shims (delegating to VS Code host): ${totalShims} verbs`);

    if (errors > 0) {
        console.error(`\n❌ Parity check failed with ${errors} error(s).`);
        process.exit(1);
    } else {
        console.log('\n✅ Parity check passed successfully.');
        process.exit(0);
    }
}

checkParity();
