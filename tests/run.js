#!/usr/bin/env node
/**
 * Minimal fixture runner.
 *
 * Runs the bundled CLI against every tests/fixtures/**\/*.html, checks that
 * fixtures under ok/ pass, fixtures under invalid-block-content/ produce an
 * invalid_block_content warning, and fixtures under attr-schema/ produce an
 * attr_schema_* warning. Exits non-zero on any mismatch.
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const bundle = resolve(root, 'dist/pac-preflight.mjs');
const fixturesRoot = resolve(root, 'tests/fixtures');

const EXPECTATIONS = {
	ok: {
		require: (report) => report.summary.warning === 0 && report.summary.fatal === 0,
		reason: 'expected no warnings or fatals',
	},
	'invalid-block-content': {
		require: (report) => report.issues.some((i) => i.rule === 'invalid_block_content'),
		reason: 'expected invalid_block_content rule to fire',
	},
	'canonical-drift': {
		require: (report) => report.issues.some((i) => i.rule === 'canonical_drift'),
		reason: 'expected canonical_drift rule to fire',
	},
	'attr-schema': {
		require: (report) => report.issues.some((i) => i.rule.startsWith('attr_schema')),
		reason: 'expected attr_schema rule to fire',
	},
};

let failures = 0;
let checked = 0;

for (const category of readdirSync(fixturesRoot)) {
	const categoryDir = join(fixturesRoot, category);
	if (!statSync(categoryDir).isDirectory()) continue;
	const exp = EXPECTATIONS[category];
	if (!exp) {
		console.warn(`[warn] no expectation registered for fixture category ${category}`);
		continue;
	}
	for (const file of readdirSync(categoryDir)) {
		if (!file.endsWith('.html')) continue;
		const path = join(categoryDir, file);
		checked += 1;
		const result = spawnSync('node', [bundle, path], { encoding: 'utf8' });
		let report;
		try {
			report = JSON.parse(result.stdout);
		} catch (err) {
			console.error(`[fail] ${category}/${file}: could not parse report — ${err.message}`);
			failures += 1;
			continue;
		}
		if (exp.require(report)) {
			console.log(`[ok]   ${category}/${file}`);
		} else {
			console.error(`[fail] ${category}/${file}: ${exp.reason}`);
			console.error(`       summary: ${JSON.stringify(report.summary)}`);
			console.error(`       rules:   ${report.issues.map((i) => i.rule).join(', ') || '(none)'}`);
			failures += 1;
		}
	}
}

console.log(`\n${checked - failures}/${checked} passed`);
process.exit(failures > 0 ? 1 : 0);
