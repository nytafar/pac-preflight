# pac-preflight

Pre-push validator for Pages-as-Code block markup. Uses Gutenberg itself as the oracle.

Answers the question: *would the Gutenberg editor flag this block as invalid, or canonicalize it differently on save?* — before the page is pushed to WordPress.

See [../preflight-spec.md](../preflight-spec.md) for the full design.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
pac-preflight <file.html>                # JSON report to stdout
pac-preflight --stdin < markup           # raw body, no front matter
pac-preflight <file> --strict            # any non-info issue is fatal
pac-preflight <file> --only=<rules>      # run subset of checks
pac-preflight <file> --ignore=<rules>    # skip specific checks
```

Exit codes: `0` if all issues are `info`, `1` otherwise, `2` on tool error.

## Status

Phase 1 — core checks implemented and passing fixture tests:

- [x] `invalid_block_content` — editor-invalidity (the banner trigger)
- [x] `canonical_drift` — cosmetic drift from canonical form (info)
- [x] `attr_schema_type` / `attr_schema_enum` — schema violations pre-coercion
- [x] Tokenizer with byte offsets; front-matter-aware
- [x] CLI flags: `--strict`, `--only`, `--ignore`, `--stdin`
- [x] Test runner (`npm test`) against fixture corpus

Later phases: deprecated-shape detection, nesting/required-attrs, `--fix`, skill integration, plugin integration.

## Development

```bash
npm run build       # bundle via esbuild
npm test            # run fixture-based tests
```

Source layout:

```
src/
  cli.js                          CLI entry (parses args, calls preflight())
  index.js                        programmatic API
  parse-file.js                   front matter split
  tokenize-blocks.js              block comment tokenizer w/ byte offsets
  checks/
    invalid-block-content.js     wraps @wordpress/blocks validateBlock()
    canonical-drift.js           serialize() round-trip diff
    attr-schema.js               raw JSON type/enum check
```

### DOM bootstrap

`@wordpress/block-library` transitively imports `@wordpress/block-editor` + `react-dom`, which assume a browser environment (read `window`/`document` at module-top-level). The esbuild bundle installs a jsdom-backed `window` via the banner, which runs before any bundled module evaluates. This is why `npm install` pulls jsdom as a runtime dep.
