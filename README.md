# Antigravity Claude Permissions Hook

A zero-dependency, cross-platform `PreToolUse` hook for **Antigravity CLI** that lets you govern agent tool calls using **Claude Code's** `.claude/settings.json` permission format—with strict **Deny > Ask > Allow** precedence, compound command splitting, cross-platform path globs, and arbitrary command execution guards.

---

## Table of Contents

- [Quick Install (For Users)](#quick-install-for-users)
- [Why Antigravity's Built-In Permissions Are Insufficient](#why-antigravitys-built-in-permissions-are-insufficient)
- [A Quick Example](#a-quick-example)
- [Recommended `.claude/settings.json` Starter Config](#recommended-claudesettingsjson-starter-config)
- [Configuration Reference](#configuration-reference)
  - [Custom Root Properties](#custom-root-properties)
  - [Decision Mapping & Precedence](#decision-mapping--precedence)
  - [Settings Loading Order & Merging](#settings-loading-order--merging)
  - [Bash Command Rule Syntax](#bash-command-rule-syntax)
  - [Path Pattern Syntax & Normalization](#path-pattern-syntax--normalization)
  - [Antigravity Tool Mapping](#antigravity-tool-mapping)
  - [Security Model, Arbitrary Execution Guard & Limitations](#security-model-arbitrary-execution-guard--limitations)
- [Troubleshooting & Audit Logs](#troubleshooting--audit-logs)
- [Developer & Contributor Guide](#developer--contributor-guide)
  - [Requirements & Volta Support](#requirements--volta-support)
  - [Developer Setup & Running Tests](#developer-setup--running-tests)
  - [Repository File Structure](#repository-file-structure)
- [Downstream Project Documentation Template](#downstream-project-documentation-template)

---

## Quick Install (For Users)

1. **Clone this repository once** onto your machine:

   ```bash
   git clone https://github.com/tjcouch1/antigravity-claude-permissions-hook.git
   cd antigravity-claude-permissions-hook
   ```

2. **Install the hook into any target project** (using a relative or absolute path):

   ```bash
   npm run setup -- ../path/to/your-project
   ```

   Running `npm run setup -- <target-dir>` is idempotent—you can re-run it anytime to update an existing installation. It automatically:
   - Copies the standalone hook into `<target>/.agents/hooks/claude-permissions.ts`.
   - Registers the `PreToolUse` hook in `<target>/.agents/hooks.json` with an absolute path (preserving any other hooks you already have).
   - Adds `.agents/hooks/*.log` to `<target>/.gitignore`.
   - Adds or updates the hook documentation block in `<target>/README.md`.

3. **Create a `.claude/settings.json` file** in your target project (or in `~/.claude/settings.json` for global rules).

---

## Why Antigravity's Built-In Permissions Are Insufficient

Out of the box, Antigravity CLI's permission model makes day-to-day agent workflows either **too noisy** or **too dangerous**:

1. **Coarse Tool Approvals vs. Granular Path/Command Rules:** Approving file reads or shell commands in Antigravity quickly leads to "Always Allow" fatigue, or conversely exposes sensitive files (`.env`, `~/.ssh/**`, proprietary assets/ROMs) and destructive git commands (`git push --force`, `git reset --hard`).
2. **Compound Shell Commands Bypass Simple Prefix Checks:** Agents frequently chain commands (`git status && rm -rf dist`, `npm test 2>&1 | tail -20`). Without a shell-aware parser that splits `&&`, `||`, `;`, `|`, and newlines and takes the _strictest_ verdict across all subcommands, a harmless first command can mask a destructive second command.
3. **No Shared Config with Claude Code:** Many projects already maintain carefully tuned `.claude/settings.json` rules (`Read(...)`, `Edit(...)`, `Bash(...)`, `WebFetch(...)`). Maintaining two incompatible permission schemas across tools is error-prone.
4. **Silent Self-Modification Risks:** Without dedicated self-protection, an agent granted broad `Edit` or `Bash` permissions can edit `.claude/settings.local.json` or redirect output (`echo ... > .agents/hooks.json`) to grant itself unrestricted execution.

---

## A Quick Example

Suppose your `.claude/settings.json` has:

```json
{
  "permissions": {
    "allow": ["Bash(git status)", "Bash(git diff:*)", "Read"],
    "ask": ["Bash(git push:*)"],
    "deny": ["Bash(git push --force:*)", "Read(.env)"]
  }
}
```

Here is what happens when the agent tries different actions in Antigravity CLI:

- `git status && git diff HEAD` -> **Auto-Approved** (both subcommands match `allow`).
- `git status && git push origin feature` -> **Prompts User (`force_ask`)** (`git push` requires confirmation, so the whole chain prompts).
- `git status && git push --force origin main` -> **Denied** (`git push --force` is denied, blocking the entire chain).
- `view_file` on `config/.env` -> **Denied** (`Read(.env)` blocks `.env` at any directory depth, even though bare `Read` is in `allow`).

---

## Recommended `.claude/settings.json` Starter Config

Place this in `<your-project>/.claude/settings.json` (or `~/.claude/settings.json` for user-wide defaults):

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "agy-cli-permission-hook-default-access": "ask",
  "agy-cli-permission-hook-arbitrary-command-execution": "ask",
  "permissions": {
    "deny": [
      "Bash(rm -rf /)",
      "Bash(rm -rf /*)",
      "Bash(mkfs:*)",
      "Bash(chmod -R 777 /)",
      "Bash(git push origin main)",
      "Bash(git push origin main:*)",
      "Bash(git push origin master)",
      "Bash(git push origin master:*)",
      "Bash(git checkout main && git push)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git commit --no-verify:*)",
      "Bash(git commit -n:*)",
      "Edit(.claude/settings.json)",
      "Edit(.claude/settings.local.json)",
      "Read(.env)",
      "Read(.env.*)",
      "Read(./secrets/**)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.netrc)",
      "Read(~/.config/gh/**)",
      "Read(~/.gnupg/**)"
    ],
    "ask": [
      "Bash(rm -rf:*)",
      "Bash(rm -r:*)",
      "Bash(git push:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -f:*)",
      "Bash(chmod -R:*)",
      "Bash(chown -R:*)",
      "Bash(sudo:*)",
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
```

---

## Configuration Reference

### Custom Root Properties

In addition to the standard `permissions` object (`deny`, `ask`, `allow`), this hook supports two root-level properties in `.claude/settings.json`:

| Property                                              | Allowed Values               | Default | Description                                                                                                                              |
| :---------------------------------------------------- | :--------------------------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `agy-cli-permission-hook-default-access`              | `"allow" \| "ask" \| "deny"` | `"ask"` | Fallback level used when a tool or subcommand matches no explicit rule. Invalid values fall back to `"ask"`.                             |
| `agy-cli-permission-hook-arbitrary-command-execution` | `"allow" \| "ask" \| "deny"` | `"ask"` | Level applied when arbitrary command execution is detected. Combined with rule evaluations using strict `deny > ask > allow` precedence. |

### Decision Mapping & Precedence

Antigravity's hook return values differ from Claude Code's setting names:

- Returning `"allow"` in Antigravity only defers to the default policy rather than approving the tool call. To get Claude Code's allow behavior, the hook emits `"auto_approve"`.
- Returning `"ask"` in Antigravity honors cached "Always Allow" approvals. To ensure `ask` rules and arbitrary-execution prompts cannot be skipped by cached approvals, the hook emits `"force_ask"`.

| Claude Code Level | Antigravity Decision | Behavior in Antigravity CLI                                             |
| :---------------- | :------------------- | :---------------------------------------------------------------------- |
| **`deny`**        | `"deny"`             | Hard block. Execution is aborted and `reason` is returned to the agent. |
| **`ask`**         | `"force_ask"`        | Always prompts the user interactively, ignoring cached approvals.       |
| **`allow`**       | `"auto_approve"`     | Automatically approves execution without prompting the user.            |

**Strict Precedence (`deny` > `force_ask` > `auto_approve`):**

- An explicit `deny` rule **always wins**—even if `agy-cli-permission-hook-arbitrary-command-execution` is set to `"allow"` or a command redirects to a file that would otherwise prompt.

### Settings Loading Order & Merging

Settings are loaded and merged in this order:

1. `~/.claude/settings.json` _(Global user settings — relative path rules anchored to `~`)_
2. `~/.claude/settings.local.json` _(Global user local overrides — relative path rules anchored to `~`)_
3. `<workspace>/.claude/settings.json` _(Project settings — relative path rules anchored to `<workspace>`)_
4. `<workspace>/.claude/settings.local.json` _(Project local overrides — relative path rules anchored to `<workspace>`)_

- `permissions.deny`, `permissions.ask`, and `permissions.allow` lists are combined across all present files, with each rule retaining the base directory of the file it came from.
- Root properties (`agy-cli-permission-hook-default-access` and `agy-cli-permission-hook-arbitrary-command-execution`) use the most specific (last loaded) valid setting.
- **Fail-Closed on Corrupt JSON:** If any existing settings file contains malformed JSON, the hook blocks all calls (`deny`) until the file is fixed.

### Bash Command Rule Syntax

| Pattern Form                          | Example                         | Matches                                                   | Does NOT Match                          | How It Works                                                                                                                |
| :------------------------------------ | :------------------------------ | :-------------------------------------------------------- | :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **Bare Tool**<br>`Bash`               | `Bash`                          | Every shell command                                       | —                                       | Matches all subcommands (still subject to `deny`, `ask`, arbitrary-execution, and write-target checks).                     |
| **Exact**<br>`Bash(cmd)`              | `Bash(git status)`              | `git status`                                              | `git status -s`<br>`git status -uno`    | Exact string match; allows zero additional flags or arguments.                                                              |
| **Delimited Prefix**<br>`Bash(cmd:*)` | `Bash(npm test:*)`              | `npm test`<br>`npm test --watch`<br>`npm test/unit`       | `npm testrun`<br>`npm testing`          | Enforces a word boundary (` `, `\t`, or `/`). Matches the command with **0 or more** arguments.                             |
| **Space + Glob**<br>`Bash(cmd *)`     | `Bash(git diff *)`              | `git diff HEAD`<br>`git diff --staged`                    | `git diff` _(0 args)_<br>`git difftool` | Requires a literal space followed by any characters (`.*`). Unlike `:*`, it does **not** match bare `cmd` with 0 arguments. |
| **Raw Glob**<br>`Bash(cmd*)`          | `Bash(git push origin master*)` | `git push origin master`<br>`git push origin master:main` | `git push origin main`                  | Matches `cmd` followed by any characters without requiring a word boundary.                                                 |

**Chained Commands & Wrapper Stripping:**

1. **Whole-Line Check:** The full command string is checked against `deny` and `ask` rules first so compound rules like `Bash(git checkout main && git push)` work as expected.
2. **Subcommand Splitting:** The line is split on `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines (ignoring operators inside quotes). Every subcommand is evaluated individually, and the strictest verdict wins.
3. **Wrapper & Env-Var Asymmetry:**
   - For **`deny`** and **`ask`** rules, wrappers (`sudo`, `doas`, `env`, `timeout`, `nice`, `nohup`, `ionice`, `stdbuf`, `setsid`, `chroot`, `watch`, `script -c`, `su -c`), inline `KEY=VAL` prefixes, quotes, and leading paths (`/bin/rm` -> `rm`) are stripped so restrictions cannot be bypassed.
   - For **`allow`** rules, wrappers and env vars are **never** stripped—`sudo git status` or `LD_PRELOAD=/tmp/x.so git status` will not match `Bash(git status)`.

### Path Pattern Syntax & Normalization

| Pattern Form                                   | Example                                                 | Resolution & Matching Semantics                                                                                                                                                                                                                                                                                |
| :--------------------------------------------- | :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home Directory**<br>`~/...`                  | `Read(~/.ssh/**)`                                       | Expanded to the current user's OS home directory (`os.homedir()`).                                                                                                                                                                                                                                             |
| **Filesystem Absolute**<br>`//...`             | `Read(//etc/passwd)`<br>`Read(//c/Users/alice/roms/**)` | Always resolved from the filesystem root (`/etc/passwd`, `C:\Users\alice\roms\**`) or UNC share (`//wsl.localhost/...`).                                                                                                                                                                                       |
| **Settings-Relative**<br>`/...`                | `Read(/secrets/**)`                                     | Resolved relative to the directory containing the settings file (`<workspace>/secrets/**` for project settings, `~/secrets/**` for `~/.claude/settings.json`). For `deny` and `ask` rules only, `/mnt/...`, `/home/...`, `/Users/...`, `/etc/...`, `/tmp/...` also check the system root as a safety fallback. |
| **Workspace-Anchored**<br>`./...` or `dir/...` | `Read(./.env)`<br>`Edit(src/config/**)`                 | Anchored to the settings/workspace root. `Read(./.env)` matches `<ws>/.env`, but **not** `<ws>/sub/.env`.                                                                                                                                                                                                      |
| **Slash-Free (Gitignore)**<br>`name`           | `Read(.env)`<br>`Read(*.min.js)`                        | Contains no slash: matches at **any directory depth** inside the workspace (`<ws>/.env`, `<ws>/config/.env`, `<ws>/a/b/app.min.js`).                                                                                                                                                                           |
| **Recursive Glob**<br>`**/...`                 | `Read(**/dist/**)`                                      | Matches across zero or more directory levels.                                                                                                                                                                                                                                                                  |
| **Directory Contents**<br>`dir/**`             | `Read(./secrets/**)`                                    | Matches all files and subdirectories inside `dir` **and** the directory root `dir` itself (preventing `list_dir` leaks).                                                                                                                                                                                       |

- **Symlink Resolution:** All target paths (and existing parent directories for newly created files) are resolved with `fs.realpathSync`. A symlink inside the workspace pointing to `~/.ssh/id_rsa` is evaluated as `~/.ssh/id_rsa`.
- **Cross-Platform Normalization:** Windows paths (`C:\Users\...`), WSL mounts (`/mnt/c/Users/...`), and MSYS/Git-Bash paths (`//c/Users/...`) canonicalize to `/c/Users/...` so a single rule matches across environments.
- **Case Sensitivity:** Path matching is case-sensitive on Linux/macOS POSIX paths and case-insensitive on Windows and mounted Windows drive paths (`/c/...`, `//wsl.localhost/...`).

### Antigravity Tool Mapping

| Rule Category        | Antigravity Tools Matched                                                                               | Inspected Arguments                                              |
| :------------------- | :------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------- |
| **`Bash`**           | `run_command`                                                                                           | `CommandLine`, `Cwd`                                             |
| **`Read`**           | `view_file`, `view_file_outline`, `view_code_item`, `list_dir`, `find_by_name`, `grep_search`           | `AbsolutePath`, `DirectoryPath`, `SearchDirectory`, `SearchPath` |
| **`Glob`**           | `list_dir`, `find_by_name`                                                                              | `DirectoryPath`, `SearchDirectory`                               |
| **`Grep`**           | `grep_search`                                                                                           | `SearchPath`, `SearchDirectory`                                  |
| **`Edit` / `Write`** | `write_to_file`, `replace_file_content`, `multi_replace_file_content` (+ shell writes in `run_command`) | `TargetFile`                                                     |
| **`WebSearch`**      | `search_web`                                                                                            | `query`, `domain`                                                |
| **`WebFetch`**       | `read_url_content`                                                                                      | `Url`                                                            |
| _(Default Access)_   | All other tools (`manage_task`, `schedule`, `invoke_subagent`, etc.)                                    | Governed by `agy-cli-permission-hook-default-access`             |

If any file, directory, or search tool is invoked without a recognized non-empty path argument, the hook never substitutes the workspace root; it checks bare `deny` rules and otherwise returns `"force_ask"`.

### Security Model, Arbitrary Execution Guard & Limitations

#### What the Arbitrary Execution Guard Catches

Across the full command line and every individual subcommand in a pipeline:

- **Substitutions:** Command substitutions `$(...)` and `` `...` `` (ignored inside literal single quotes `'...'`), process substitutions `<(...)` and `>(...)`, and arithmetic evaluations `$((...))` and `$[...]`.
- **Expansions & Quotings:** Shell brace expansions (`{a,b}`, `{1..10}`), ANSI-C quoting (`$'...'`), and heredocs (`<<`, `<<-`).
- **Dynamic Command Names:** Any variable (`$CMD`, `rm${IFS}-rf`) or glob (`*`, `?`, `[`) in the command name word (`/bin/r[m]`).
- **Dangerous Environment Variables:** `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `PYTHONPATH`, `RUBYOPT`, `PERL5OPT`, `BASH_ENV`, `ENV`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `PAGER`, `GIT_PAGER`, `EDITOR`, `VISUAL`.
- **Network & Complex FD Redirections:** `/dev/tcp/*`, `/dev/udp/*`, and non-numeric `>&` / `<&` redirections. _(Standard numeric descriptor duplications like `2>&1`, `1>&2`, `>&2`, and `2>&-` are allowed.)_
- **Shell Evaluators & Inline Interpreters:** `eval`, `exec`, `source`, `.`, `xargs`, `su -c`, `busybox sh`, `bash`/`sh`/`zsh`/`dash`/`ksh`/`ash`/`fish` (`-c`, `-lc`, `-ec`, `--command`), `python*` (`-c`), `node`/`deno`/`bun` (`-e`, `--eval`, `-p`, `--print`), `perl`/`ruby`/`lua` (`-e`, `-E`), `php` (`-r`), `powershell`/`pwsh` (any command/flag invocation), and `cmd.exe` (`/c`, `/k`).
- **Tool Subcommand Hooks:** `git -c ...` (including compact `-c<key>=<val>`), `git --config-env`, `git --exec-path`, `git --upload-pack`, `git --receive-pack`, `git config` modifications to executable keys/aliases, `tar --to-command`, `tar --checkpoint-action`, `tar -I` / `--use-compress-program`, `find -exec` / `-execdir` / `-ok` / `-okdir`, `awk` `system()` and command pipes (`|`), and GNU `sed` `e` commands/flags (`sed '1e id'`, `sed 's/a/b/Ie'`).

#### Important Limitations to Understand

1. **Deny Rules Are Best-Effort Static Filters, Not an OS Sandbox:** Command-pattern `deny` rules inspect argument strings prior to execution. They do not replace OS containerization or Antigravity's terminal sandbox.
2. **Broad Tool Allow Rules Imply Code Execution:** Allowing `Bash(git:*)`, `Bash(npm:*)`, `Bash(python:*)`, or `Bash(make:*)` allows running scripts defined in repository files (`package.json`, `Makefile`, `.git/hooks`, or Python scripts). Treat broad developer-tool allows as trusting the code inside the repository.
3. **Self-Protection Scope:** Self-protection blocks silent edits to `.claude/settings*.json`, `.agents/hooks.json`, `.agents/hooks/**`, and `~/.gemini/config/hooks.json` via file tools, shell redirections (`>`, `>>`), `tee`, and common file-writing utilities (`cp`, `mv`, `ln`, `install`, `dd of=`, `sed -i`/`w`, `find -fprintf`, `git --output=`, `curl -o`, `wget -O`), and prompts when `cd`/`pushd`/`popd` precedes a relative write. Custom binaries or scripts that write files internally without shell arguments are not statically visible to the hook.

---

## Troubleshooting & Audit Logs

Every hook invocation appends a timestamped, secret-redacted entry to `<your-project>/.agents/hooks/claude-permissions.log` (automatically rotated at 1 MB):

```text
[2026-11-10T21:55:00.000Z] Evaluating tool: "run_command" | cwd: "/repo" | args: {"CommandLine":"git status"}
[2026-11-10T21:55:00.002Z] Outcome: AUTO_APPROVE | Reason: N/A
```

To test how the hook evaluates a specific command or file path directly from your terminal:

```bash
echo '{"toolCall":{"name":"run_command","args":{"CommandLine":"git status && rm -rf dist"}},"workspacePaths":["/path/to/your-project"]}' | node /path/to/your-project/.agents/hooks/claude-permissions.ts
```

If all calls are unexpectedly denied:

- Check `.agents/hooks/claude-permissions.log` for `Settings configuration error (Invalid JSON in settings file ...)`. The hook intentionally fails closed if `.claude/settings.json` or `.claude/settings.local.json` has a JSON syntax error such as a trailing comma.

---

## Developer & Contributor Guide

### Requirements & Volta Support

- **Node.js `>= 22.18.0`** (or **`>= 23.6.0` / `24.x` / `26.x`**) is required so Node can run `.ts` files natively without experimental flags.
- **Volta Users:** Because Volta ignores the `"engines"` field and reads the top-level `"volta"` key in `package.json`, this repository includes both:
  - `"volta": { "node": "24.22.2" }` for automatic per-project switching with Volta.
  - `"engines": { "node": ">=22.18.0" }` for npm and CI tooling.
  - You can update the pinned Volta version at any time with `volta pin node@24` or `volta pin node@26`.

### Developer Setup & Running Tests

```bash
# 1. Install devDependencies (Vitest 5.1.0 & TypeScript)
npm ci

# 2. Run the full test suite once
npm test

# 3. Run Vitest in watch mode during development
npm run test:watch

# 4. Test installing the hook into a target directory
npm run setup -- ./tmp-verify-setup
```

### Repository File Structure

```text
antigravity-claude-permissions-hook/
├── .github/
│   └── workflows/
│       └── test.yml                  # Cross-platform CI matrix (Ubuntu + Windows)
├── scripts/
│   └── setup.ts                      # Idempotent CLI installer + exported setupTargetRepository()
├── src/
│   └── claude-permissions.ts         # Zero-dependency PreToolUse hook engine & CLI entry point
├── test/
│   └── claude-permissions.test.ts    # Vitest 5.1.0 test suite (positive + negative tests)
├── .gitignore                        # Ignores node_modules, logs, local settings (tracks lockfile)
├── AGENTS.md                         # Architecture & security invariants for AI maintainers
├── README.md                         # User & developer docs + downstream README template
├── package.json                      # Volta pin, engines >=22.18.0, Vitest ^5.1.0
└── tsconfig.json                     # Strict NodeNext TypeScript configuration
```

---

## Downstream Project Documentation Template

The section below (between `<!-- CLAUDE-PERMISSIONS-HOOK:START -->` and `<!-- CLAUDE-PERMISSIONS-HOOK:END -->`) is automatically scraped from this file by `scripts/setup.ts` and injected or updated in the `README.md` of any target repository you set up.

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

```bash
npm --prefix /path/to/antigravity-claude-permissions-hook run setup -- .
```

<!-- CLAUDE-PERMISSIONS-HOOK:END -->
