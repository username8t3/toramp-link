import {execFileSync} from 'node:child_process';
import {readFileSync, lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set([
  '.gitignore', '.github/dependabot.yml', '.github/workflows/ci.yml', '.github/workflows/publish.yml',
  'CONTRIBUTING.md', 'LICENSE', 'README.md', 'RELEASE-CHECKLIST.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'rollup.config.mjs',
  'src/brand.ts', 'src/client.ts', 'src/gateway.ts', 'src/lampa.js', 'src/models.ts', 'src/parser.ts', 'src/transport.ts',
  'tests/bundle.test.ts', 'tests/direct.test.ts', 'tests/transport.test.ts', 'scripts/check-public.mjs'
]);
const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);
if (!tracked.length) throw Error('Stage the public project files before checking its publication boundary.');
const problems = [];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/
];
for (const path of tracked) {
  if (!allowed.has(path)) {problems.push('Unapproved public file: ' + path); continue;}
  if (!lstatSync(new URL('../' + path, import.meta.url)).isFile()) {problems.push('Public file must be a regular file: ' + path); continue;}
  const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  if (secretPatterns.some(pattern => pattern.test(text))) problems.push('Possible private material in: ' + path);
}
if (problems.length) throw Error(problems.join('\n'));
console.log('Public boundary checked: ' + tracked.length + ' approved files, no detected private material.');
