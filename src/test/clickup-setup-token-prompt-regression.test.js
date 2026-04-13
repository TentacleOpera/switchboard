'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const source = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'ClickUpSyncService.ts'),
        'utf8'
    );

    assert.match(
        source,
        /private async _promptForApiToken\(\): Promise<string \| null> \{[\s\S]*vscode\.window\.showInputBox\(\{[\s\S]*prompt: 'Enter your ClickUp API token \(starts with pk_\)'[\s\S]*password: true[\s\S]*placeHolder: 'pk_\.\.\.'[\s\S]*ignoreFocusOut: true[\s\S]*Token appears too short\. ClickUp tokens typically start with pk_[\s\S]*\}\);[\s\S]*return inputToken \? inputToken\.trim\(\) : null;[\s\S]*\}/m,
        'Expected ClickUp applyConfig() to prompt for a masked API token using the same validation as the Setup panel flow.'
    );

    assert.match(
        source,
        /let token = await this\.getApiToken\(\);[\s\S]*if \(!token\) \{[\s\S]*token = await this\._promptForApiToken\(\);[\s\S]*if \(!token\) \{[\s\S]*Setup cancelled — ClickUp API token required\.[\s\S]*\}[\s\S]*await this\._secretStorage\.store\('switchboard\.clickup\.apiToken', token\);[\s\S]*\}/m,
        'Expected ClickUp applyConfig() to prompt for, trim, and store the token before continuing the shared setup flow.'
    );

    console.log('clickup setup token prompt regression test passed');
}

try {
    run();
} catch (error) {
    console.error('clickup setup token prompt regression test failed:', error);
    process.exit(1);
}
