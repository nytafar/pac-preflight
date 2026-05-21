# pac-preflight — implementation plan for remaining work

Snapshot of the codebase as the starting point:

- `src/index.js` runs three checks per visited token: `invalid_block_content`, `canonical_drift`, `attr_schema`. The visit function already recurses into `token.innerBlocks` and constructs a context `{ token, blockType, parsedBlock, source }`.
- `src/tokenize-blocks.js` produces tree nodes with `path`, `byteRange`, `openCommentRange`, `closeCommentRange`, `attrsJsonRaw`, `innerHTML`, `innerBlocks`, `selfClosing`. No source-position info is missing for any planned check.
- `src/fix.js` already has a self-splice guard (`if (source.slice(start, end) === repair.with) skip`), so any new auto-fixable check that emits identity-replacements will not spin the loop.
- `src/report-transform.js` strips `expected`/`actual`/`suggestedRepair` for `--summary` and `--diff`. New rules that follow the same `expected` + `suggestedRepair: { kind: 'replace_byte_range', with }` shape get `--diff`/`--summary` support for free.
- The test runner in `tests/run.js` keys expectations off the fixture's directory name and supports a separate `fix:` predicate per category.

The work below is ordered so each task can land independently.

---

## Task #10 — `deprecated_shape_migrated`

### Goal

Detect when a block's source matches a deprecated shape and Gutenberg's parser silently migrated it on parse. This is the case for things like `core/paragraph`'s `align` → `style.typography.textAlign` rewrite — `validateBlock` returns `true` (the migrated block is valid) but on first save the editor will rewrite the markup. Today we surface this only as `canonical_drift` (info) without naming the cause.

### Detection algorithm

Two-pass `validateBlock`. Inside the existing visit:

1. `parsedBlock = parse(slice)[0]`. If `parsedBlock.isValid !== true`, skip — `invalid_block_content` already owns this case.
2. If `blockType.deprecated` is empty/undefined, skip — there's nothing to migrate from.
3. If `token.attrsJsonRaw` does not parse as JSON, skip — `attr_schema_invalid_json` owns it.
4. Build a synthetic block from the *raw* attrs and *raw* inner HTML:
   ```js
   const synthetic = {
     name: token.name,
     attributes: JSON.parse(token.attrsJsonRaw ?? '{}'),
     innerBlocks: parsedBlock.innerBlocks,
     originalContent: token.innerHTML,
     isValid: true,
   };
   ```
5. `const [okRaw] = validateBlock(synthetic, blockType);`
6. If `okRaw === false` AND `parsedBlock.isValid === true` — Gutenberg's `parse()` ran the deprecation chain. Emit:
   ```js
   {
     severity: 'info',
     path, blockName, byteRange,
     rule: 'deprecated_shape_migrated',
     message: 'Block matches a deprecated shape; editor will migrate it on save.',
     expected: serialize(parsedBlock),
     actual: source.slice(byteRange[0], byteRange[1]),
     autoFixable: true,
     suggestedRepair: { kind: 'replace_byte_range', with: serialize(parsedBlock) },
   }
   ```

### Interaction with existing checks

- `canonical_drift` will also fire for the same block (the source slice differs from `serialize(parsedBlock)`). That's acceptable — the rules answer different questions ("why is it drifting" vs "is it drifting"). To avoid double-flagging in agent feedback, drop `canonical_drift` from the issues list when `deprecated_shape_migrated` fires for the same `byteRange`. Implement the dedupe in `src/index.js` after the visit loop, before the summary count.
- `--fix` already handles overlapping repairs by preferring outer ranges; for two repairs covering the *same* range, the existing `severityRank()` in `src/fix.js` ranks `invalid_block_content` highest. Add a third tier so `deprecated_shape_migrated` outranks `canonical_drift` (their `with` is identical anyway, but ranking keeps the diagnostic clean if they ever diverge).

### File hooks

- New file: `src/checks/deprecation-migrated.js` (mirror the API of `src/checks/canonical-drift.js`).
- `src/index.js`:
  - import `checkDeprecationMigrated`
  - call inside `visit()` between `checkInvalidBlockContent` and `checkCanonicalDrift`
  - add post-visit dedupe pass that drops `canonical_drift` when an overlapping `deprecated_shape_migrated` exists on the same `byteRange`
- `src/fix.js` — extend `severityRank` to give `deprecated_shape_migrated` a rank of 1.5 (between `canonical_drift` and `invalid_block_content`).

### Fixtures

- `tests/fixtures/deprecation/paragraph-align-to-typography.html` — uses `{"align":"center"}` on `core/paragraph` (the existing canonical-drift fixture covers the *parse-then-serialize* delta; this fixture should isolate the deprecation by avoiding extra whitespace so canonical_drift does not also fire from spacing alone).
- `tests/fixtures/deprecation/list-pre-v6.html` — `core/list` v1 shape (no inner `core/list-item` blocks; bare `<ul>` content). Triggers the v1→v2 deprecation.
- (defer) Any block whose deprecation chain is hand-written in core. Two fixtures are sufficient for v1; add more once we see real-world misses from the agent.

### Test runner registration

Extend `EXPECTATIONS` in `tests/run.js`:

```js
'deprecation': {
  require: (r) => r.issues.some((i) => i.rule === 'deprecated_shape_migrated'),
  reason: 'expected deprecated_shape_migrated rule to fire',
  fix: (r) => r.fixes.converged && r.summary.warning === 0 && r.summary.fatal === 0,
  fixReason: '--fix should converge a deprecation fixture',
},
```

### Open questions

- Some deprecations are non-deterministic across `@wordpress/block-library` versions. Pin a known-good version in `package.json` before we land deprecation fixtures, and re-check on each Gutenberg bump. If a fixture starts failing because the deprecation list shifted, treat it as a Gutenberg-bump signal and update the fixture; do not mask with `--ignore`.

---

## Task #12 — Nesting + required-attr checks

Split into two distinct rules so agents can `--ignore=nesting` without losing required-attr coverage.

### #12a — `nesting_disallowed`

#### Goal

Catch blocks placed inside a parent that the block's `parent` / `ancestor` constraints disallow, or where the parent's `allowedBlocks` excludes them. Today the editor accepts these on parse but renders them broken or strips them on save.

#### Detection algorithm

Inside `visit()`, thread an `ancestors` array down the recursion (`[{ token, blockType }, ...]`, root-to-parent order):

1. If `blockType.parent` is a non-empty array, the immediate parent's `name` must appear in it. Emit warning otherwise.
2. If `blockType.ancestor` is a non-empty array, at least one ancestor name must appear in it.
3. If the immediate parent's `blockType.allowedBlocks` is a non-empty array, the current block's name must appear in it.

All three sub-cases share rule id `nesting_disallowed` with a `subkind` field (`parent`, `ancestor`, `allowed_blocks`) inside `message`.

```js
{
  severity: 'warning',
  path, blockName, byteRange,
  rule: 'nesting_disallowed',
  message: `core/list-item must have a core/list parent (got core/group).`,
  autoFixable: false,
  // no suggestedRepair — fixing nesting is not a splice operation
}
```

`autoFixable: false` is deliberate — moving a block between containers is structural, not textual. Agents handle these in feedback; `--fix` leaves them alone.

#### File hooks

- New file: `src/checks/nesting.js`. Exports `checkNesting({ token, blockType, parsedBlock, source, ancestors })`.
- `src/index.js`:
  - Change `visit` signature to `visit(token, ancestors = [])`.
  - Pass `[...ancestors, { token, blockType }]` to recursive children.
  - Add the call to `checkNesting` after `checkAttrSchema`.
- Extend the context object passed to all checks to include `ancestors` so future checks can use it.

#### Fixtures

- `tests/fixtures/nesting/list-item-without-list.html` — `core/list-item` directly under `core/group`.
- `tests/fixtures/nesting/buttons-disallowed-child.html` — non-`core/button` block inside `core/buttons` (`allowedBlocks` violation).
- (defer) `core/navigation-link` outside `core/navigation` — covers `ancestor`. Add once we confirm the block.json shape in our pinned `block-library`.

#### Test runner registration

```js
'nesting': {
  require: (r) => r.issues.some((i) => i.rule === 'nesting_disallowed'),
  reason: 'expected nesting_disallowed rule to fire',
  // No fix predicate — these are not autoFixable.
},
```

### #12b — `required_attr_missing`

#### Goal

Catch high-value cases where an agent emits a block with no source URL, label, or text content. The block parses and validates structurally but renders empty in the editor and on the front end.

#### Detection algorithm

A curated table in `src/checks/required-attrs.js`:

```js
const REQUIRED = {
  'core/image':           ['url'],
  'core/cover':           ['url'],
  'core/button':          ['url', 'text'],
  'core/navigation-link': ['url', 'label'],
  'core/embed':           ['url'],
  'core/file':            ['href'],
  'core/video':           ['src'],
  'core/audio':           ['src'],
  'core/social-link':     ['url'],
  'core/site-logo':       [/* implicit; rely on isResolvingSettings — skip for v1 */],
};
```

For each block in the table:

1. Resolve the effective attributes: `parsedBlock?.attributes ?? JSON.parse(token.attrsJsonRaw ?? '{}')`. Use the parsed form so we benefit from any deprecation migration that supplied a default.
2. For each required key, emit a warning when the value is `undefined`, `null`, `''`, or — for arrays — `[]`.

```js
{
  severity: 'warning',
  path, blockName, byteRange: token.openCommentRange,
  rule: 'required_attr_missing',
  message: `core/image is missing required attribute 'url'.`,
  expected: 'url',
  actual: '',
  autoFixable: false,
}
```

`autoFixable: false` — there is no way to invent a URL. Agents must supply one.

#### File hooks

- New file: `src/checks/required-attrs.js`.
- `src/index.js` — add the call after `checkNesting`. No signature changes.

#### Fixtures

- `tests/fixtures/required-attr/image-no-url.html`
- `tests/fixtures/required-attr/button-no-url.html`
- `tests/fixtures/required-attr/embed-no-url.html`

#### Test runner registration

```js
'required-attr': {
  require: (r) => r.issues.some((i) => i.rule === 'required_attr_missing'),
  reason: 'expected required_attr_missing rule to fire',
},
```

### Open questions

- The required-attrs table is curated, not generated. Keep it small (the ten blocks above) and grow only when the agent harness reports a real miss. A schema-derived approach (mark all attrs without a `default` as required) over-fires badly because most block-json defaults are runtime-resolved.
- Some blocks accept `null` for optional URL while in placeholder mode. The current rule treats empty-string and null as missing; that matches what the editor shows. Revisit if false positives appear.

---

## Task #9 — Expand fixture corpus

Done as a sweep alongside #10 and #12. List below is the floor, not the ceiling — every time the harness catches a real-world page that surprised the agent, drop a copy into the relevant directory.

### New categories (created by #10/#12)

- `deprecation/` — at least two fixtures (see #10)
- `nesting/` — at least two fixtures (see #12a)
- `required-attr/` — at least three fixtures (see #12b)

### Existing categories — gaps to fill

- `tokenizer/` (new) — fatal-class fixtures the tokenizer itself reports:
  - `unterminated-block.html` — opening `wp:group` with no closer
  - `unmatched-close.html` — bare `<!-- /wp:group -->` at top level
  - `malformed-attrs.html` — `<!-- wp:heading {bad json} -->` (covers `attr_schema_invalid_json`)
  - `crlf-source.html` — same content as `ok/heading-valid.html` but with CRLF line endings; asserts byte ranges and front-matter split survive
- `ok/` — add:
  - `frontmatter-only.html` (no body) — must report 0 blocks, 0 issues
  - `body-only.html` (no front matter) — must work via `--stdin` flow and as a file
  - `nested-deeply-valid.html` — group → columns → column → paragraph; smoke-tests the recursion path
- `canonical-drift/` — add:
  - `paragraph-attribute-order.html` — `{"placeholder":"…","align":"center"}`; canonical orders keys differently
  - `cover-default-overlay.html` — cover with `dimRatio` defaulted; canonical adds the `has-background-dim` class set
- `invalid-block-content/` — add:
  - `list-flat-li.html` — `<ul><li>` content under `core/list` v2 (which expects `core/list-item` children)
  - `image-missing-href-class.html` — image with `linkDestination: media` but no `href` on the `<a>`

### Test runner registration for `tokenizer/`

```js
'tokenizer': {
  require: (r) => r.summary.fatal > 0 && r.issues.some((i) => i.rule.startsWith('tokenizer_') || i.rule === 'attr_schema_invalid_json'),
  reason: 'expected a tokenizer_* fatal or attr_schema_invalid_json',
},
```

---

## Cross-cutting follow-ups (file as separate tasks if they grow)

These surfaced while planning the above. None block #9/#10/#12, but they are cheap to fold in and keep the agent contract clean.

### Unknown / unregistered block names

Currently a token whose `getBlockType(token.name)` returns `undefined` is silently skipped by every check. The agent gets no signal that, say, `core/typo-in-name` will land as a "freeform" block in the editor.

- Add a tiny check in `src/index.js`'s visit (no separate file): when `blockType` is `undefined`, push `{ rule: 'unknown_block_type', severity: 'warning', autoFixable: false, message: \`No registered block type for ${token.name}; will render as freeform.\` }`.
- Allow `--ignore=unknown_block_type` for users who deliberately rely on third-party blocks that are not registered in this CLI's bundle.

### `gutenbergVersion()` reliability

`src/index.js:111-118` uses `require('@wordpress/block-library/package.json')`. This works only because the esbuild banner installs `createRequire`. If we ever drop that banner (or someone runs the unbundled API from `src/`), the version field becomes `'unknown'` silently.

- Replace with an `import.meta.resolve` / `node:fs.readFileSync` pair, or pre-compute the version at build time and inject as a `define` constant. Trivial fix; do it before the next release.

### Output-mode parity for new rules

Every new rule must include `expected` and `actual` strings (or omit both) so `--diff` and `--summary` keep working. The tests in `tests/run.js` already exercise output-mode shapes against the canonical-drift fixture; once #10 lands, add an analogous mode-test against a deprecation fixture so we catch regressions where a new check forgets to populate the comparison fields.

---

## Suggested landing order

1. **#10** first — the deprecation rule reuses the most existing infrastructure (visit loop, fix engine, output-mode plumbing) and exposes the cleanest agent feedback. Adds two fixtures.
2. **#12b** (`required_attr_missing`) — orthogonal to everything else, no signature changes, three fixtures.
3. **#12a** (`nesting_disallowed`) — requires threading `ancestors` through visit(), so it is the larger structural change. Two fixtures.
4. **#9** sweep — fill in the tokenizer/, ok/, and remaining drift fixtures. Pure test surface; no source changes beyond runner registration.
5. **Cross-cutting follow-ups** — fold in opportunistically once 1–4 are green.

After landing, bump version to `0.2.0-alpha.1` (new rules count as a breaking surface change for any harness that pattern-matched the rule list).
