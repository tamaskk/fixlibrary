#!/usr/bin/env bash
# .claude/hooks/session-context.sh
# SessionStart hook. Prints a short, cheap snapshot; Claude Code adds a
# SessionStart hook's plain stdout to Claude's context. Keep it under ~15 lines.
set -u
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" 2>/dev/null || exit 0

echo "## Session context (.claude/hooks/session-context.sh)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch="$(git branch --show-current 2>/dev/null)"
  dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d '[:space:]')"
  echo "- Branch: ${branch:-detached HEAD} | uncommitted files: ${dirty}"
  echo "- Recent commits:"
  git log --oneline -5 2>/dev/null | sed 's/^/  - /'
  case "$branch" in
    main|master) echo "- You are on ${branch}: create a feature branch before changing code." ;;
  esac
else
  echo "- Not a git repository yet."
fi

if [ -f docs/TASKS.md ]; then
  open_tasks="$(grep -E '^[[:space:]]*- \[ \]' docs/TASKS.md | head -5)"
  if [ -n "$open_tasks" ]; then
    echo "- Next open tasks (docs/TASKS.md):"
    printf '%s\n' "$open_tasks" | sed 's/^[[:space:]]*/  /'
  fi
fi
exit 0
