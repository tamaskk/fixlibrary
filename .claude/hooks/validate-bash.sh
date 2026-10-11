#!/usr/bin/env bash
# .claude/hooks/validate-bash.sh
# PreToolUse hook (matcher: "Bash"). Reads the hook event JSON on stdin and
# prints a PreToolUse decision on stdout:
#   deny -> catastrophic or policy-violating command (Claude sees the reason)
#   ask  -> risky but sometimes legitimate; a human must confirm
#   (no output) -> no opinion; the normal permission rules apply
# Needs bash + node (node only parses JSON and runs the rules; no jq).
# Fails closed: if node is missing, every Bash call is blocked with a message.
set -u

if ! command -v node >/dev/null 2>&1; then
  echo "validate-bash.sh: node not found on PATH, blocking Bash for safety. Install Node.js or fix PATH." >&2
  exit 2
fi

IFS= read -r -d '' RULES_JS <<'JS' || true
const { execSync } = require("child_process");

const SAFE_RM_TARGET = /^(\.\/)?(node_modules|\.next|dist|build|out|coverage|\.turbo|\.vercel|\.cache|tmp|\.tmp|playwright-report|test-results|storybook-static)\/?$/;
const DANGER_RM_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\.|\.\/|\.\/\*|\.\.|\.\.\/|\*|\.\*|(\.\/)?\.git\/?)$/;
const OUTSIDE_TARGET = /^(\/|~|\$HOME|\$\{HOME\}|\.\.)/;
const FILE_CMDS = new Set(["cat","less","more","head","tail","bat","nl","tac","strings","xxd","od","hexdump",
  "grep","egrep","fgrep","rg","ag","awk","sed","cut","sort","uniq","base64","cp","mv","scp","rsync","tee",
  "source",".","open","code","vim","vi","nano","emacs","diff","cmp","jq","type"]);
const KEY_FILES = /(\.ssh\/|\bid_(rsa|ecdsa|ed25519)\b|\.aws\/credentials|\.npmrc\b|\.netrc\b|\.pem\b|\.p12\b|\.pfx\b|\.keystore\b)/;
const WRAPPERS = new Set(["time","command","exec","nohup","xargs","nice","then","do","else","!"]);

function secretEnvRefs(s) {
  const re = /(^|[\s"'=:<>(\/])\.env(\.[\w.-]+)?(?=$|[\s"';&|)<>])/g;
  const refs = [];
  for (const m of s.matchAll(re)) {
    const suffix = m[2] || "";
    if (/^\.(example|sample|template|dist)$/i.test(suffix)) continue;
    refs.push(".env" + suffix);
  }
  return refs;
}

// Targets of > >> < redirections (heredoc << and fd dups like 2>&1 are ignored).
function redirectTargets(seg) {
  const out = [];
  for (const m of seg.matchAll(/(^|[^<>&])(>>?|<)(?!<)\s*["']?([^\s"';&|<>)]+)/g)) out.push(m[3]);
  return out;
}

function firstWord(seg) {
  const toks = seg.trim().replace(/^[({]\s*/, "").split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && (WRAPPERS.has(toks[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))) i++;
  return { word: (toks[i] || "").replace(/^.*\//, ""), rest: toks.slice(i + 1) };
}

function currentBranch(cwd) {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
  } catch { return ""; }
}

function checkRm(seg) {
  const m = seg.match(/(?:^|\s)rm\s+(.*)$/);
  if (!m) return null;
  let recursive = false, endOfOpts = false;
  const targets = [];
  for (const t of m[1].split(/\s+/).filter(Boolean)) {
    if (!endOfOpts && t === "--") { endOfOpts = true; continue; }
    if (!endOfOpts && t === "--recursive") { recursive = true; continue; }
    if (!endOfOpts && /^-[a-zA-Z]+$/.test(t)) { if (/[rR]/.test(t)) recursive = true; continue; }
    if (!endOfOpts && t.startsWith("--")) continue;
    targets.push(t.replace(/^["']|["']$/g, ""));
  }
  if (!recursive || targets.length === 0) return null;
  const list = targets.join(" ");
  if (targets.some((t) => DANGER_RM_TARGET.test(t))) return { decision: "deny", reason: `recursive delete of a dangerous path (${list})` };
  if (targets.some((t) => OUTSIDE_TARGET.test(t))) return { decision: "ask", reason: `recursive delete outside the project (${list})` };
  if (targets.every((t) => SAFE_RM_TARGET.test(t))) return null;
  return { decision: "ask", reason: `recursive delete of project files (${list})` };
}

function checkGitPush(seg, cwd) {
  const m = seg.match(/(?:^|\s)git\s+(?:-C\s+\S+\s+)?push\b(.*)$/);
  if (!m) return null;
  const toks = m[1].trim().split(/\s+/).filter(Boolean);
  const flags = toks.filter((t) => t.startsWith("-"));
  const args = toks.filter((t) => !t.startsWith("-"));
  if (flags.some((f) => /^--force(-with-lease|-if-includes)?(=.*)?$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)))
    return { decision: "deny", reason: "force push" };
  const refspecs = args.slice(1);
  if (refspecs.some((r) => r.startsWith("+"))) return { decision: "deny", reason: "force push (+refspec)" };
  if (refspecs.some((r) => /^(\S+:)?(refs\/heads\/)?(main|master)$/.test(r)))
    return { decision: "deny", reason: "direct push to main/master; open a pull request instead" };
  if (refspecs.length === 0) {
    const branch = currentBranch(cwd);
    if (branch === "main" || branch === "master")
      return { decision: "deny", reason: `push while on ${branch}; create a feature branch and open a pull request` };
  }
  if (flags.includes("--no-verify")) return { decision: "ask", reason: "push that skips git hooks (--no-verify)" };
  return null;
}

function check(cmd, cwd) {
  const c = cmd.replace(/\s+/g, " ").trim();
  const found = [];
  const deny = (reason) => found.push({ decision: "deny", reason });
  const ask = (reason) => found.push({ decision: "ask", reason });

  // Whole-command rules
  if (/(^|[\s;&|(`])sudo\s/.test(c)) deny("sudo is not allowed for the agent");
  if (/\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b/.test(c) || /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/.test(c))
    deny("piping a downloaded script into a shell");
  if (/\b(npm|pnpm|yarn|bun)\s+publish\b/.test(c)) deny("publishing a package");
  if (/\bchmod\s+(-R\s+)?0?777\b/.test(c)) deny("chmod 777");
  if (/\bmkfs(\.\w+)?\b/.test(c) || /\bdd\s+if=/.test(c)) deny("disk-level command");
  if (/\bgit\s+reset\b[^;&|]*--hard\b/.test(c)) ask("git reset --hard discards work");
  if (/\bgit\s+clean\b[^;&|]*\s-[a-zA-Z]*f/.test(c)) ask("git clean -f deletes untracked files");
  if (/\bgit\s+checkout\s+(--\s+)?\.(\s|$)/.test(c) || /\bgit\s+checkout\s+--\s/.test(c)) ask("git checkout discards local changes");
  if (/\bgit\s+branch\s+(-[a-zA-Z]*D\b|--delete\s+--force\b)/.test(c)) ask("force-deleting a branch");
  if (/\bgit\s+stash\s+(drop|clear)\b/.test(c)) ask("dropping stashed work");
  if (/\bgit\s+commit\b[^;&|]*\s--no-verify\b/.test(c)) ask("commit that skips git hooks (--no-verify)");
  if (/\bvercel\b[^;&|]*(\s--prod\b|\s(promote|rollback|remove|rm)\b|\senv\s+(add|rm|pull)\b)/.test(c))
    ask("production deploy or Vercel project/env change");
  if (/\b(dropDatabase|dropCollection)\b/.test(c) || /\b(drop\s+database|drop\s+table|truncate\s+table)\b/i.test(c) ||
      /\bprisma\s+migrate\s+reset\b/.test(c) || /\bprisma\s+db\s+push\b[^;&|]*--force-reset\b/.test(c) ||
      /\bdrizzle-kit\s+drop\b/.test(c) || /deleteMany\(\s*\{\s*\}\s*\)/.test(c))
    ask("destructive database operation");
  if (/\bfind\b[^;&|]*(\s-delete\b|\s-exec\s+rm\b)/.test(c)) ask("find with -delete / -exec rm");

  // Per-segment rules
  for (const seg of c.split(/\|\||&&|;|\||\n/).map((s) => s.trim()).filter(Boolean)) {
    const { word, rest } = firstWord(seg);
    const rm = checkRm(seg); if (rm) found.push(rm);
    const push = checkGitPush(seg, cwd); if (push) found.push(push);
    const envRefs = secretEnvRefs(seg);
    if (FILE_CMDS.has(word) && (envRefs.length || KEY_FILES.test(seg)))
      deny(`reading or copying a secrets file (${envRefs.join(", ") || "key/credential file"}); use .env.example or ask the user`);
    if (redirectTargets(seg).some((t) => secretEnvRefs(t).length))
      deny("redirecting into or out of a secrets file (.env*)");
    if (/(?:^|\s)git\s+add\b/.test(seg) && envRefs.length) deny("staging a secrets file (.env*)");
    if (word === "printenv" || (word === "env" && !rest.some((t) => !t.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))))
      ask("printing environment variables (may include secrets)");
  }

  const denied = found.filter((f) => f.decision === "deny");
  if (denied.length) return { decision: "deny", reason: [...new Set(denied.map((f) => f.reason))].join("; ") };
  if (found.length) return { decision: "ask", reason: [...new Set(found.map((f) => f.reason))].join("; ") };
  return null;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const cmd = String((input.tool_input && input.tool_input.command) || "");
  if (!cmd.trim()) process.exit(0);
  const verdict = check(cmd, input.cwd || process.cwd());
  if (verdict) {
    const reason = verdict.decision === "deny"
      ? `Blocked by project policy (.claude/hooks/validate-bash.sh): ${verdict.reason}. Do not retry with a workaround; tell the user what you wanted to run and why.`
      : `Project policy (.claude/hooks/validate-bash.sh): ${verdict.reason}. Confirm only if you expected this.`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: reason },
    }));
  }
  process.exit(0);
});
JS

exec node -e "$RULES_JS"
