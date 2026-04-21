/**
 * Check: attr_schema_type / attr_schema_enum
 *
 * Reads the RAW attribute JSON from the block comment (before @wordpress/blocks'
 * asType() silently coerces `"2"` into `2`) and checks each key against the
 * block type's declared `attributes` schema.
 *
 * Only two sub-rules in v1:
 *   - attr_schema_type: value's JS type does not match declared `type`.
 *   - attr_schema_enum: value not in declared `enum`.
 *
 * Unknown attrs are NOT flagged; Gutenberg tolerates them, and agents may emit
 * forward-compatible attrs. Revisit once we have data.
 */
export function checkAttrSchema({ token, blockType }) {
	if (!blockType || !token.attrsJsonRaw) return [];

	let rawAttrs;
	try {
		rawAttrs = JSON.parse(token.attrsJsonRaw);
	} catch {
		return [
			{
				severity: 'warning',
				path: token.path,
				blockName: token.name,
				byteRange: token.openCommentRange,
				rule: 'attr_schema_invalid_json',
				message: 'Block comment attribute payload is not valid JSON.',
				actual: token.attrsJsonRaw,
			},
		];
	}

	const schema = blockType.attributes ?? {};
	const issues = [];

	for (const [key, value] of Object.entries(rawAttrs)) {
		const def = schema[key];
		if (!def) continue;

		const declared = Array.isArray(def.type) ? def.type : def.type ? [def.type] : null;
		if (declared && !declared.some((t) => matchesType(value, t))) {
			issues.push({
				severity: 'warning',
				path: token.path,
				blockName: token.name,
				byteRange: token.openCommentRange,
				rule: 'attr_schema_type',
				message: `Attribute '${key}' declared as ${declared.join('|')} but received ${jsType(value)}.`,
				expected: declared.join('|'),
				actual: jsType(value),
				autoFixable: false,
			});
		}

		if (def.enum && !def.enum.includes(value)) {
			issues.push({
				severity: 'warning',
				path: token.path,
				blockName: token.name,
				byteRange: token.openCommentRange,
				rule: 'attr_schema_enum',
				message: `Attribute '${key}' value ${JSON.stringify(value)} outside declared enum.`,
				expected: def.enum,
				actual: value,
				autoFixable: false,
			});
		}
	}

	return issues;
}

function matchesType(value, declared) {
	switch (declared) {
		case 'string':  return typeof value === 'string';
		case 'number':  return typeof value === 'number';
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'boolean': return typeof value === 'boolean';
		case 'array':   return Array.isArray(value);
		case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
		case 'null':    return value === null;
		default:        return true;
	}
}

function jsType(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}
