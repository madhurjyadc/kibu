// Keep the website's live dot-matrix face tied to the app's actual character.
// Run from the repository root: node website/sync-character.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/renderer/src/components/Sprite.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const COLS = 15');
const end = source.indexOf('\nexport function Sprite(');
if (start < 0 || end < start) throw new Error('Could not locate the shared Kibu face implementation.');
const { code } = await transform(source.slice(start, end), { loader: 'ts', format: 'esm', target: 'es2022' });
await writeFile(new URL('./dist/faces.js', import.meta.url), '// Generated from the app’s Sprite.tsx by sync-character.mjs.\n' + code);
