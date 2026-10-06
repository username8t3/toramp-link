import typescript from '@rollup/plugin-typescript';
import {babel} from '@rollup/plugin-babel';
import {readFileSync} from 'node:fs';

const license = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8');
const banner = '/* Toramp Link 0.5.0-beta.1 — experimental direct client\n' +
  'Copyright 2026 Dmitry Shevelev\n' +
  'SPDX-License-Identifier: Apache-2.0\n\n' + license + '\n*/';

export default {
  input: 'src/lampa.js',
  output: {file: 'dist/toramp-link.js', format: 'iife', sourcemap: false, banner},
  plugins: [
    typescript({noEmit: false, declaration: false}),
    babel({babelHelpers: 'bundled', extensions: ['.js', '.ts'], exclude: 'node_modules/**', presets: [['@babel/preset-env', {targets: {chrome: '56'}, modules: false}]]})
  ]
};
