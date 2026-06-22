const fs = require('fs');
const path = require('path');

const sharedDefaultsPath = path.join(__dirname, '../../src/webview/sharedDefaults.js');
const htmlFiles = [
    path.join(__dirname, '../../src/webview/kanban.html'),
    path.join(__dirname, '../../src/webview/setup.html'),
    path.join(__dirname, '../../src/webview/implementation.html')
];

if (!fs.existsSync(sharedDefaultsPath)) {
    console.error('❌ sharedDefaults.js not found');
    process.exit(1);
}

const sharedDefaultsContent = fs.readFileSync(sharedDefaultsPath, 'utf8');

// Simple check to see if sharedDefaults.js has the expected exports
if (!sharedDefaultsContent.includes('DEFAULT_VISIBLE_AGENTS') || !sharedDefaultsContent.includes('DEFAULT_ROLE_CONFIG')) {
    console.error('❌ sharedDefaults.js is missing expected constants');
    process.exit(1);
}

let errors = 0;

// Extract DEFAULT_VISIBLE_AGENTS keys via simple parsing
const visibleAgentsMatch = sharedDefaultsContent.match(/const DEFAULT_VISIBLE_AGENTS\s*=\s*\{([^}]+)\}/s);
const labelKeysMatch = sharedDefaultsContent.match(/const BUILT_IN_AGENT_LABELS\s*=\s*\[([\s\S]*?)\];/);

if (visibleAgentsMatch && labelKeysMatch) {
    const visibleKeys = [...visibleAgentsMatch[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]);
    const labelKeys = [...labelKeysMatch[1].matchAll(/key:\s*'(\w+)'/g)].map(m => m[1]);

    const missingFromLabels = visibleKeys.filter(k => !labelKeys.includes(k));
    if (missingFromLabels.length > 0) {
        console.error(`❌ BUILT_IN_AGENT_LABELS is missing keys that exist in DEFAULT_VISIBLE_AGENTS: ${missingFromLabels.join(', ')}`);
        errors++;
    }

    const extraInLabels = labelKeys.filter(k => !visibleKeys.includes(k));
    if (extraInLabels.length > 0) {
        console.error(`❌ BUILT_IN_AGENT_LABELS has keys not in DEFAULT_VISIBLE_AGENTS: ${extraInLabels.join(', ')}`);
        errors++;
    }
}

htmlFiles.forEach(htmlPath => {
    if (!fs.existsSync(htmlPath)) {
        console.warn(`⚠️ Skipping missing file: ${htmlPath}`);
        return;
    }

    const content = fs.readFileSync(htmlPath, 'utf8');
    const fileName = path.basename(htmlPath);

    // Check for placeholder
    if (!content.includes('<!-- SHARED_DEFAULTS_SCRIPT -->')) {
        console.error(`❌ ${fileName} is missing <!-- SHARED_DEFAULTS_SCRIPT --> placeholder`);
        errors++;
    }

    // Check if it still has hardcoded objects (simple grep-like check)
    // We expect them to use { ...DEFAULT_VISIBLE_AGENTS } now
    if (content.includes('lastVisibleAgents = { lead: true') || 
        content.includes('lastVisibleAgents = { planner: true') ||
        content.includes('const DEFAULT_CONFIG = {') && !content.includes('const DEFAULT_CONFIG = { ...DEFAULT_ROLE_CONFIG }')) {
        console.error(`❌ ${fileName} seems to still have hardcoded defaults`);
        errors++;
    }

    if (!content.includes('DEFAULT_VISIBLE_AGENTS')) {
        console.error(`❌ ${fileName} does not reference DEFAULT_VISIBLE_AGENTS`);
        errors++;
    }

    if (fileName === 'kanban.html' && !content.includes('DEFAULT_ROLE_CONFIG')) {
        console.error(`❌ kanban.html does not reference DEFAULT_ROLE_CONFIG`);
        errors++;
    }
});

if (errors > 0) {
    console.error(`\nFound ${errors} synchronization errors.`);
    process.exit(1);
} else {
    console.log('✅ Webview defaults are correctly synchronized.');
}
