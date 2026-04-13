//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
    target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
    mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

    entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: {
        // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2'
    },
    externals: {
        vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
        // modules added here also need to be added in the .vscodeignore file
    },
    resolve: {
        // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            compilerOptions: {
                                noEmit: false
                            }
                        }
                    }
                ]
            }
        ]
    },
    devtool: 'nosources-source-map',
    infrastructureLogging: {
        level: "log", // enables logging required for problem matchers
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    from: 'src/webview/*.html',
                    to: 'webview/[name][ext]'
                },
                {
                    from: 'src/webview/external-ai-hub.html',
                    to: 'webview/[name][ext]'
                },
                {
                    from: path.resolve(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
                    to: 'sql-wasm.js'
                },
                {
                    from: path.resolve(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
                    to: 'sql-wasm.wasm'
                }
            ]
        })
    ]
};

/** @type WebpackConfig */
const mcpServerConfig = {
    target: 'node',
    mode: 'none',
    entry: './src/mcp-server/mcp-server.js',
    output: {
        path: path.resolve(__dirname, 'dist', 'mcp-server'),
        filename: 'mcp-server.js',
        libraryTarget: 'commonjs'
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    // Do NOT exclude node_modules here - we want to bundle them!
    // But we must exclude vscode as it's not available in the MCP process
    externals: {
        vscode: 'commonjs vscode'
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{
                    loader: 'ts-loader',
                    options: {
                        compilerOptions: {
                            noEmit: false
                        }
                    }
                }]
            }
        ]
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    from: path.resolve(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
                    to: 'sql-wasm.js'
                },
                {
                    from: path.resolve(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
                    to: 'sql-wasm.wasm'
                }
            ]
        })
    ],
    devtool: 'nosources-source-map'
};

module.exports = [extensionConfig, mcpServerConfig];
