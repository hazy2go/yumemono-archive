// Bundles @vercel/blob/client into vendor/blob-client.js as an IIFE that
// exposes window.VercelBlobClient.upload to the static page.
//
// Run via `npm run build:blob-client`. The output is committed.
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const entryPath = join(SCRIPT_DIR, '.tmp-blob-entry.mjs');

writeFileSync(entryPath, `
import { upload } from '@vercel/blob/client';
window.VercelBlobClient = { upload };
`);

mkdirSync(join(ROOT, 'vendor'), { recursive: true });

await build({
  entryPoints: [entryPath],
  absWorkingDir: ROOT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  outfile: join(ROOT, 'vendor/blob-client.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});

console.log('Built vendor/blob-client.js');
