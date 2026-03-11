import path from 'node:path';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const files = ['index.html', 'sw.js', 'manifest.json', 'icon.svg'];

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const file of files) {
  await cp(path.join(rootDir, file), path.join(distDir, file));
}

console.log(`Prepared Netlify publish directory at ${distDir}`);
