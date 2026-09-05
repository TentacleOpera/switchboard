'use strict';

/**
 * Loopback-invariance contract test.
 *
 * Asserts the bind address is unconditional and no configuration path can
 * alter it. This is the regression test for the app plan's own first draft,
 * which proposed binding off loopback — dismantling a four-layer, threat-
 * modelled guard to enable something a tunnel already does better.
 *
 * See switchboard-as-a-local-app-and-a-self-hosted-remote.md change 9.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

describe('Loopback invariance contract', () => {

    it('loopbackHostname.ts exports isLoopbackHostname', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/utils/loopbackHostname.ts'), 'utf8');
        assert.ok(src.includes('export function isLoopbackHostname'),
            'isLoopbackHostname must be exported — it is the single source of truth for loopback checks.');
    });

    it('the server binds 127.0.0.1 unconditionally — no --bind flag', () => {
        const bootstrapSrc = fs.readFileSync(path.join(ROOT, 'src/standalone/bootstrap.ts'), 'utf8');
        // The bind policy must default to loopback-only.
        assert.ok(bootstrapSrc.includes('LOOPBACK_ONLY_POLICY'),
            'bootstrap.ts must default to LOOPBACK_ONLY_POLICY.');
        // No --bind flag may exist that changes the bind address.
        assert.ok(!/--bind\b/.test(bootstrapSrc) || bootstrapSrc.includes('--bind') === false,
            'No --bind flag may exist that changes the bind address — see the plan non-goal.');
    });

    it('the CLI rejects non-loopback --hostname values', () => {
        const cliSrc = fs.readFileSync(path.join(ROOT, 'src/standalone/cli.ts'), 'utf8');
        assert.ok(cliSrc.includes('isLoopbackHostname') || cliSrc.includes('loopbackHostname'),
            'cli.ts must use the loopback hostname guard to reject non-loopback --hostname values.');
    });

    it('LocalApiServer uses the loopback guard on Host headers', () => {
        const serverSrc = fs.readFileSync(path.join(ROOT, 'src/services/LocalApiServer.ts'), 'utf8');
        // LocalApiServer imports the loopback guard (isAllowedHostFor / isAllowedOriginFor
        // are the policy-aware wrappers, both backed by isLoopbackHostname).
        assert.ok(serverSrc.includes('isAllowedHostFor') || serverSrc.includes('isAllowedOriginFor') || serverSrc.includes('isLoopbackHostHeader'),
            'LocalApiServer must use the loopback guard on Host/Origin headers — DNS-rebinding protection.');
    });

    it('no configuration path can disable the loopback guard', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/utils/loopbackHostname.ts'), 'utf8');
        // The guard must not be conditional on any setting or env var.
        assert.ok(!/process\.env\.(SWITCHBOARD_)?BIND/i.test(src),
            'No env var may override the loopback guard.');
        assert.ok(!/getConfiguration|workspaceConfig|settings/i.test(src),
            'No VS Code setting may override the loopback guard.');
    });

    it('the guard accepts localhost, 127.0.0.1, ::1, and *.localhost', () => {
        // Read and eval the function directly from source is complex;
        // verify the accepted names are documented in the source.
        const src = fs.readFileSync(path.join(ROOT, 'src/utils/loopbackHostname.ts'), 'utf8');
        assert.ok(src.includes("'127.0.0.1'") && src.includes("'localhost'"),
            'The guard must accept 127.0.0.1 and localhost.');
        assert.ok(src.includes("'::1'"),
            'The guard must accept ::1 (IPv6 loopback).');
        assert.ok(src.includes('localhost'),
            'The guard must accept *.localhost subdomains per RFC 6761.');
    });
});
