/**
 * Check: bare_html
 *
 * Text between top-level blocks (before the first, between two, after the last)
 * is not inside any block comment. Plain HTML comments there are ignored. WordPress turns it into a freeform block or
 * drops it, so it never renders as written. Fatal and not auto-fixable: wrapping
 * it in wp:html would hide what was meant to be a real block.
 *
 * Skipped when the tokenizer reported errors: an unterminated block leaves its
 * content outside every range, and the tokenizer error already names the cause.
 */
export function checkBareHtml({ roots, body, bodyOffset, source }) {
	const issues = [];
	let cursor = bodyOffset;
	const gaps = [];
	for (const token of roots) {
		gaps.push([cursor, token.byteRange[0]]);
		cursor = token.byteRange[1];
	}
	gaps.push([cursor, bodyOffset + body.length]);

	for (const [start, end] of gaps) {
		// Plain HTML comments (section dividers, notes) render nothing; only flag real markup or text.
		const text = source.slice(start, end).replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
		const lead = text.length - text.trimStart().length;
		const trimmed = text.trim();
		if (trimmed === '') continue;
		const from = start + lead;
		const line = source.slice(0, from).split('\n').length;
		issues.push({
			severity: 'fatal',
			path: '',
			blockName: null,
			byteRange: [from, from + trimmed.length],
			rule: 'bare_html',
			message: `Line ${line}: HTML outside any block comment; WordPress won't keep it as written. Wrap it in a block (or wp:html): ${snippet(trimmed)}`,
			actual: trimmed,
			autoFixable: false,
		});
	}
	return issues;
}

function snippet(s) {
	const one = s.replace(/\s+/g, ' ');
	return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}
