/**
 * Check: invalid_block_content
 *
 * Runs Gutenberg's own validateBlock() — the function the editor uses to
 * decide whether to show the "Block contains unexpected or invalid content"
 * banner. Tolerates cosmetic noise (whitespace, attribute order, class token
 * order, void-tag variants) that serialize-equality would flag.
 */
import { validateBlock, serialize } from '@wordpress/blocks';

/**
 * Gutenberg's validator returns LogItems like { log: console.error, args: [fmt, ...] }
 * where fmt contains %s/%o placeholders. Substitute them to get readable reasons,
 * and drop the long "Block validation failed for..." template that just re-prints
 * the full markup — we already surface expected/actual.
 */
function summarizeLogItems(items) {
	if (!Array.isArray(items)) return [];
	const reasons = [];
	for (const item of items) {
		const args = item.args ?? [];
		const fmt = typeof args[0] === 'string' ? args[0] : '';
		if (fmt.startsWith('Block validation failed for')) continue;
		let i = 1;
		const interpolated = fmt.replace(/%[sod]/g, () => {
			const v = args[i++];
			if (v === null || v === undefined) return '';
			if (typeof v === 'string') return v;
			try { return JSON.stringify(v); } catch { return String(v); }
		});
		const trimmed = interpolated.replace(/\s+/g, ' ').trim();
		if (trimmed) reasons.push(trimmed);
	}
	return reasons;
}

export function checkInvalidBlockContent({ token, blockType, parsedBlock, source }) {
	if (!blockType || !parsedBlock) return [];

	const [isValid, logItems] = validateBlock(parsedBlock, blockType);
	if (isValid) return [];

	const expected = serialize(parsedBlock);
	const actual = source.slice(token.byteRange[0], token.byteRange[1]);
	const reasons = summarizeLogItems(logItems);

	return [
		{
			severity: 'warning',
			path: token.path,
			blockName: token.name,
			byteRange: token.byteRange,
			rule: 'invalid_block_content',
			message:
				'Block content does not match save() output; editor will flag as invalid.' +
				(reasons.length ? ` Reasons: ${reasons.join('; ')}` : ''),
			expected,
			actual,
			autoFixable: true,
			suggestedRepair: { kind: 'replace_byte_range', with: expected },
		},
	];
}
