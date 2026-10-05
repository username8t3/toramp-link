import typescript from '@rollup/plugin-typescript';
import {babel} from '@rollup/plugin-babel';

export default {
  input: 'src/lampa.js',
  output: {file: 'dist/toramp-link.js', format: 'iife', sourcemap: false, banner: '/* Toramp Link 0.5.0-beta.1 — experimental direct client */'},
  plugins: [
    typescript({noEmit: false, declaration: false}),
    babel({babelHelpers: 'bundled', extensions: ['.js', '.ts'], exclude: 'node_modules/**', presets: [['@babel/preset-env', {targets: {chrome: '56'}, modules: false}]]})
  ]
};
