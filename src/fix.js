/**
 * Apply auto-fixable repairs to a source string.
 *
 * Strategy:
 *   1. Run preflight, collect issues with `autoFixable: true` and a
 *      `replace_byte_range` repair.
 *   2. Drop any repair whose byte range is fully contained inside another
 *      repair's range. Serializing the outer block produces canonical children
 *      too, so fixing the parent subsumes the inner repairs.
 *   3. Sort remaining repairs by start offset descending and splice in place,
 *      so earlier offsets remain valid as we write.
 *   4. Re-run preflight on the new source. If it still has fixable issues and
 *      the source changed, loop. Cap at `maxIterations` to guarantee termination.
 *
 * Returns { source, iterations, applied, converged, finalReport }.
 */
export function applyFixes(initialSource, runPreflight, { maxIterations = 3 } = {}) {
	let source = initialSource;
	let iterations = 0;
	let applied = 0;
	let finalReport = null;
	let converged = false;

	while (iterations < maxIterations) {
		const report = runPreflight(source);
		finalReport = report;

		const repairs = collectRepairs(report.issues, source);
		if (repairs.length === 0) {
			converged = true;
			break;
		}

		const next = spliceAll(source, repairs);
		if (next === source) {
			// Repairs exist but produced no change — bail to avoid an infinite loop.
			break;
		}

		source = next;
		applied += repairs.length;
		iterations += 1;
	}

	return { source, iterations, applied, converged, finalReport };
}

function collectRepairs(issues, source) {
	const candidates = [];
	for (const issue of issues) {
		if (!issue.autoFixable) continue;
		const repair = issue.suggestedRepair;
		if (!repair || repair.kind !== 'replace_byte_range') continue;
		if (!Array.isArray(issue.byteRange) || issue.byteRange.length !== 2) continue;
		// Defensive: skip self-splice repairs where the replacement equals the
		// current source at the byte range. Prevents no-op "applied" counts
		// from emitting-time bugs in any check module.
		if (typeof source === 'string' && repair.with === source.slice(issue.byteRange[0], issue.byteRange[1])) continue;
		candidates.push({
			rule: issue.rule,
			severity: issue.severity,
			start: issue.byteRange[0],
			end: issue.byteRange[1],
			replacement: repair.with,
		});
	}

	// Drop repairs that are strictly contained inside another repair's range.
	// The outer block's canonical form already contains the corrected inner markup.
	const kept = [];
	for (const r of candidates) {
		const contained = candidates.some((other) =>
			other !== r && other.start <= r.start && other.end >= r.end && (other.start < r.start || other.end > r.end),
		);
		if (!contained) kept.push(r);
	}

	// If two repairs cover the same range, prefer invalid_block_content over canonical_drift:
	// the former indicates the editor would reject the block entirely.
	const deduped = new Map();
	for (const r of kept) {
		const key = `${r.start}:${r.end}`;
		const existing = deduped.get(key);
		if (!existing || severityRank(r) > severityRank(existing)) {
			deduped.set(key, r);
		}
	}

	return [...deduped.values()].sort((a, b) => b.start - a.start);
}

function severityRank(r) {
	if (r.rule === 'invalid_block_content') return 3;
	if (r.severity === 'fatal') return 2;
	if (r.severity === 'warning') return 1;
	return 0;
}

function spliceAll(source, repairs) {
	let out = source;
	for (const r of repairs) {
		out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
	}
	return out;
}
