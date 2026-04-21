# Agent Harness Guide

How to wire `pac-preflight` into an agentic write/validate/fix loop for Pages-as-Code pages.

## Why

Agents authoring `.html` PAC pages cannot introspect Gutenberg's `save()` functions, so they emit block markup that *looks* right but triggers the editor's "Block contains unexpected or invalid content" banner on open. `pac-preflight` uses Gutenberg itself as the oracle: it runs `validateBlock()` on each block in the page and reports mismatches before `wp pac push` is called.

The tool is designed to be the inner loop of an agentic authoring workflow:

1. Agent writes markup to `pages/foo.html`
2. Harness runs `pac-preflight pages/foo.html --fix`
3. If the file converged (`fixes.converged === true`), push it; otherwise feed the remaining issues back to the agent for a retry.

## Install

```bash
cd /path/to/pac-preflight
npm install
npm run build
# Optional: link into PATH for CLI usage
npm link
```

The binary is `dist/pac-preflight.mjs`; `npm link` installs a `pac-preflight` shim that calls it. Requires Node 20+.

## Invocation contract

All output goes to **stdout** as a single JSON report. Stderr is reserved for tool errors (unreadable file, unknown flag). Gutenberg's own `console.error`/`console.warn` output is suppressed globally in the bundle, so agents can parse stdout as strict JSON.

| Form | Use |
| --- | --- |
| `pac-preflight <file>` | Validate a file on disk. `sourcePath` in the report is the path argument. |
| `pac-preflight --stdin < markup` | Validate a body-only markup string (no front matter). `sourcePath` is `<stdin>`. |
| `pac-preflight <file> --fix` | Apply fixes in place. File on disk is rewritten on converged or partial success. |
| `pac-preflight <file> --fix --dry-run` | Same fix loop, but do not write. Final source appears in `fixes.fixedContent`. |
| `pac-preflight --stdin --fix` | Stream-in fix mode. Fixed markup appears in `fixes.fixedContent`; nothing is written. |

Rule filtering:

- `--only=invalid_block_content,canonical_drift` — only run checks whose rule id starts with one of the given prefixes.
- `--ignore=canonical_drift` — skip checks whose rule id starts with a given prefix.

Other flags:

- `--strict` — promote any non-`info` issue to fatal for exit-code purposes.
- `--max-iterations=N` — cap the fix loop (default 3). The loop also stops early if two consecutive iterations produce the same source.

## Report schema

```jsonc
{
  "ok": true,                                    // false if fatal issues remain (or --strict and any warning/info)
  "source": "pages/foo.html",                    // echoes the input path (or "<stdin>")
  "preflightVersion": "0.1.0-alpha.1",
  "gutenbergVersion": "9.44.0",
  "summary": { "blocks": 3, "fatal": 0, "warning": 1, "info": 2 },
  "issues": [
    {
      "severity": "warning",
      "path": "0.1",                             // block tree path, e.g. "0" = first root, "0.1" = its second child
      "blockName": "core/cover",
      "byteRange": [142, 603],                   // inclusive-start, exclusive-end offsets into the full file source
      "rule": "invalid_block_content",
      "message": "Block content does not match save() output; editor will flag as invalid. Reasons: Expected tag name `img`, instead saw `span`.",
      "expected": "<!-- wp:cover ... -->",       // canonical replacement the fixer would splice in
      "actual":   "<!-- wp:cover ... -->",       // the current source slice
      "autoFixable": true,
      "suggestedRepair": { "kind": "replace_byte_range", "with": "<!-- wp:cover ... -->" }
    }
  ],
  "fixes": {                                     // present only when --fix is passed
    "applied": 1,                                // total number of splice operations performed across iterations
    "iterations": 1,
    "converged": true,                           // true if the final pass had no autoFixable issues
    "wrote": "pages/foo.html",                   // present when the file was rewritten
    "fixedContent": "<!-- wp:... -->"            // present with --dry-run or --stdin
  }
}
```

### Severity meanings

- **fatal** — the tool could not parse the input (tokenizer error, malformed block delimiter). Agent must re-emit from scratch.
- **warning** — Gutenberg's own `validateBlock` rejected the block, or the JSON attribute payload violates the schema. The editor would flag this.
- **info** — canonical drift (the editor would silently rewrite on save). Not broken, but fixable.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No issues, or only `info` issues, or `--fix` converged |
| `1` | At least one fatal/warning issue remains (or, with `--strict`, any non-`info`) |
| `2` | Tool error: cannot read file, unknown flag, invalid `--max-iterations` |

Agent harnesses should treat `2` as "retry with different input" and `1` as "feedback loop input".

## The agentic loop

Minimum viable harness (pseudocode):

```
for attempt in 1..MAX_ATTEMPTS:
    agent.write_markup(path)

    result = run(["pac-preflight", path, "--fix"])
    report = json.loads(result.stdout)

    if result.exit_code == 0 and report["fixes"]["converged"]:
        break                                     # file on disk is clean; ready to push

    # Feed the remaining issues back to the agent. The fixed content is already
    # on disk, so the agent sees exactly what Gutenberg expects — including any
    # canonical attribute shape migrations — as the starting point for its next edit.
    issues = report["issues"]
    agent.give_feedback(issues)
else:
    raise "pac-preflight did not converge after MAX_ATTEMPTS"

run(["wp", "pac", "push", path])
```

Key properties this relies on:

- **Byte-range splices are stable under the fix ordering**. Repairs are sorted descending by start offset, so applying repair N does not invalidate the offsets of repair N-1.
- **Parent repairs subsume inner repairs**. When a parent block's canonical serialization is spliced in, it already contains the canonical inner markup. The fix engine drops any repair whose range is strictly inside another repair's range.
- **`invalid_block_content` wins ties against `canonical_drift`**. If two repairs cover the exact same range, the one from `validateBlock` takes precedence — fixing editor-visible breakage is more important than cosmetic normalization.
- **Non-convergence is not fatal**. Some blocks have pathological `save()`/`serialize()` round-trip behavior (e.g. `core/cover` with certain attribute combinations). When `fixes.converged === false`, the tool rewrites as much as it can and exits with the remaining issues reported. The harness can decide whether to retry, ask the human, or delete the offending block.

## Integration with the pages-as-code skill

Add an instruction to `wp-content/pages/CLAUDE.md` (the user-facing agent file) alongside the existing `wp pac push` guidance:

```markdown
Before running `wp pac push`, run the file through pac-preflight:

    pac-preflight pages/<slug>.html --fix

If the tool exits non-zero, read the `issues` array in the JSON report and revise
the file. The `expected` and `actual` fields show exactly what Gutenberg would
emit versus what you wrote — use `expected` as the ground truth. Only push after
`pac-preflight` exits 0.
```

If the harness is running outside an interactive Claude Code session (cron, CI, etc.), skip the skill-level instruction and wire the loop directly around the CLI.

## Optional: Claude Code hook wiring

Claude Code supports hooks that fire on file edits (see `~/.claude/settings.json`). To block edits to `pages/*.html` that would trip the editor banner:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "if [[ \"$CLAUDE_TOOL_FILE\" == */pages/*.html ]]; then pac-preflight \"$CLAUDE_TOOL_FILE\" --fix >/dev/null || echo 'pac-preflight flagged issues; see report'; fi"
          }
        ]
      }
    ]
  }
}
```

This runs `--fix` silently after every Write/Edit to a pages file. The file is rewritten in place when repairs succeed; the agent sees the canonical form on its next read. Remove or adjust the matcher if you maintain other `.html` files outside `pages/`.

For a non-silent variant that surfaces the JSON report to the agent, drop the `>/dev/null` and let the hook's stdout flow back into the transcript.

## Programmatic use

The package also exposes a pure function:

```js
import { preflight } from 'pac-preflight';

const report = preflight(source, {
  sourcePath: 'pages/foo.html',
  only: ['invalid_block_content'],
  ignore: null,
  strict: false,
});
```

`applyFixes` is available from `pac-preflight/fix.js` if you want to run the fix loop with a custom preflight wrapper (e.g. one that injects additional checks).

## Known limitations

- Phase 1 checks only: `invalid_block_content`, `canonical_drift`, `attr_schema_{type,enum,invalid_json}`. Deprecation-shape detection and nesting/required-attr checks are Phase 2 work.
- Requires `registerCoreBlocks()` from `@wordpress/block-library` — third-party block types are not currently registered. Pages that use non-core blocks will treat those as unknown (no validation) rather than reporting them.
- The fix loop is capped at 3 iterations by default. If a block genuinely does not round-trip through `save() → parse() → save()`, the tool reports `converged: false` and leaves the work for the agent.
