import * as path from 'path';
import * as os from 'os';

export function isTestProcess(): boolean {
    if (process.env.SWITCHBOARD_TEST === '1') {
        return true;
    }
    const entry = require.main?.filename ?? process.argv[1] ?? '';
    const argvStr = process.argv.join(' ');
    if (/[\\/](src|out)[\\/]test[\\/]/.test(entry) || /\.test\.(js|ts)$/.test(entry)) {
        return true;
    }
    if (argvStr.includes('vscode-test') || argvStr.includes('--extensionTestsPath')) {
        return true;
    }
    return false;
}

export function stateHome(): string {
    const envVal = process.env.SWITCHBOARD_STATE_HOME;
    if (envVal && envVal.trim() !== '') {
        return path.resolve(envVal.trim());
    }

    if (isTestProcess()) {
        const msg = '[stateHome] Refusing to touch the real ~/.switchboard from a test process. Preload src/test/bootstrap/sandboxStateHome.js or set SWITCHBOARD_STATE_HOME.';
        console.error(msg);
        throw new Error(msg);
    }

    return os.homedir();
}

export function stateFile(...segments: string[]): string {
    return path.join(stateHome(), '.switchboard', ...segments);
}
