# Antigravity Claude Permissions Hook

A zero-dependency, cross-platform `PreToolUse` hook for **Antigravity CLI** that enforces permission rules from **Claude Code** (`~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`).

---

## How It Works

1. **Intercepts `PreToolUse`:** Reads Antigravity's JSON payload (`{ toolCall: { name, args }, workspacePaths }`) on `stdin`.
2. **Merges Settings:** Loads global (`~/.claude/settings*.json`) and workspace (`.claude/settings*.json`) configurations.
3. **Audits Execution:** Detects dynamic substitutions (`$()`, backticks, `$((...))`), heredocs (`<<`), process substitutions, brace expansions, dangerous `git -c` flags, and inline interpreters across every subcommand in a pipeline.
4. **Enforces Precedence (`Deny > Ask > Allow`):** Maps verdicts to Antigravity's `"deny"`, `"force_ask"`, and `"auto_approve"` decisions, failing closed (`"deny"`) on errors or empty commands.
5. **Audit Trail:** Logs every decision to `.agents/hooks/claude-permissions.log`.

---

## Configuration (`.claude/settings.json`)

```json
{
  "$schema": "[https://json.schemastore.org/claude-code-settings.json](https://json.schemastore.org/claude-code-settings.json)",
  "agy-cli-permission-hook-default-access": "ask",
  "agy-cli-permission-hook-arbitrary-command-execution": "deny",
  "permissions": {
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(git checkout main && git push)",
      "Read(./secrets/**)",
      "Read(.env)",
      "Edit(.claude/settings.json)",
      "WebFetch(malicious.org:*)"
    ],
    "ask": ["Bash(npm publish:*)", "Bash(git reset --hard:*)"],
    "allow": [
      "Bash(git status)",
      "Bash(npm test:*)",
      "Read",
      "Edit",
      "WebSearch",
      "WebFetch(github.com:*)"
    ]
  }
}
```

### Root Properties & Syntax

- **`agy-cli-permission-hook-default-access`** (`"allow" | "ask" | "deny"`, default `"ask"`): Fallback decision when no rule matches.
- **`agy-cli-permission-hook-arbitrary-command-execution`** (`"allow" | "ask" | "deny"`, default `"ask"`): Overrides all rules when arbitrary command execution is detected.
- **`Bash(cmd)` / `Bash(cmd:*)` / `Bash(cmd*)`:** Exact command, word-boundary delimited arguments, or raw wildcard glob.
- **`//path` vs. `/path` vs. `no-slash`:** `//path` is filesystem-absolute; `/path` and `./path` are workspace-relative; patterns without slashes (e.g., `Read(.env)`) match at any depth.

---

## Installation & Target Setup

```bash
# Install or update in a relative target repository
npm run setup -- ../other-project

# Install or update in an absolute target path
npm run setup -- /path/to/target-repo
```

---

## Downstream Project Documentation

The block below (delimited by `<!-- CLAUDE-PERMISSIONS-HOOK:START -->` and `<!-- CLAUDE-PERMISSIONS-HOOK:END -->`) is automatically extracted by `scripts/setup.ts` and inserted or updated in the target repository's `README.md`.

<!-- CLAUDE-PERMISSIONS-HOOK:START -->

### Antigravity Claude Permissions Hook

This repository enforces tool permissions from `.claude/settings.json` (and `.claude/settings.local.json`) via an Antigravity CLI `PreToolUse` hook.

- **Hook Script:** `.agents/hooks/claude-permissions.ts`
- **Hook Config:** `.agents/hooks.json`
- **Audit Log:** `.agents/hooks/claude-permissions.log` (gitignored)

#### Behavior

- **Precedence:** Enforces **Deny > Ask > Allow** mapped to Antigravity's `deny`, `force_ask`, and `auto_approve` decisions.
- **Compound Commands:** Splits chained pipelines (`&&`, `||`, `;`, `|`, `&`, newlines) and enforces the strictest verdict across all subcommands.
- **Arbitrary Execution Guard:** Detects command substitutions (`$()`, backticks), arithmetic (`$((...))`), heredocs (`<<`), brace expansions (`{a,b}`), `git -c` flags, and inline interpreters across every subcommand.
- **Self-Protection:** Edits or shell output redirections targeting `.claude/settings*.json` or `.agents/hooks/**` always require explicit approval (`force_ask`) or are denied.

#### Updating the Hook

To update the hook from the upstream permissions repository, run:

```bash
npm --prefix /path/to/antigravity-claude-permissions-hook run setup -- .
```

<!-- CLAUDE-PERMISSIONS-HOOK:END -->
