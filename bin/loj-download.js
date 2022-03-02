#!/usr/bin/env node

/* eslint-disable consistent-return */

const fs = require('fs-extra');
const esbuild = require('esbuild');

if (!process.env.NODE_APP_INSTANCE) process.env.NODE_APP_INSTANCE = '0';
const major = +process.version.split('.')[0].split('v')[1];
const minor = +process.version.split('.')[1];

let transformTimeUsage = 0;
let transformCount = 0;
function transform(filename) {
    const start = Date.now();
    const code = fs.readFileSync(filename, 'utf-8');
    const result = esbuild.transformSync(code, {
        sourcefile: filename,
        sourcemap: 'both',
        format: 'cjs',
        loader: 'tsx',
        target: `node${major}.${minor}`,
        jsx: 'transform',
    });
    if (result.warnings.length) console.warn(result.warnings);
    transformTimeUsage += Date.now() - start;
    transformCount++;
    return result.code;
}

require.extensions['.ts'] = require.extensions['.tsx'] = function loader(module, filename) {
    return module._compile(transform(filename), filename);
};

require('../index.ts');
