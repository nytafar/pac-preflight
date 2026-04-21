/**
 * Block comment tokenizer with byte-offset tracking.
 *
 * @wordpress/block-serialization-default-parser produces a semantic tree but
 * no source positions. We need positions to splice `expected` values back in
 * during the agent loop, and we need the raw JSON string from the block
 * comment before parse()'s asType() coerces it.
 *
 * Returned tree shape per node:
 *   {
 *     name: 'core/heading',            // always namespace-qualified
 *     path: '2/0',                     // tree path for reporting
 *     byteRange: [start, end],         // offsets in the SOURCE FILE
 *     openCommentRange: [start, end],
 *     closeCommentRange: [start, end] | null,
 *     attrsJsonRaw: '{"level":2}' | null,
 *     innerHTML: '...',                // slice between open and close
 *     innerBlocks: Token[],
 *     selfClosing: boolean,
 *   }
 *
 * Unmatched closers and unterminated openers are reported via the errors array.
 */

// Match <!-- wp:name ... --> or <!-- /wp:name ... --> or <!-- wp:name ... /-->
// Group 1: '/' if closing; group 2: name; group 3: body between name and -->
const COMMENT_RE = /<!--\s+(\/)?wp:([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?)((?:[^-]|-(?!->))*)-->/g;

export function tokenizeBlocks(body, bodyOffset = 0) {
	const errors = [];
	const roots = [];
	const stack = []; // { token, childIndex }

	COMMENT_RE.lastIndex = 0;
	let match;
	while ((match = COMMENT_RE.exec(body)) !== null) {
		const [raw, closingSlash, rawName, trailing] = match;
		const commentStart = match.index;
		const commentEnd = commentStart + raw.length;
		const name = rawName.includes('/') ? rawName : `core/${rawName}`;

		if (closingSlash) {
			const parent = stack[stack.length - 1];
			if (!parent || parent.token.name !== name) {
				errors.push({
					kind: 'unmatched_close',
					name,
					byteRange: [commentStart + bodyOffset, commentEnd + bodyOffset],
				});
				continue;
			}
			parent.token.closeCommentRange = [
				commentStart + bodyOffset,
				commentEnd + bodyOffset,
			];
			parent.token.byteRange[1] = commentEnd + bodyOffset;
			parent.token.innerHTML = body.slice(
				parent.token.openCommentRange[1] - bodyOffset,
				commentStart,
			);
			stack.pop();
			continue;
		}

		const { attrsJsonRaw, selfClosing, parseError } = parseOpenTrailing(trailing);
		if (parseError) {
			errors.push({
				kind: 'malformed_attrs',
				name,
				byteRange: [commentStart + bodyOffset, commentEnd + bodyOffset],
				detail: parseError,
			});
		}

		const token = {
			name,
			path: buildPath(stack, roots.length),
			byteRange: [commentStart + bodyOffset, commentEnd + bodyOffset],
			openCommentRange: [commentStart + bodyOffset, commentEnd + bodyOffset],
			closeCommentRange: null,
			attrsJsonRaw,
			innerHTML: '',
			innerBlocks: [],
			selfClosing,
		};

		const parent = stack[stack.length - 1];
		if (parent) {
			parent.token.innerBlocks.push(token);
		} else {
			roots.push(token);
		}

		if (!selfClosing) {
			stack.push({ token });
		}
	}

	for (const frame of stack) {
		errors.push({
			kind: 'unterminated_block',
			name: frame.token.name,
			byteRange: frame.token.openCommentRange,
		});
	}

	return { roots, errors };
}

function parseOpenTrailing(trailing) {
	// trailing is the text between the block name and '-->'.
	// Could be: '', ' ', ' /', ' {...json...}', ' {...json...} /'
	const trimmed = trailing.trim();
	if (trimmed === '') {
		return { attrsJsonRaw: null, selfClosing: false };
	}
	if (trimmed === '/') {
		return { attrsJsonRaw: null, selfClosing: true };
	}
	let remainder = trimmed;
	let selfClosing = false;
	if (remainder.endsWith('/')) {
		selfClosing = true;
		remainder = remainder.slice(0, -1).trim();
	}
	if (remainder === '') {
		return { attrsJsonRaw: null, selfClosing };
	}
	if (!remainder.startsWith('{') || !remainder.endsWith('}')) {
		return {
			attrsJsonRaw: remainder,
			selfClosing,
			parseError: 'attribute payload is not a JSON object',
		};
	}
	return { attrsJsonRaw: remainder, selfClosing };
}

function buildPath(stack, rootsLength) {
	if (stack.length === 0) {
		return String(rootsLength);
	}
	const parent = stack[stack.length - 1].token;
	return `${parent.path}/${parent.innerBlocks.length}`;
}

export function walkTokens(tokens, visit, path = '') {
	for (const token of tokens) {
		visit(token);
		if (token.innerBlocks.length > 0) {
			walkTokens(token.innerBlocks, visit, token.path);
		}
	}
}
