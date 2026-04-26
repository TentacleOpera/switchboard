// ?????? AUTO-GENERATED from switchboard-cli. DO NOT EDIT.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Switchboard MCP Registration Script
 */

// 1. Robust Root Detection (Audit Finding 4)
function findRoot(startDir) {
    let current = startDir;
    while (current !== path.parse(current).root) {
        if (fs.existsSync(path.join(current, 'package.json'))) {
            // Confirm it's the RIGHT package.json (the one containing switchboard-cli)
            if (fs.existsSync(path.join(current, 'switchboard-cli'))) return current;
        }
        current = path.dirname(current);
    }
    return path.resolve(__dirname, '..', '..'); // Fallback
}

const WORKSPACE_ROOT = findRoot(__dirname);
const STATE_ROOT = process.env.SWITCHBOARD_STATE_ROOT || WORKSPACE_ROOT;
const SERVER_PATH = path.resolve(__dirname, 'mcp-server.js');

// 2. Hashed Unique Naming (Audit Finding 1)
const pathHash = crypto.createHash('md5').update(WORKSPACE_ROOT).digest('hex').substring(0, 8);
const SERVER_NAME = `switchboard-${pathHash}`;

const CONFIG_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const CONFIG_FILE = path.join(CONFIG_DIR, 'mcp_config.json');

function register() {
    console.log(`🚀 Registering unique MCP server: ${SERVER_NAME}`);
    console.log(`📍 Server Path: ${SERVER_PATH}`);
    console.log(`📂 Workspace Root: ${WORKSPACE_ROOT}`);
    console.log(`🗂️ State Root: ${STATE_ROOT}`);

    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    let config = { mcpServers: {} };
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (!config.mcpServers) config.mcpServers = {};
        } catch (e) {
            console.error(`❌ Failed to parse config: ${e.message}`);
            process.exit(1);
        }
    }

    // 3. Clean up stale generic 'switchboard' entry (to force the new scoped one)
    if (config.mcpServers['switchboard']) {
        console.log(`🧹 Removing legacy 'switchboard' entry...`);
        delete config.mcpServers['switchboard'];
    }

    // Update or Create Entry
    config.mcpServers[SERVER_NAME] = {
        command: 'node',
        args: [SERVER_PATH, WORKSPACE_ROOT],
        env: {
            SWITCHBOARD_WORKSPACE_ROOT: WORKSPACE_ROOT,
            SWITCHBOARD_STATE_ROOT: STATE_ROOT
        }
    };

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log(`✅ Successfully registered uniquely as '${SERVER_NAME}'`);
        console.log(`🔄 Please click 'Refresh' in the MCP menu.`);
    } catch (e) {
        console.error(`❌ Failed to write config: ${e.message}`);
        process.exit(1);
    }
}

register();
