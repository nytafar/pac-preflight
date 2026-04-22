#!/usr/bin/env node
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = [
	resolve(root, 'bin/pac-preflight.mjs'),
	resolve(root, 'dist/pac-preflight.mjs'),
];
for (const p of paths) {
	if (existsSync(p)) {
		chmodSync(p, 0o755);
		console.log(`pac-preflight: chmod +x ${p}`);
	}
}
