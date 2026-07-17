//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');
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
            },
            // jsdom's style-rules.js reads default-stylesheet.css via fs.readFileSync at require() time
            // using __dirname-relative path resolution. When webpack bundles jsdom, __dirname gets
            // rewritten to the output directory, so the CSS file can't be found at runtime.
            // Solution: intercept the CSS file import and inline it as a string constant.
            {
                test: /jsdom\/lib\/jsdom\/browser\/default-stylesheet\.css$/,
                type: 'asset/source'
            },
            // Transform jsdom's style-rules.js at build time: replace the fs.readFileSync(__dirname-relative)
            // call with a require() that webpack can resolve and inline. The loader lives in webpack-loaders/
            // and transforms the actual jsdom source each build — no static copy checked in.
            {
                test: /jsdom\/lib\/jsdom\/living\/helpers\/style-rules\.js$/,
                use: [
                    {
                        loader: path.resolve(__dirname, 'webpack-loaders', 'jsdom-css-inline-loader.js')
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
                    from: 'src/webview/*.js',
                    to: 'webview/[name][ext]',
                    noErrorOnMissing: true
                },
                {
                    from: 'src/webview/*.css',
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
const standaloneConfig = {
    target: 'node',
    mode: extensionConfig.mode,
    entry: './src/standalone/cli.ts',
    output: {
        path: path.resolve(__dirname, 'dist', 'standalone'),
        filename: 'cli.js',
        libraryTarget: 'commonjs2'
    },
    externals: {
        vscode: 'commonjs vscode' // not imported, but ensures any stray dynamic require stays external
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: extensionConfig.module,
    devtool: 'nosources-source-map',
    infrastructureLogging: {
        level: 'log'
    },
    node: {
        __dirname: false
    },
    plugins: [
        new webpack.BannerPlugin({
            banner: '#!/usr/bin/env node',
            raw: true,
            entryOnly: true
        })
    ]
};

module.exports = [extensionConfig, standaloneConfig];
