#!/usr/bin/env bash
# Claude Code PostToolUse hook (Write|Edit|MultiEdit): pac-preflight --fix on a PAC page file.
# A PAC page is a .html file whose first line is "---". Clean → silent exit 0. Issues left
# after --fix → listed on stderr, exit 2, so the agent fixes them and saves again.
# Installed at /opt/pac-preflight/hooks/postwrite.sh. Node by absolute path: hooks may run
# with a PATH where `env node` finds /usr/bin/node (v12), which can't load the bundle.
set -uo pipefail
NODE=${PAC_NODE:-/usr/local/bin/node}
CLI=${PAC_PREFLIGHT:-/opt/pac-preflight/bin/pac-preflight.mjs}

file=$(jq -r '.tool_input.file_path // empty')
case "$file" in *.html) ;; *) exit 0 ;; esac
[ -f "$file" ] && [ "$(head -n 1 "$file")" = "---" ] || exit 0

report=$("$NODE" "$CLI" "$file" --fix 2>/dev/null)
if [ -z "$report" ] || ! printf '%s' "$report" | jq -e '.summary.blocks | numbers' >/dev/null 2>&1; then
  echo "pac-preflight did not run on $file (no report); check $NODE and $CLI." >&2
  exit 2
fi
printf '%s' "$report" | jq -e '.summary.warning + .summary.fatal == 0' >/dev/null && exit 0

{
  echo "pac-preflight: issues remain in $file after --fix. Edit to match, save, it re-runs:"
  printf '%s' "$report" | jq -r '.issues[] | select(.severity != "info")
    | "  - [\(.severity)] \(.blockName) at \(.path): \(.message)"'
} >&2
exit 2
