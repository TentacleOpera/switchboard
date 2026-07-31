const fs = require('fs');
const path = require('path');
const os = require('os');

if (!process.env.SWITCHBOARD_STATE_HOME) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-state-'));
    process.env.SWITCHBOARD_STATE_HOME = tempDir;
    process.env.SWITCHBOARD_TEST = '1';

    process.on('exit', () => {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (_) {}
    });
}

module.exports = {
    stateHomeDir: process.env.SWITCHBOARD_STATE_HOME
};
