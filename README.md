# Antigravity Claude Permissions Hook

A zero-dependency, cross-platform `PreToolUse` hook for **Antigravity CLI** that translates and enforces permission configurations from **Claude Code** (`.claude/settings.json` and `.claude/settings.local.json`).

---

## Table of Contents
- [Overview](#overview)
- [How It Works](#how-it-works)
- [Configuration Reference](#configuration-reference)
  - [Custom Root Options](#custom-root-options)
  - [Rule Precedence](#rule-precedence)
  - [Command Matching Syntax](#command-matching-syntax)
- [Security Model & Anti-Evasion](#security-model--anti-evasion)
  - [Arbitrary Command Execution Detection](#arbitrary-command-execution-detection)
  - [Compound & Pipeline Splitting](#compound--pipeline-splitting)
  - [Cross-Platform Path Normalization](#cross-platform-path-normalization)
- [Installation & Target Setup](#installation--target-setup)
- [Downstream Project Documentation](#downstream-project-documentation)

---

## Overview

Antigravity CLI allows users to intercept and evaluate agent tool invocations through a `PreToolUse` hook. This repository provides a standalone hook engine that reads your project's Claude Code settings and returns standard Antigravity authorization verdicts:
- `allow`: Execute immediately without prompting.
- `ask`: Pause and request interactive user confirmation.
- `deny`: Block the tool call and return a detailed diagnostic reason.

---

## How It Works

1. **Input Interception:** Antigravity dispatches a tool call payload over `stdin` formatted as `{ tool, parameters, context }`.
2. **Settings Resolution:** The hook loads `.claude/settings.json` from the active working directory and merges any local overrides from `.claude/settings.local.json`.
3. **Execution Auditing:** Shell commands are inspected for dangerous dynamic expansions (`$()`, \`\` \` \`\`, `$((...))`, process substitutions, and unsafe tool flags).
4. **Command Splitting:** Compound pipelines (`&&`, `||`, `;`, `|`, `&`, newlines) are parsed into individual tokens while respecting quotes.
5. **Precedence Resolution:** Traditional **Deny > Ask > Allow** precedence is applied across both the composite command and all individual sub-commands.
6. **Decision & Audit Trail:** The hook writes `{ "decision": "...", "reason": "..." }` to `stdout` and appends a timestamped log to `.agents/hooks/claude-permissions.log`.

---

## Configuration Reference

Settings are declared inside `.claude/settings.json`:

```json
{
  "$schema": "[https://json.schemastore.org/claude-code-settings.json](https://json.schemastore.org/claude-code-settings.json)",
  "agy-cli-permission-hook-default-access": "ask",
  "agy-cli-permission-hook-arbitrary-command-execution": "deny",
  "permissions": {
    "deny": [
      "Bash(rm -rf /)",
      "Bash(rm -rf:*)",
      "Bash(git checkout main && git push)",
      "Read(./secrets/**)",
      "Edit(.claude/settings.json)",
      "WebFetch(malicious.org:*)"
    ],
    "ask": [
      "Bash(npm publish:*)",
      "Bash(git reset --hard:*)"
    ],
    "allow": [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "WebSearch",
      "WebFetch(github.com:*)"
    ]
  }
}
```

### Custom Root Options

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `agy-cli-permission-hook-default-access` | `"allow" \| "ask" \| "deny"` | `"ask"` | Fallback permission applied when a tool or argument matches no explicit rules. |
| `agy-cli-permission-hook-arbitrary-command-execution` | `"allow" \| "ask" \| "deny"` | `"ask"` | Overrides all rules if dynamic command substitutions, arithmetic evaluations, or process substitutions are detected. |

### Rule Precedence

Rules are evaluated in strict priority: **Deny > Ask > Allow**.
- If any matching rule evaluates to `deny`, the tool call is blocked.
- If no rules evaluate to `deny` but at least one evaluates to `ask`, user confirmation is required.
- If all matching rules evaluate to `allow`, the call runs automatically.
- If nothing matches, the fallback set by `agy-cli-permission-hook-default-access` is applied.

### Command Matching Syntax

| Syntax Pattern | Example | Matches | Does NOT Match | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Exact**<br>`Bash(cmd)` | `Bash(git status)` | `git status` | `git status -s`<br>`git status --short` | Strict string match; disallows any additional arguments or flags. |
| **Delimited Prefix**<br>`Bash(cmd:*)` | `Bash(npm test:*)` | `npm test`<br>`npm test --watch`<br>`npm test unit/` | `npm testrun`<br>`npm testing` | Enforces a word boundary. Matches 0 or more trailing arguments. |
| **Glob**<br>`Bash(cmd*)` | `Bash(git push origin master*)` | `git push origin master`<br>`git push origin master:main` | `git push origin feature` | Wildcard match across arbitrary characters without requiring a word boundary. |

---

## Security Model & Anti-Evasion

### Arbitrary Command Execution Detection
The hook guards against shell mechanics that attempt to evade static rule matching:
- **Command Substitutions:** `$(cmd)` and `` `cmd` `` (ignored inside literal single quotes `'...'`).
- **Arithmetic Contexts:** `$((...))` and legacy `$[...]`.
- **Process Substitutions:** `<(...)` and `>(...)`.
- **Brace Expansions:** `{a,b,...}` and numeric sequences `{1..10}`.
- **Socket / Network Redirection:** `/dev/tcp/*`, `/dev/udp/*`, `>&`, `<&`.
- **Subcommand Execution Flags:** `git -c core.pager=...`, `git --exec-path=...`, `tar --to-command=...`, `find ... -exec`, and interpreter flags like `python -c` or `bash -c`.

### Compound & Pipeline Splitting
Chained commands are evaluated at two complementary levels:
1. **Composite Check:** Matches compound deny rules directly (e.g., `Bash(git checkout main && git push)`).
2. **Tokenized Subcommand Check:** Splits the command line along `&&`, `||`, `;`, `|`, `&`, and unescaped newlines while keeping quoted arguments intact. If any sub-command triggers `deny` or `ask`, that decision applies to the entire execution.

### Cross-Platform Path Normalization
File operations (`Read`, `Edit`, `Write`, `Glob`, `Grep`) convert Windows, WSL, and MSYS paths into canonical POSIX forms:
- `C:\Users\foo\file` -> `/c/Users/foo/file`
- `/mnt/c/Users/foo/file` -> `/c/Users/foo/file`
- `//c/Users/foo/file` -> `/c/Users/foo/file`
- `\\wsl.localhost\Ubuntu\home\...` -> `//wsl.localhost/Ubuntu/home/...`
- `~/.ssh/**` -> Expanded to the user's home directory.
- `secrets/**` -> Protects both files inside `secrets/` and the directory itself.

---

## Installation & Target Setup

Install or update the hook in any target project repository:

```bash
# Setup a project via relative path
npm run setup -- ../other-project

# Setup a project via absolute path
npm run setup -- /home/user/workspace/web-app

# Setup in the current working directory
npm run setup
```

The setup script:
1. Copies `claude-permissions.ts` into `<target>/.agents/hooks/`.
2. Registers the `PreToolUse` hook in `<target>/.agents/hooks.json`.
3. Appends `.agents/hooks/*.log` to `<target>/.gitignore`.
4. Scrapes the downstream documentation block below and inserts or updates it in `<target>/README.md`.

---

## Downstream Project Documentation

The section below is demarcated by comment tags (`<!-- CLAUDE-PERMISSIONS-HOOK:START -->` and `<!-- CLAUDE-PERMISSIONS-HOOK:END -->`). When running `npm run setup -- <target>`, the setup script extracts this exact section from this file and injects or updates it into the target repository's `README.md`.

<!-- CLAUDE-PERMISSIONS-HOOK:START -->
### Antigravity Claude Permissions Hook

This repository uses the **Claude Permissions Bridge Hook** for Antigravity CLI to enforce tool permissions defined in `.claude/settings.json` (and optional `.claude/settings.local.json`).

- **Hook Location:** `.agents/hooks/claude-permissions.ts`
- **Registration:** Configured under `PreToolUse` in `.agents/hooks.json`
- **Audit Logs:** Appended to `.agents/hooks/claude-permissions.log` (ignored by Git)

#### How It Works
Before Antigravity executes any tool:
1. **Rule Precedence:** Evaluates explicit permissions with strict **Deny > Ask > Allow** precedence.
2. **Compound Command Splitting:** Deconstructs shell lines chained by `&&`, `||`, `;`, `|`, and newlines to verify every command individually.
3. **Arbitrary Execution Guard:** Detects dynamic command substitutions (`$()`, `` ` ``), arithmetic evaluations (`$((...))`), brace expansions (`{a,b}`), and unsafe flags (e.g. `git -c core.pager=`, `find -exec`).
4. **Path Normalization:** Standardizes Windows (`C:\`), MSYS (`//c/`), WSL (`/mnt/c/`), and UNC paths against configured globs.

#### Updating the Hook
To pull in the latest hook improvements or security updates from the upstream permissions repository, run:
```bash
npm --prefix /path/to/permissions-hook-repo run setup -- .
```
<!-- CLAUDE-PERMISSIONS-HOOK:END -->