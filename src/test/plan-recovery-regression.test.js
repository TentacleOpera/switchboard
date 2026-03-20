'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');
const htmlPath = path.join(__dirname, '..', 'webview', 'implementation.html');
const html = fs.readFileSync(htmlPath, 'utf8');

describe('plan recovery regressions', () => {
    // Backend: _getRecoverablePlans exists and queries archived/orphan statuses
    it('_getRecoverablePlans returns archived and orphan entries only', () => {
        assert.match(
            source,
            /private _getRecoverablePlans\(\).*\{[\s\S]*entry\.status === 'archived' \|\| entry\.status === 'orphan'/,
            'Expected _getRecoverablePlans to filter for archived and orphan statuses.'
        );
    });

    it('_getRecoverablePlans excludes active entries', () => {
        assert.doesNotMatch(
            source,
            /_getRecoverablePlans[\s\S]*entry\.status === 'active'[\s\S]*recoverable\.push/,
            'Expected _getRecoverablePlans not to include active entries.'
        );
    });

    // Backend: _handleRestorePlan sets status to active
    it('_handleRestorePlan sets status to active', () => {
        assert.match(
            source,
            /private async _handleRestorePlan\(planId: string\)[\s\S]*entry\.status = 'active'/,
            'Expected _handleRestorePlan to set entry status to active.'
        );
    });

    it('_handleRestorePlan rejects entries not in archived or orphan status', () => {
        assert.match(
            source,
            /_handleRestorePlan[\s\S]*entry\.status !== 'archived' && entry\.status !== 'orphan'/,
            'Expected _handleRestorePlan to reject non-recoverable statuses.'
        );
    });

    it('_handleRestorePlan claims orphaned plans to current workspace', () => {
        assert.match(
            source,
            /_handleRestorePlan[\s\S]*entry\.status === 'orphan'[\s\S]*entry\.ownerWorkspaceId/,
            'Expected _handleRestorePlan to assign ownerWorkspaceId for orphan plans.'
        );
    });

    it('_handleRestorePlan removes tombstone on brain plan restore', () => {
        assert.match(
            source,
            /_handleRestorePlan[\s\S]*this\._tombstones\.delete\(pathHash\)/,
            'Expected _handleRestorePlan to remove tombstone for restored brain plans.'
        );
    });

    it('_handleRestorePlan warns when brain file is missing', () => {
        assert.match(
            source,
            /_handleRestorePlan[\s\S]*Cannot restore: brain file no longer exists/,
            'Expected _handleRestorePlan to warn when brain file is missing.'
        );
    });

    // Message wiring: getRecoverablePlans and restorePlan cases exist
    it('message handler includes getRecoverablePlans case', () => {
        assert.match(
            source,
            /case 'getRecoverablePlans'[\s\S]*this\._getRecoverablePlans\(\)/,
            'Expected message handler to include getRecoverablePlans case.'
        );
    });

    it('message handler includes restorePlan case', () => {
        assert.match(
            source,
            /case 'restorePlan'[\s\S]*this\._handleRestorePlan\(data\.planId\)/,
            'Expected message handler to include restorePlan case.'
        );
    });

    // restorePlan sends updated recoverablePlans list back
    it('restorePlan sends updated recoverable list on success', () => {
        assert.match(
            source,
            /case 'restorePlan'[\s\S]*recoverablePlans[\s\S]*plans/,
            'Expected restorePlan handler to send updated recoverablePlans.'
        );
    });

    // UI: RECOVER button exists
    it('webview has RECOVER button left of DELETE', () => {
        assert.match(
            html,
            /id="btn-recover-plans"[\s\S]*?RECOVER[\s\S]*?id="btn-delete-plan"/,
            'Expected RECOVER button to appear before DELETE button in HTML.'
        );
    });

    // UI: recovery modal exists
    it('webview has recovery modal with plan list container', () => {
        assert.match(
            html,
            /id="recover-plans-modal"[\s\S]*class="modal-overlay/,
            'Expected recovery modal overlay in HTML.'
        );
        assert.match(
            html,
            /id="recover-plan-list"/,
            'Expected recover-plan-list container in HTML.'
        );
    });

    // UI: recovery modal has search input
    it('webview recovery modal has search/filter input', () => {
        assert.match(
            html,
            /id="recover-search"/,
            'Expected recovery modal to have search input.'
        );
    });

    // UI: recovery modal message wiring
    it('webview handles recoverablePlans message', () => {
        assert.match(
            html,
            /case 'recoverablePlans'[\s\S]*renderRecoverablePlans/,
            'Expected webview to handle recoverablePlans message.'
        );
    });

    // Dropdown still strict: only active + owned
    it('dropdown still restricts to owned active entries', () => {
        assert.match(
            source,
            /const ownedActiveEntries = Object\.values\(this\._planRegistry\.entries\)\.filter\(\(entry\) =>[\s\S]*entry\.ownerWorkspaceId === this\._workspaceId && entry\.status === 'active'/,
            'Expected _refreshRunSheets to still filter to owned active entries only.'
        );
    });

    // _handleRestorePlan logs recovery event
    it('_handleRestorePlan logs plan_management restore event', () => {
        assert.match(
            source,
            /_handleRestorePlan[\s\S]*_logEvent\('plan_management'[\s\S]*operation: 'restore_plan'/,
            'Expected _handleRestorePlan to log a restore_plan event.'
        );
    });
});
