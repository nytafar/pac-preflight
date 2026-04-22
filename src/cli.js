/**
 * pac-preflight CLI entry.
 *
 * Usage:
 *   pac-preflight <file> [--strict] [--only=rule,rule] [--ignore=rule,rule]
 *   pac-preflight --stdin [flags] < markup
 *   pac-preflight --help | --version
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerCoreBlocks } from '@wordpress/block-library';
import { preflight } from './index.js';
import { applyFixes } from './fix.js';
import { transformReport } from './report-transform.js';

registerCoreBlocks();

const USAGE = `pac-preflight — block markup validator for Pages-as-Code

Usage:
  pac-preflight <file>
  pac-preflight --stdin
  pac-preflight --help | --version

Flags:
  --strict              Promote any non-info issue to fatal (exit 1).
  --only=<r1,r2,...>    Only run rules whose id starts with one of these prefixes.
  --ignore=<r1,r2,...>  Skip rules whose id starts with one of these prefixes.
  --stdin               Read markup body (no front matter) from stdin.
  --fix                 Apply auto-fixable repairs (rewrites file unless --dry-run).
  --dry-run             With --fix: compute repairs but do not write the file.
                        The final report includes a fixedContent field.
  --max-iterations=N    Cap the fix loop (default 3).
  --summary             Drop expected/actual/suggestedRepair from each issue.
  --diff                Replace expected/actual with a unified diff (3 lines context).
                        If --summary is also set, --summary wins.
`;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	process.stdout.write(USAGE);
	process.exit(0);
}
if (args.version) {
	process.stdout.write('pac-preflight 0.1.0-alpha.1\n');
	process.exit(0);
}

let source;
let sourcePath;
if (args.stdin) {
	source = readStdinSync();
	sourcePath = '<stdin>';
} else if (args.positional.length === 1) {
	sourcePath = args.positional[0];
	try {
		source = readFileSync(sourcePath, 'utf8');
	} catch (err) {
		process.stderr.write(`pac-preflight: cannot read ${sourcePath}: ${err.message}\n`);
		process.exit(2);
	}
} else {
	process.stderr.write(USAGE);
	process.exit(2);
}

const preflightOptions = {
	sourcePath,
	only: args.only,
	ignore: args.ignore,
	strict: args.strict,
};

let report;
if (args.fix) {
	const fixResult = applyFixes(
		source,
		(src) => preflight(src, preflightOptions),
		{ maxIterations: args.maxIterations },
	);
	report = fixResult.finalReport;
	report.fixes = {
		applied: fixResult.applied,
		iterations: fixResult.iterations,
		converged: fixResult.converged,
	};
	const changed = fixResult.source !== source;
	if (changed && !args.dryRun && !args.stdin) {
		try {
			writeFileSync(sourcePath, fixResult.source);
			report.fixes.wrote = sourcePath;
		} catch (err) {
			process.stderr.write(`pac-preflight: cannot write ${sourcePath}: ${err.message}\n`);
			process.exit(2);
		}
	}
	if (args.dryRun || args.stdin) {
		report.fixes.fixedContent = fixResult.source;
	}
} else {
	report = preflight(source, preflightOptions);
}

const transformed = transformReport(report, { summary: args.summary, diff: args.diff });
process.stdout.write(JSON.stringify(transformed, null, 2) + '\n');
process.exit(reportExitCode(report, args.strict));

function parseArgs(argv) {
	const out = {
		positional: [],
		strict: false,
		stdin: false,
		help: false,
		version: false,
		only: null,
		ignore: null,
		fix: false,
		dryRun: false,
		maxIterations: 3,
		summary: false,
		diff: false,
	};
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') out.help = true;
		else if (arg === '--version' || arg === '-v') out.version = true;
		else if (arg === '--strict') out.strict = true;
		else if (arg === '--stdin') out.stdin = true;
		else if (arg === '--fix') out.fix = true;
		else if (arg === '--dry-run') out.dryRun = true;
		else if (arg === '--summary') out.summary = true;
		else if (arg === '--diff') out.diff = true;
		else if (arg.startsWith('--max-iterations=')) {
			const n = Number.parseInt(arg.slice(17), 10);
			if (!Number.isFinite(n) || n < 1) {
				process.stderr.write(`pac-preflight: --max-iterations must be a positive integer\n`);
				process.exit(2);
			}
			out.maxIterations = n;
		}
		else if (arg.startsWith('--only=')) out.only = arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
		else if (arg.startsWith('--ignore=')) out.ignore = arg.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
		else if (arg.startsWith('--')) {
			process.stderr.write(`pac-preflight: unknown flag ${arg}\n`);
			process.exit(2);
		} else {
			out.positional.push(arg);
		}
	}
	return out;
}

function readStdinSync() {
	try {
		return readFileSync(0, 'utf8');
	} catch (err) {
		process.stderr.write(`pac-preflight: stdin read failed: ${err.message}\n`);
		process.exit(2);
	}
}

function reportExitCode(report, strict) {
	if (report.summary.fatal > 0) return 1;
	if (strict && (report.summary.warning > 0 || report.summary.info > 0)) return 1;
	return 0;
}
