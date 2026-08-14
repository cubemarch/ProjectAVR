import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'sw.js',
  'assets/icon.svg',
  'src/app.js',
  'src/catalog.js',
  'src/media-utils.js',
  'src/stream-adapter.js',
  'src/vr-player.js',
  'README.md',
  'docs/compatibility.md',
  'docs/media-server.md'
];

const errors = [];
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) errors.push(`Missing required file: ${file}`);
}

const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const vrSource = readFileSync(resolve(root, 'src/vr-player.js'), 'utf8');
const streamSource = readFileSync(resolve(root, 'src/stream-adapter.js'), 'utf8');

if (!html.includes('id="xrCanvas"')) errors.push('index.html must include the WebXR canvas.');
if (!html.includes('id="mediaVideo"')) errors.push('index.html must include the HTML media element.');
if (!vrSource.includes('playcanvas@2.21.4')) errors.push('PlayCanvas must be pinned to 2.21.4.');
if (!streamSource.includes('hls.js@1.7.0')) errors.push('hls.js must be pinned to 1.7.0.');
if (!streamSource.includes('dashjs@5.2.0')) errors.push('dash.js must be pinned to 5.2.0.');
if (/\@(latest|next)\b/.test(`${vrSource}\n${streamSource}`)) errors.push('Runtime dependencies must not use moving tags.');
if (manifest.start_url !== './') errors.push('The web app manifest must remain subpath-safe.');
if (!packageJson.scripts?.test || !packageJson.scripts?.validate) errors.push('package.json must expose test and validate scripts.');

const localReferences = [...html.matchAll(/(?:href|src)="(\.\/[^"?#]+)/g)].map((match) => match[1].slice(2));
for (const reference of localReferences) {
  if (!existsSync(resolve(root, reference))) errors.push(`Broken local HTML reference: ${reference}`);
}

for (const file of ['sw.js', 'src/app.js', 'src/catalog.js', 'src/media-utils.js', 'src/stream-adapter.js', 'src/vr-player.js']) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) errors.push(`${file} failed syntax check:\n${result.stderr.trim()}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Validated ${requiredFiles.length} required files, pinned dependencies, local references, JSON, and JavaScript syntax.`);
