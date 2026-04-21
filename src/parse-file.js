/**
 * Split PAC front matter from block body. Matches PAC_File::split_front_matter.
 *
 * Returns:
 *   { frontMatter: string|null, body: string, bodyOffset: number }
 *
 * bodyOffset is the byte index into the original source where the body begins.
 * Callers report issue byteRanges in source-file coordinates, so they add
 * bodyOffset to any offset found inside the body.
 */
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function splitFrontMatter(source) {
	const match = FRONT_MATTER_RE.exec(source);
	if (!match) {
		return { frontMatter: null, body: source, bodyOffset: 0 };
	}
	return {
		frontMatter: match[1],
		body: source.slice(match[0].length),
		bodyOffset: match[0].length,
	};
}
