// ESLint flat config (ESLint v9+). Replaces the legacy .eslintrc.json.
// Intentionally minimal: it preserves the project's existing rule intent so
// `npm run lint` runs and passes, rather than introducing a strict ruleset.
const tseslint = require('typescript-eslint');

module.exports = [
    {
        ignores: ['out/**', 'dist/**', '**/*.d.ts', '**/*.js.map', 'node_modules/**'],
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 2021,
            sourceType: 'module',
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        rules: {
            '@typescript-eslint/naming-convention': 'warn',
            curly: 'warn',
            eqeqeq: 'warn',
            'no-throw-literal': 'warn',
            semi: 'off',
        },
    },
];
