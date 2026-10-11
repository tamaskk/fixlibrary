#!/usr/bin/env bash
# .claude/hooks/format-file.sh
# PostToolUse hook (matcher: "Edit|Write|MultiEdit"). Formats the file Claude
# just wrote with the project's own formatter (Biome if configured, otherwise
# Prettier from node_modules). Never blocks: formatting problems surface later
# through lint/typecheck. Skips generated, vendored and lock files.
set -u
command -v node >/dev/null 2>&1 || exit 0

IFS= read -r -d '' PARSE_JS <<'JS' || true
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const t = JSON.parse(raw).tool_input || {};
    process.stdout.write(String(t.file_path || t.path || ""));
  } catch {}
});
JS

file="$(node -e "$PARSE_JS")"
[ -n "$file" ] && [ -f "$file" ] || exit 0

case "$file" in
  */node_modules/*|*/.next/*|*/dist/*|*/build/*|*/coverage/*|*/.git/*|*.min.*) exit 0 ;;
  *package-lock.json|*pnpm-lock.yaml|*yarn.lock|*bun.lock*) exit 0 ;;
  *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.css|*.scss|*.md|*.mdx|*.html|*.yml|*.yaml) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
bin="$root/node_modules/.bin"
if [ -x "$bin/biome" ] && { [ -f "$root/biome.json" ] || [ -f "$root/biome.jsonc" ]; }; then
  "$bin/biome" format --write "$file" >/dev/null 2>&1 || true
elif [ -x "$bin/prettier" ]; then
  "$bin/prettier" --write --log-level warn "$file" >/dev/null 2>&1 || true
fi
exit 0
