# Antigravity Claude Permissions Hook

A zero-dependency, cross-platform `PreToolUse` hook for **Antigravity CLI** that translates and enforces tool permissions from **Claude Code** (`~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`).

---

## Table of Contents

- [Requirements](#requirements)
- [How It Works](#how-it-works)
- [Decision Mapping & Precedence](#decision-mapping--precedence)
- [Settings Loading Order & Merging](#settings-loading-order--merging)
- [Configuration Reference](#configuration-reference)
  - [Recommended Starter Configuration](#recommended-starter-configuration)
  - [Custom Root Properties](#custom-root-properties)
  - [Bash Command Rule Syntax](#bash-command-rule-syntax)
  - [Path Pattern Syntax & Normalization](#path-pattern-syntax--normalization)
  - [Antigravity Tool Mapping](#antigravity-tool-mapping)
- [Security Model, Arbitrary Execution Guard & Limitations](#security-model-arbitrary-execution-guard--limitations)
  - [What the Arbitrary Execution Guard Catches](#what-the-arbitrary-execution-guard-catches)
  - [Important Limitations to Understand](#important-limitations-to-understand)
- [Installation & Target Setup](#installation--target-setup)
- [Troubleshooting & Audit Logs](#troubleshooting--audit-logs)
- [Downstream Project Documentation](#downstream-project-documentation)

---

## Requirements

- **Node.js `>= 22.18.0`** (or **`>= 23.6.0` / `24.x`**) so Node can execute `.ts` files natively without experimental flags.
  - *Note:* On older Node `22.6.0` - `22.17.x` releases, pass `--experimental-strip-types` in the hook command.

---

## How It Works

When Antigravity CLI prepares to execute a tool, it invokes `.agents/hooks/claude-permissions.ts` via `PreToolUse` and passes `{ toolCall: { name, args }, workspacePaths }` over `stdin`. The hook:

1. **Loads & Merges Settings:** Reads global (`~/.claude/settings*.json`) and workspace (`.claude/settings*.json`) configuration files, preserving the directory scope of each file.
2. **Validates Settings Integrity:** If any existing settings file contains invalid JSON or malformed permission arrays, the hook fails closed (`deny`) until the file is fixed.
3. **Evaluates Shell Commands Across Three Dimensions (`run_command`):**
   - **Bash Rules:** Matches both the composite command line and each split subcommand (`&&`, `||`, `;`, `|`, `|&`, `&`, and newlines).
   - **Arbitrary Execution Guard:** Inspects the full line and every subcommand for dynamic substitutions, inline interpreters, and subcommand-executing flags.
   - **File Writes & Self-Protection:** Extracts output redirections (`>`, `>>`), `tee`, and file-modifying utilities (`cp`, `mv`, `ln`, `install`, `dd of=`, `sed -i`/`w`, `find -fprintf`, `git --output=`, `curl -o`, `wget -O`), resolving paths against `args.Cwd` and any `cd`/`pushd`/`popd` in the chain.
4. **Enforces Strict Precedence (`Deny > Ask > Allow`):** Combines all checks and writes `{ "decision": "...", "reason": "..." }` to `stdout`.
5. **Writes a Redacted Audit Trail:** Logs every evaluation to `.agents/hooks/claude-permissions.log` with file contents and inline secrets redacted.

---

## Decision Mapping & Precedence

Antigravity's hook decision values behave differently from Claude Code's setting names:
- In Antigravity, returning `"allow"` only defers to the next hook or default policy rather than approving the tool call. To get Claude Code's allow behavior, the hook returns `"auto_approve"`.
- In Antigravity, returning `"ask"` honors cached "Always Allow" approvals. To ensure risky commands and explicit `ask` rules always prompt, the hook returns `"force_ask"`.

| Claude Code Level | Antigravity Decision | Behavior in Antigravity CLI |
| :--- | :--- | :--- |
| **`deny`** | `"deny"` | Hard block. Execution is aborted and `reason` is returned to the agent. |
| **`ask`** | `"force_ask"` | Always prompts the user interactively, ignoring cached approvals. |
| **`allow`** | `"auto_approve"` | Automatically approves execution without prompting the user. |

**Strict Precedence (`deny` > `force_ask` > `auto_approve`):**
- An explicit `deny` rule **always wins**—even if `agy-cli-permission-hook-arbitrary-command-execution` is set to `"allow"` or a command redirects to a file that would otherwise prompt.

---

## Settings Loading Order & Merging

Settings are loaded and merged in the following order:

1. `~/.claude/settings.json` *(Global user settings — path rules anchored to `~`)*
2. `~/.claude/settings.local.json` *(Global user local overrides — path rules anchored to `~`)*
3. `<workspace>/.claude/settings.json` *(Project settings — path rules anchored to `<workspace>`)*
4. `<workspace>/.claude/settings.local.json` *(Project local overrides — path rules anchored to `<workspace>`)*

- `permissions.deny`, `permissions.ask`, and `permissions.allow` arrays are concatenated across all present files, with each rule retaining the base directory (`baseDir`) of the file it came from.
- Root properties (`agy-cli-permission-hook-default-access` and `agy-cli-permission-hook-arbitrary-command-execution`) use the most specific (last loaded) valid value.
- If any existing settings file contains malformed JSON, the hook fails closed (`deny`) for all tool calls until the file is repaired.

---

## Configuration Reference

### Recommended Starter Configuration

Save this in `.claude/settings.json`:

~~~json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "agy-cli-permission-hook-default-access": "ask",
  "agy-cli-permission-hook-arbitrary-command-execution": "ask",
  "permissions": {
    "deny": [
      "Bash(rm -rf /)",
      "Bash(rm -rf /*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git checkout main && git push)",
      "Read(.env)",
      "Read(.env.*)",
      "Read(./secrets/**)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(.claude/settings.json)",
      "Edit(.claude/settings.local.json)"
    ],
    "ask": [
      "Bash(rm -rf:*)",
      "Bash(rm -r:*)",
      "Bash(git push:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -f:*)",
      "Bash(npm publish:*)"
    ],
    "allow": [
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(npm test:*)",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch(github.com:*)"
    ]
  }
}
~~~

### Custom Root Properties

| Property | Allowed Values | Default | Description |
| :--- | :--- | :--- | :--- |
| `agy-cli-permission-hook-default-access` | `"allow" \| "ask" \| "deny"` | `"ask"` | Fallback level used when a tool or subcommand matches no explicit rule. Invalid values fall back to `"ask"`. |
| `agy-cli-permission-hook-arbitrary-command-execution` | `"allow" \| "ask" \| "deny"` | `"ask"` | Level applied when arbitrary command execution is detected. Combined with rule evaluations using strict `deny > ask > allow` precedence. |

### Bash Command Rule Syntax

| Pattern Form | Example | Matches | Does NOT Match | How It Works |
| :--- | :--- | :--- | :--- | :--- |
| **Bare Tool**<br>`Bash` | `Bash` | Every shell command | — | Matches all subcommands (still subject to `deny`, `ask`, arbitrary-execution, and write-target checks). |
| **Exact**<br>`Bash(cmd)` | `Bash(git status)` | `git status` | `git status -s`<br>`git status -uno` | Exact string match; allows zero additional flags or arguments. |
| **Delimited Prefix**<br>`Bash(cmd:*)` | `Bash(npm test:*)` | `npm test`<br>`npm test --watch`<br>`npm test/unit` | `npm testrun`<br>`npm testing` | Enforces a word boundary (` `, `\t`, or `/`). Matches the command with **0 or more** arguments. |
| **Space + Glob**<br>`Bash(cmd *)` | `Bash(git diff *)` | `git diff HEAD`<br>`git diff --staged` | `git diff` *(0 args)*<br>`git difftool` | Requires a literal space followed by any characters (`.*`). Unlike `:*`, it does **not** match bare `cmd` with 0 arguments. |
| **Raw Glob**<br>`Bash(cmd*)` | `Bash(git push origin master*)` | `git push origin master`<br>`git push origin master:main` | `git push origin main` | Matches `cmd` followed by any characters without requiring a word boundary. |

**Chained Commands & Wrapper Stripping:**
1. **Whole-Line Check:** The full command string is checked against `deny` and `ask` rules first so compound rules like `Bash(git checkout main && git push)` work as expected.
2. **Subcommand Splitting:** The line is split on `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines (ignoring operators inside quotes). Every subcommand is evaluated individually, and the strictest verdict wins.
3. **Wrapper & Env-Var Asymmetry:**
   - For **`deny`** and **`ask`** rules, wrappers (`sudo`, `doas`, `env`, `timeout`, `nice`, `nohup`, `ionice`, `stdbuf`, `setsid`, `chroot`, `watch`, `script -c`, `su -c`), inline `KEY=VAL` prefixes, quotes, and leading paths (`/bin/rm` -> `rm`) are stripped so restrictions cannot be bypassed.
   - For **`allow`** rules, wrappers and env vars are **never** stripped—`sudo git status` or `LD_PRELOAD=/tmp/x.so git status` will not match `Bash(git status)`.

### Path Pattern Syntax & Normalization

| Pattern Form | Example | Resolution & Matching Semantics |
| :--- | :--- | :--- |
| **Home Directory**<br>`~/...` | `Read(~/.ssh/**)` | Expanded to the current user's OS home directory (`os.homedir()`). |
| **Filesystem Absolute**<br>`//...` | `Read(//etc/passwd)`<br>`Read(//c/Users/alice/roms/**)` | Always resolved from the filesystem root (`/etc/passwd`, `C:\Users\alice\roms\**`) or UNC share (`//wsl.localhost/...`). |
| **Settings-Relative**<br>`/...` | `Read(/secrets/**)` | Resolved relative to the directory containing the settings file (`<workspace>/secrets/**` for project settings, `~/secrets/**` for `~/.claude/settings.json`). For `deny` and `ask` rules only, `/mnt/...`, `/home/...`, `/Users/...`, `/etc/...`, `/tmp/...` also check the system root as a safety fallback. |
| **Workspace-Anchored**<br>`./...` or `dir/...` | `Read(./.env)`<br>`Edit(src/config/**)` | Anchored to the settings/workspace root. `Read(./.env)` matches `<ws>/.env`, but **not** `<ws>/sub/.env`. |
| **Slash-Free (Gitignore)**<br>`name` | `Read(.env)`<br>`Read(*.min.js)` | Contains no slash: matches at **any directory depth** inside the workspace (`<ws>/.env`, `<ws>/config/.env`, `<ws>/a/b/app.min.js`). |
| **Recursive Glob**<br>`**/...` | `Read(**/dist/**)` | Matches across zero or more directory levels. |
| **Directory Contents**<br>`dir/**` | `Read(./secrets/**)` | Matches all files and subdirectories inside `dir` **and** the directory root `dir` itself (preventing `list_dir` leaks). |

- **Symlink Resolution:** All target paths (and existing parent directories for newly created files) are resolved with `fs.realpathSync`. A symlink inside the workspace pointing to `~/.ssh/id_rsa` is evaluated as `~/.ssh/id_rsa`.
- **Cross-Platform Normalization:** Windows paths (`C:\Users\...`), WSL mounts (`/mnt/c/Users/...`), and MSYS/Git-Bash paths (`//c/Users/...`) canonicalize to `/c/Users/...` so a single rule matches across environments.
- **Case Sensitivity:** Path matching is case-sensitive on Linux/macOS POSIX paths and case-insensitive on Windows and mounted Windows drive paths (`/c/...`, `//wsl.localhost/...`).

### Antigravity Tool Mapping

| Rule Category | Antigravity Tools Matched | Inspected Arguments |
| :--- | :--- | :--- |
| **`Bash`** | `run_command` | `CommandLine`, `Cwd` |
| **`Read`** | `view_file`, `view_file_outline`, `view_code_item`, `list_dir`, `find_by_name`, `grep_search` | `AbsolutePath`, `DirectoryPath`, `SearchDirectory`, `SearchPath` |
| **`Glob`** | `list_dir`, `find_by_name` | `DirectoryPath`, `SearchDirectory` |
| **`Grep`** | `grep_search` | `SearchPath`, `SearchDirectory` |
| **`Edit` / `Write`** | `write_to_file`, `replace_file_content`, `multi_replace_file_content` (+ shell writes in `run_command`) | `TargetFile` |
| **`WebSearch`** | `search_web` | `query`, `domain` |
| **`WebFetch`** | `read_url_content` | `Url` |
| *(Default Access)* | All other tools (`manage_task`, `schedule`, `invoke_subagent`, etc.) | Governed by `agy-cli-permission-hook-default-access` |

If any file, directory, or search tool is invoked without a recognized non-empty path argument, the hook never substitutes the workspace root; it checks bare `deny` rules and otherwise returns `"force_ask"`.

---

## Security Model, Arbitrary Execution Guard & Limitations

### What the Arbitrary Execution Guard Catches

Across the full command line and every individual subcommand in a pipeline:
- **Substitutions:** Command substitutions `$(...)` and `` `...` `` (ignored inside literal single quotes `'...'`), process substitutions `<(...)` and `>(...)`, and arithmetic evaluations `$((...))` and `$[...]`.
- **Expansions & Quotings:** Shell brace expansions (`{a,b}`, `{1..10}`), ANSI-C quoting (`$'...'`), and heredocs (`<<`, `<<-`).
- **Dynamic Command Names:** Any variable (`$CMD`, `rm${IFS}-rf`) or glob (`*`, `?`, `[`) in the command name word (`/bin/r[m]`).
- **Dangerous Environment Variables:** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `PYTHONPATH`, `RUBYOPT`, `PERL5OPT`, `BASH_ENV`, `ENV`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `PAGER`, `GIT_PAGER`, `EDITOR`, `VISUAL`.
- **Network & Complex FD Redirections:** `/dev/tcp/*`, `/dev/udp/*`, and non-numeric `>&` / `<&` redirections. *(Standard numeric descriptor duplications like `2>&1`, `1>&2`, `>&2`, and `2>&-` are allowed.)*
- **Shell Evaluators & Inline Interpreters:** `eval`, `exec`, `source`, `.`, `xargs`, `su -c`, `busybox sh`, `bash`/`sh`/`zsh`/`dash`/`ksh`/`ash`/`fish` (`-c`, `-lc`, `-ec`, `--command`), `python*` (`-c`), `node`/`deno`/`bun` (`-e`, `--eval`, `-p`, `--print`), `perl`/`ruby`/`lua` (`-e`, `-E`), `php` (`-r`), `powershell`/`pwsh` (any command/flag invocation), and `cmd.exe` (`/c`, `/k`).
- **Tool Subcommand Hooks:** `git -c ...` (including compact `-c<key>=<val>`), `git --config-env`, `git --exec-path`, `git --upload-pack`, `git --receive-pack`, `git config` modifications to executable keys/aliases, `tar --to-command`, `tar --checkpoint-action`, `tar -I` / `--use-compress-program`, `find -exec` / `-execdir` / `-ok` / `-okdir`, `awk` `system()` and command pipes (`|`), and GNU `sed` `e` commands/flags (`sed '1e id'`, `sed 's/a/b/Ie'`).

### Important Limitations to Understand

1. **Deny Rules Are Best-Effort Static Filters, Not an OS Sandbox:** Command-pattern `deny` rules inspect argument strings prior to execution. They do not replace OS containerization or Antigravity's terminal sandbox.
2. **Broad Tool Allow Rules Imply Code Execution:** Allowing `Bash(git:*)`, `Bash(npm:*)`, `Bash(python:*)`, or `Bash(make:*)` allows running scripts defined in repository files (`package.json`, `Makefile`, `.git/hooks`, or Python scripts). Treat broad developer-tool allows as trusting the code inside the repository.
3. **Self-Protection Scope:** Self-protection blocks silent edits to `.claude/settings*.json`, `.agents/hooks.json`, `.agents/hooks/**`, and `~/.gemini/config/hooks.json` via file tools, shell redirections (`>`, `>>`), `tee`, and common file-writing utilities (`cp`, `mv`, `ln`, `install`, `dd of=`, `sed -i`/`w`, `find -fprintf`, `git --output=`, `curl -o`, `wget -O`), and prompts when `cd`/`pushd`/`popd` precedes a relative write. Custom binaries or scripts that write files internally without shell arguments are not statically visible to the hook.

---

## Installation & Target Setup

~~~bash
# Install or update the hook in another repository (relative or absolute path)
npm run setup -- ../my-other-project
npm run setup -- /absolute/path/to/project

# Install or update in the current repository
npm run setup
~~~

`scripts/setup.ts`:
1. Copies `src/claude-permissions.ts` to `<target>/.agents/hooks/claude-permissions.ts`.
2. Writes or updates the `claude-permissions-bridge` entry in `<target>/.agents/hooks.json` with the absolute path to the hook script (preserving any other existing hooks, and refusing to overwrite malformed `hooks.json` files).
3. Adds `.agents/hooks/*.log` to `<target>/.gitignore`.
4. Extracts the demarcated block below from this `README.md` and inserts or updates it in `<target>/README.md`.

---

## Troubleshooting & Audit Logs

Every invocation appends a timestamped, secret-redacted entry to `.agents/hooks/claude-permissions.log` (automatically rotated at 1 MB):

~~~text
[2026-11-10T21:55:00.000Z] Evaluating tool: "run_command" | cwd: "/repo" | args: {"CommandLine":"git status"}
[2026-11-10T21:55:00.002Z] Outcome: AUTO_APPROVE | Reason: N/A
~~~

You can also test the hook directly from your terminal:

~~~bash
echo '{"toolCall":{"name":"run_command","args":{"CommandLine":"git status"}},"workspacePaths":["/path/to/repo"]}' | node .agents/hooks/claude-permissions.ts
~~~

---

## Downstream Project Documentation

The section below (between `<!-- CLAUDE-PERMISSIONS-HOOK:START -->` and `<!-- CLAUDE-PERMISSIONS-HOOK:END -->`) is scraped by `scripts/setup.ts` and copied into the `README.md` of any target repository you set up.

<!-- CLAUDE-PERMISSIONS-HOOK:START -->
### Antigravity Claude Permissions Hook

This repository uses the **Claude Permissions Bridge Hook** for Antigravity CLI to enforce tool permissions defined in `.claude/settings.json` (and optional `.claude/settings.local.json`).

- **Hook Script:** `.agents/hooks/claude-permissions.ts`
- **Hook Config:** `.agents/hooks.json` (`claude-permissions-bridge` -> `PreToolUse`)
- **Audit Log:** `.agents/hooks/claude-permissions.log` (gitignored, auto-redacted & size-bounded)

#### Behavior
- **Precedence:** Enforces strict **Deny > Ask (`force_ask`) > Allow (`auto_approve`)** precedence across `~/.claude/settings*.json` and `.claude/settings*.json`.
- **Compound Commands:** Splits chained pipelines (`&&`, `||`, `;`, `|`, `&`, newlines) and enforces the strictest verdict across all subcommands.
- **Arbitrary Execution Guard:** Detects command substitutions (`$()`, backticks), arithmetic (`$((...))`), heredocs (`<<`), brace expansions (`{a,b}`), `git -c` flags, `awk`/`sed` command execution, and inline interpreters across every subcommand.
- **Self-Protection:** Edits, shell redirections (`>`, `>>`, `tee`), or file-writing commands (`cp`, `mv`, `dd`, `sed -i`, etc.) targeting `.claude/settings*.json`, `.agents/hooks.json`, `.agents/hooks/**`, or `~/.gemini/config/hooks.json` always require explicit approval (`force_ask`) or are denied.

#### Updating the Hook
To pull in the latest hook updates from the upstream permissions repository, run:
~~~bash
npm --prefix /path/to/antigravity-claude-permissions-hook run setup -- .
~~~
<!-- CLAUDE-PERMISSIONS-HOOK:END -->