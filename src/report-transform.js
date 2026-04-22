/**
 * Report transformers for the pac-preflight CLI output layer.
 *
 * These operate on the JSON-serializable report produced by preflight().
 * They are pure-functional: the input report is never mutated.
 *
 *   --summary  Drop expected/actual/suggestedRepair from every issue.
 *   --diff     Replace expected/actual with a unified-diff `diff` field.
 *              Drop suggestedRepair.with when it equals expected (the common
 *              canonical_drift case) but keep kind/byteRange metadata.
 *
 * When both are set, --summary wins: summary-only shape.
 */
import { createPatch } from 'diff';

export function transformReport(report, opts = {}) {
	const { summary = false, diff = false } = opts;
	if (!summary && !diff) return report;

	const next = { ...report };
	next.issues = report.issues.map((issue) => {
		if (summary) return stripToSummary(issue);
		if (diff) return toDiffShape(issue);
		return issue;
	});
	return next;
}

function stripToSummary(issue) {
	const { expected, actual, suggestedRepair, diff, ...rest } = issue;
	return rest;
}

function toDiffShape(issue) {
	const { expected, actual, suggestedRepair, ...rest } = issue;
	if (typeof expected !== 'string' || typeof actual !== 'string') {
		// Nothing to diff — return the issue unchanged.
		return issue;
	}
	const out = { ...rest };
	out.diff = computeUnifiedDiff(expected, actual, issue.blockName);
	if (suggestedRepair && typeof suggestedRepair === 'object') {
		const repairCopy = { ...suggestedRepair };
		if (repairCopy.with === expected) {
			delete repairCopy.with;
		}
		out.suggestedRepair = repairCopy;
	} else if ('suggestedRepair' in issue) {
		out.suggestedRepair = suggestedRepair;
	}
	return out;
}

export function computeUnifiedDiff(expected, actual, blockName) {
	const name = blockName || 'block';
	const patch = createPatch(name, expected, actual, '', '', { context: 3 });
	// createPatch prepends a pair of "=== ..." header lines plus an "Index:" line.
	// Strip everything up to and including the first "@@" hunk header's line so
	// the output is just the @@/-/+/space lines agent pipelines want to read.
	const lines = patch.split('\n');
	const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
	if (firstHunk === -1) return '';
	return lines.slice(firstHunk).join('\n').replace(/\n$/, '');
}
