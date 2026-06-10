'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const source = readSource('src', 'services', 'TaskViewerProvider.ts');

    assert.match(
        source,
        /public async importPlanFromClipboard\(markdownText\?: string\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(title, text, false, \{ skipBrainPromotion: true \}\);/,
        'Expected single-plan clipboard import to pass skipBrainPromotion=true.'
    );

    assert.match(
        source,
        /private async _importMultiplePlansFromClipboard\(text: string\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(plan\.title, plan\.content, false, \{ skipBrainPromotion: true \}\);/,
        'Expected multi-plan clipboard imports to pass skipBrainPromotion=true for each imported plan.'
    );

    assert.match(
        source,
        /public async createDraftPlanTicket\(\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(title, idea, false, \{ createdAt, projectName \}\);/,
        'Expected normal draft plan creation to keep the default brain-promotion behavior while inheriting the active project filter.'
    );

    assert.match(
        source,
        /private async _createInitiatedPlan\(\s*title: string,\s*idea: string,\s*isAirlock: boolean,\s*options: \{\s*skipBrainPromotion\?: boolean;\s*suppressIntegrationSync\?: boolean;[\s\S]*?\} = \{\}\s*\): Promise<\{ planFileAbsolute: string; \}> \{[\s\S]*if \(!options\.skipBrainPromotion\) \{[\s\S]*void this\._promotePlanToBrain\(planFileAbsolute, fileName\)\.catch\(\(e\) => \{/,
        'Expected _createInitiatedPlan to skip auto-promotion when skipBrainPromotion=true.'
    );

    console.log('clipboard import brain-promotion regression test passed');
}

try {
    run();
} catch (error) {
    console.error('clipboard import brain-promotion regression test failed:', error);
    process.exit(1);
}
