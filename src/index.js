/**
 * Main pac-preflight API.
 *
 * Takes a PAC page source string, returns a JSON-serializable report.
 */
import { parse, serialize, validateBlock, getBlockType } from '@wordpress/blocks';
import { splitFrontMatter } from './parse-file.js';
import { tokenizeBlocks } from './tokenize-blocks.js';
import { checkInvalidBlockContent } from './checks/invalid-block-content.js';
import { checkCanonicalDrift } from './checks/canonical-drift.js';
import { checkAttrSchema } from './checks/attr-schema.js';

/**
 * Run all registered checks on a source string.
 *
 * @param {string} source         Full PAC page source (front matter + body).
 * @param {object} [options]
 * @param {string} [options.sourcePath]  Path echoed into the `source` field.
 * @param {string[]} [options.only]      Only run rules whose id starts with one of these.
 * @param {string[]} [options.ignore]    Skip rules whose id starts with one of these.
 * @param {boolean} [options.strict]     Promote non-info issues to exit-code-fatal.
 * @returns {object} PAC-compatible report.
 */
export function preflight(source, options = {}) {
	const { sourcePath = null, only = null, ignore = null, strict = false } = options;

	const { body, bodyOffset } = splitFrontMatter(source);
	const { roots: tokens, errors: tokenizerErrors } = tokenizeBlocks(body, bodyOffset);

	const issues = [];
	let blockCount = 0;

	for (const err of tokenizerErrors) {
		issues.push({
			severity: 'fatal',
			path: '',
			blockName: err.name ?? null,
			byteRange: err.byteRange,
			rule: `tokenizer_${err.kind}`,
			message: tokenizerMessage(err),
		});
	}

	const visit = (token) => {
		blockCount += 1;
		const blockType = getBlockType(token.name);
		const parsedBlock = parseSingleBlock(source.slice(token.byteRange[0], token.byteRange[1]));

		const ctx = { token, blockType, parsedBlock, source };

		if (ruleEnabled('invalid_block_content', only, ignore)) {
			issues.push(...checkInvalidBlockContent(ctx));
		}
		if (ruleEnabled('canonical_drift', only, ignore)) {
			issues.push(...checkCanonicalDrift(ctx));
		}
		if (ruleEnabled('attr_schema', only, ignore)) {
			issues.push(...checkAttrSchema(ctx));
		}

		for (const child of token.innerBlocks) {
			visit(child);
		}
	};

	for (const token of tokens) {
		visit(token);
	}

	const summary = { blocks: blockCount, fatal: 0, warning: 0, info: 0 };
	for (const issue of issues) summary[issue.severity] = (summary[issue.severity] ?? 0) + 1;

	const ok = strict
		? issues.every((i) => i.severity === 'info')
		: summary.fatal === 0;

	return {
		ok,
		source: sourcePath,
		preflightVersion: '0.1.0-alpha.1',
		gutenbergVersion: gutenbergVersion(),
		summary,
		issues,
	};
}

function parseSingleBlock(slice) {
	const blocks = parse(slice);
	return blocks[0] ?? null;
}

function ruleEnabled(ruleBase, only, ignore) {
	if (only && !only.some((prefix) => ruleBase.startsWith(prefix))) return false;
	if (ignore && ignore.some((prefix) => ruleBase.startsWith(prefix))) return false;
	return true;
}

function tokenizerMessage(err) {
	switch (err.kind) {
		case 'unmatched_close':
			return `Unmatched closing delimiter for ${err.name}.`;
		case 'unterminated_block':
			return `Opening delimiter for ${err.name} has no matching close.`;
		case 'malformed_attrs':
			return `Block ${err.name} has malformed attribute payload: ${err.detail}`;
		default:
			return `Tokenizer error: ${err.kind}`;
	}
}

function gutenbergVersion() {
	try {
		const pkg = require('@wordpress/block-library/package.json');
		return pkg.version;
	} catch {
		return 'unknown';
	}
}

// Re-export utilities for testing.
export { splitFrontMatter, tokenizeBlocks };
