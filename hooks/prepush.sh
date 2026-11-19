#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash): stop a `pac push` that would overwrite edits made in wp-admin
# since the last push, or a page pac never pushed. Prefix the command with PAC_FORCE=1 to push anyway.
# Site from `gp wp <site>` (else the session's /var/www/<site>/ cwd); runs drift.php as the site's
# sys user on the site's own PHP, fed on stdin (GridPane denies sys users /opt). Installed at
# /opt/pac-preflight/hooks/prepush.sh.
set -uo pipefail
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
case "$cmd" in *"pac push"*) ;; *) exit 0 ;; esac
case "$cmd" in *PAC_FORCE=1*) exit 0 ;; esac

file=$(printf '%s' "$cmd" | grep -oE 'pac push +[^ ]+' | head -1 | awk '{print $3}')
ptype=$(printf '%s' "$cmd" | grep -oE -- '--post-type=[a-z0-9_-]+' | head -1 | cut -d= -f2)
site=$(printf '%s' "$cmd" | grep -oE 'gp wp +[^ ]+' | head -1 | awk '{print $3}')
if [ -z "$site" ]; then
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty'); site=${cwd#/var/www/}; site=${site%%/*}
fi
env=/var/www/$site/logs/$site.env
[ -n "$file" ] && [ -n "$site" ] && [ -f "$env" ] || exit 0

user=$(grep -m1 '^sys-user:' "$env" | cut -d: -f2 | tr -d '[:space:]')
php=$(ls /etc/php/*/fpm/pool.d/"$site".conf 2>/dev/null | head -1 | cut -d/ -f4)
out=$(sudo -u "$user" "/usr/bin/php$php" /usr/local/bin/wp --path="/var/www/$site/htdocs" \
  eval-file - "$file" "$ptype" 2>/dev/null <"$(dirname "$0")/drift.php" | tail -1)
IFS=$'\t' read -r verdict id slug rev last <<<"$out"

case "$verdict" in
  new|clean|error) exit 0 ;;
  drift) msg="$site post $id ($slug) was edited after its last push (last push $last, newest revision $rev UTC).
Pushing would overwrite those edits. Take them into the file first:
  gp wp $site pac pull $slug --revision-suffix   # writes WP's version beside your file
  gp wp $site pac pull $slug --force             # replaces your file with WP's version" ;;
  foreign) msg="$site post $id ($slug) has this slug but was never pushed by pac; pushing would overwrite it.
Rename the file's slug, or pull it first: gp wp $site pac pull $slug" ;;
  *) msg="drift check did not run for $file on $site (got: ${out:-nothing})." ;;
esac
printf 'pac push blocked: %s\nTo push anyway, prefix the command with PAC_FORCE=1.\n' "$msg" >&2
exit 2
