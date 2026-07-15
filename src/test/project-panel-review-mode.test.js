'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const htmlPath = path.join(process.cwd(), 'src', 'webview', 'project.html');
    const htmlSource = await fs.promises.readFile(htmlPath, 'utf8');

    // Popup DOM present
    assert.ok(htmlSource.includes('id="review-comment-popup"'), 'popup DOM present');
    assert.ok(htmlSource.includes('id="review-selected-preview"'), 'popup selected-preview element present');
    assert.ok(htmlSource.includes('id="review-comment-input"'), 'popup comment textarea present');
    assert.ok(htmlSource.includes('id="review-cancel-comment"'), 'popup Cancel button present');
    assert.ok(htmlSource.includes('id="review-copy-prompt"'), 'popup Copy Prompt button present');
    assert.ok(htmlSource.includes('id="review-submit-comment"'), 'popup Send to Planner button present');

    // One Review Mode button per eligible tab
    assert.ok(htmlSource.includes('id="btn-review-kanban"'), 'kanban review button');
    assert.ok(htmlSource.includes('id="btn-review-features"'), 'features review button');
    assert.ok(htmlSource.includes('id="btn-review-projects"'), 'projects review button');
    assert.ok(htmlSource.includes('id="btn-review-constitution"'), 'constitution review button');
    assert.ok(htmlSource.includes('id="btn-review-system"'), 'system review button');

    // Tuning tab excluded
    assert.ok(!htmlSource.includes('id="btn-review-tuning"'), 'tuning review button absent');

    // Popup CSS present
    assert.ok(htmlSource.includes('.comment-popup'), 'comment-popup CSS class present');
    assert.ok(htmlSource.includes('.review-mode-btn.active'), 'review-mode-btn active state CSS present');

    const jsPath = path.join(process.cwd(), 'src', 'webview', 'project.js');
    const jsSource = await fs.promises.readFile(jsPath, 'utf8');

    // Review-mode state expanded to five tabs
    assert.ok(jsSource.includes('reviewMode: { kanban: false, features: false, projects: false, constitution: false, system: false }'),
        'reviewMode state covers all eligible tabs');
    assert.ok(jsSource.includes('reviewSelectedText'), 'reviewSelectedText state holder present');

    // Core functions
    assert.ok(jsSource.includes('REVIEWABLE_TABS'), 'reviewable tab allowlist');
    assert.ok(jsSource.includes('function enterReviewMode'), 'enterReviewMode');
    assert.ok(jsSource.includes('function exitReviewMode'), 'exitReviewMode');
    assert.ok(jsSource.includes('function getReviewContext'), 'per-tab context resolver');
    assert.ok(jsSource.includes('function showReviewPopup'), 'showReviewPopup');
    assert.ok(jsSource.includes('function hideReviewPopup'), 'hideReviewPopup');

    // Per-tab context resolver covers each eligible tab
    assert.ok(jsSource.includes("case 'kanban':"), 'getReviewContext kanban case');
    assert.ok(jsSource.includes("case 'features':"), 'getReviewContext features case');
    assert.ok(jsSource.includes("case 'projects':"), 'getReviewContext projects case');
    assert.ok(jsSource.includes("case 'constitution':"), 'getReviewContext constitution case');
    assert.ok(jsSource.includes("case 'system':"), 'getReviewContext system case');

    // Submit + Copy Prompt wiring
    assert.ok(jsSource.includes("type: 'submitComment'"), 'submitComment posted');
    assert.ok(jsSource.includes('navigator.clipboard.writeText'), 'Copy Prompt uses clipboard');
    assert.ok(jsSource.includes('[Project:'), 'Projects-tab comment prefix workaround present');

    // commentResult message handler
    assert.ok(jsSource.includes("case 'commentResult'"), 'commentResult handled');

    // Edit-mode / tab-switch guards
    assert.ok(jsSource.includes('if (state.reviewMode[tab]) exitReviewMode(tab, true);'),
        'enterEditMode exits review mode');
    assert.ok(jsSource.includes('REVIEWABLE_TABS.includes(activeTab) && state.reviewMode[activeTab]'),
        'tab-switch exits review mode on previous tab');

    // Selection listeners wired per tab
    assert.ok(jsSource.includes("`${tab}-preview-content`"), 'selection listeners attached to per-tab preview-content');

    const providerPath = path.join(process.cwd(), 'src', 'services', 'PlanningPanelProvider.ts');
    const providerSource = await fs.promises.readFile(providerPath, 'utf8');

    // Backend already handles submitComment (no backend changes required by this plan)
    assert.ok(providerSource.includes("case 'submitComment':"), 'PlanningPanelProvider handles submitComment');
    assert.ok(providerSource.includes('commentResult'), 'PlanningPanelProvider posts commentResult');

    console.log('project panel review mode test passed');
}

run().catch((error) => {
    console.error('project panel review mode test failed:', error);
    process.exit(1);
});
