/**
 * Check: canonical_drift
 *
 * Compares the block's source slice against serialize(parsedBlock). Flags
 * cosmetic drift the editor would silently normalize on save. Reported at
 * `info` severity by default because it's churny, not broken — but valuable
 * for `--fix` and for keeping files tight.
 *
 * Whitespace-only diffs inside the slice are ignored entirely for v1: sibling
 * blank lines and indentation are a human-formatting concern we don't want
 * to fight.
 */
import { serialize } from '@wordpress/blocks';

export function checkCanonicalDrift({ token, blockType, parsedBlock, source }) {
	if (!blockType || !parsedBlock) return [];

	const actual = source.slice(token.byteRange[0], token.byteRange[1]);
	const expected = serialize(parsedBlock);

	if (expected === actual) return [];
	if (normalizeWhitespace(expected) === normalizeWhitespace(actual)) return [];

	return [
		{
			severity: 'info',
			path: token.path,
			blockName: token.name,
			byteRange: token.byteRange,
			rule: 'canonical_drift',
			message: 'Block differs from canonical serialization; editor may rewrite on save.',
			expected,
			actual,
			autoFixable: true,
			suggestedRepair: { kind: 'replace_byte_range', with: expected },
		},
	];
}

function normalizeWhitespace(s) {
	return s.replace(/\s+/g, ' ').trim();
}
