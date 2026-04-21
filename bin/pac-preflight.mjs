#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, '..', 'dist', 'pac-preflight.mjs');

if (!existsSync(dist)) {
	console.error('pac-preflight: bundle missing. Run `npm run build` first.');
	console.error(`Expected: ${dist}`);
	process.exit(2);
}

await import(dist);
