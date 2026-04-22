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
		fix: (report) => report.fixes.applied === 0 && report.fixes.converged,
		fixReason: '--fix should be a no-op on ok/ fixtures',
	},
	'invalid-block-content': {
		require: (report) => report.issues.some((i) => i.rule === 'invalid_block_content'),
		reason: 'expected invalid_block_content rule to fire',
		fix: (report) => {
			if (report.fixes.converged !== true) return false;
			const issue = report.issues.find((i) => i.rule === 'invalid_block_content');
			if (!issue) return true;
			// If the residual issue is unfixable, the loop must not have spun on it.
			// The converged check above plus the source-slice guard in collectRepairs
			// guarantees that. For the pure-noop fixture (cover-custom-hex-noop.html)
			// additionally require applied===0 since no initial fixes are legitimate.
			if (issue.autoFixable === false && report.fixes.iterations === 0) {
				return report.fixes.applied === 0;
			}
			return true;
		},
		fixReason: 'invalid_block_content with expected===actual must be autoFixable:false and --fix must converge without spinning',
	},
	'canonical-drift': {
		require: (report) => report.issues.some((i) => i.rule === 'canonical_drift'),
		reason: 'expected canonical_drift rule to fire',
		fix: (report) => report.fixes.converged && report.summary.info === 0 && report.summary.warning === 0,
		fixReason: '--fix should converge canonical_drift fixtures to a clean report',
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

		if (exp.fix) {
			checked += 1;
			const fixResult = spawnSync('node', [bundle, path, '--fix', '--dry-run'], { encoding: 'utf8' });
			let fixReport;
			try {
				fixReport = JSON.parse(fixResult.stdout);
			} catch (err) {
				console.error(`[fail] ${category}/${file} --fix: could not parse report — ${err.message}`);
				failures += 1;
				continue;
			}
			if (exp.fix(fixReport)) {
				console.log(`[ok]   ${category}/${file} --fix`);
			} else {
				console.error(`[fail] ${category}/${file} --fix: ${exp.fixReason}`);
				console.error(`       fixes:   ${JSON.stringify(fixReport.fixes)}`);
				console.error(`       summary: ${JSON.stringify(fixReport.summary)}`);
				failures += 1;
			}
		}
	}
}

// --- Output-mode assertions (Fix 1) -----------------------------------------
const driftFixture = resolve(fixturesRoot, 'canonical-drift/paragraph-extra-whitespace.html');

function runModes(flags) {
	const res = spawnSync('node', [bundle, driftFixture, ...flags], { encoding: 'utf8' });
	try {
		return JSON.parse(res.stdout);
	} catch (err) {
		return null;
	}
}

const modeCases = [
	{
		label: 'no-flags baseline',
		flags: [],
		check: (r) => r && r.issues[0] && typeof r.issues[0].expected === 'string' && typeof r.issues[0].actual === 'string',
		reason: 'issues[0] should have string expected and actual',
	},
	{
		label: '--summary',
		flags: ['--summary'],
		check: (r) => {
			if (!r || !r.issues[0]) return false;
			const i = r.issues[0];
			if ('expected' in i || 'actual' in i || 'suggestedRepair' in i) return false;
			return typeof i.rule === 'string' && typeof i.message === 'string' && typeof i.autoFixable === 'boolean';
		},
		reason: '--summary should drop expected/actual/suggestedRepair and keep rule/message/autoFixable',
	},
	{
		label: '--diff',
		flags: ['--diff'],
		check: (r) => {
			if (!r || !r.issues[0]) return false;
			const i = r.issues[0];
			if ('expected' in i || 'actual' in i) return false;
			if (typeof i.diff !== 'string') return false;
			if (!i.diff.includes('@@')) return false;
			if (!(i.diff.includes('\n+') || i.diff.includes('\n-') || i.diff.startsWith('+') || i.diff.startsWith('-'))) return false;
			// For canonical_drift, suggestedRepair.with equals expected, so --diff should drop .with
			// but preserve kind and byteRange metadata.
			if (i.rule === 'canonical_drift') {
				if (!i.suggestedRepair || 'with' in i.suggestedRepair) return false;
				if (i.suggestedRepair.kind !== 'replace_byte_range') return false;
				if (!Array.isArray(i.byteRange) || i.byteRange.length !== 2) return false;
			}
			return true;
		},
		reason: '--diff should replace expected/actual with a unified diff and drop suggestedRepair.with for canonical_drift',
	},
	{
		label: '--summary --diff',
		flags: ['--summary', '--diff'],
		check: (r) => {
			if (!r || !r.issues[0]) return false;
			const i = r.issues[0];
			if ('expected' in i || 'actual' in i || 'suggestedRepair' in i || 'diff' in i) return false;
			return typeof i.rule === 'string' && typeof i.message === 'string';
		},
		reason: '--summary --diff should produce summary-only shape (summary wins)',
	},
];

for (const c of modeCases) {
	checked += 1;
	const r = runModes(c.flags);
	if (c.check(r)) {
		console.log(`[ok]   output-mode ${c.label}`);
	} else {
		console.error(`[fail] output-mode ${c.label}: ${c.reason}`);
		failures += 1;
	}
}

// --- Exec-bit assertions (Fix 3) --------------------------------------------
const binPath = resolve(root, 'bin/pac-preflight.mjs');
const distPath = resolve(root, 'dist/pac-preflight.mjs');
const binMode = statSync(binPath).mode & 0o111;
const distMode = statSync(distPath).mode & 0o111;
checked += 2;
if (binMode !== 0) {
	console.log(`[ok]   bin/pac-preflight.mjs has exec bit`);
} else {
	console.error(`[fail] bin/pac-preflight.mjs missing exec bit (mode: ${statSync(binPath).mode.toString(8)})`);
	failures += 1;
}
if (distMode !== 0) {
	console.log(`[ok]   dist/pac-preflight.mjs has exec bit`);
} else {
	console.error(`[fail] dist/pac-preflight.mjs missing exec bit (mode: ${statSync(distPath).mode.toString(8)})`);
	failures += 1;
}

console.log(`\n${checked - failures}/${checked} passed`);
process.exit(failures > 0 ? 1 : 0);
