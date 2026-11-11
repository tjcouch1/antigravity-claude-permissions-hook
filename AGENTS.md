# Agent Guidelines: Antigravity Claude Permissions Hook

This document defines the architecture, security invariants, tool contracts, and testing rules for AI agents and maintainers working on this repository.

---

## 1. Repository Structure

- `src/claude-permissions.ts` — Standalone `PreToolUse` hook engine and CLI entry point.
- `scripts/setup.ts` — Idempotent installer (`setupTargetRepository`) that copies the hook into target repositories, configures `.agents/hooks.json`, updates `.gitignore`, and syncs the README documentation block.
- `test/claude-permissions.test.ts` — Vitest 5.1.0 test suite.

---

## 2. Core Security Invariants

1. **Zero External Runtime Dependencies:** `src/claude-permissions.ts` must only import Node.js built-in modules (`node:fs`, `node:path`, `node:os`, `node:url`).
2. **Deny Beats Everything:**
   - Every `run_command` evaluation computes verdicts across three dimensions:
     1. Composite and per-subcommand `Bash` rules (`deny` > `ask` > `allow`)
     2. Arbitrary command execution inspection (`agy-cli-permission-hook-arbitrary-command-execution`)
     3. Shell file writes, redirections (`>`, `>>`, `tee`, `cp`, `mv`, `dd`, `sed -i`, etc.), and self-protection
   - These three verdicts are combined using `strictestLevel` where **`deny` > `ask` (`force_ask`) > `allow` (`auto_approve`)**. Neither arbitrary-execution settings nor redirect checks may ever downgrade or skip a `deny` rule.
3. **Fail-Closed on Errors or Broken Settings:**
   - Empty or non-string `CommandLine` values return `decision: "deny"`.
   - Any syntax error or invalid schema in an existing `.claude/settings*.json` file populates `settingsErrors` and blocks all calls (`decision: "deny"`) until fixed.
   - Top-level runtime exceptions catch and output `decision: "deny"`.
4. **Wrapper & Env-Var Asymmetry (Deny/Ask vs. Allow):**
   - Execution wrappers (`sudo`, `doas`, `env`, `timeout`, `nice`, `nohup`, `ionice`, `stdbuf`, `setsid`, `chroot`, `watch`, `script -c`, `su -c`), leading `KEY=VAL` environment assignments, quotes, and binary paths (`/bin/rm` -> `rm`) are stripped **ONLY** when matching `deny` and `ask` rules.
   - `allow` rules match the raw unstripped subcommand (except trailing safe numeric fd duplication like `2>&1`). Thus `sudo git status` or `LD_PRELOAD=/tmp/x.so git status` will never match `Bash(git status)`.
5. **Self-Protection of Governance Files:**
   - The following files can never be auto-approved for modification via file tools or shell writes/redirections:
     - `<workspace>/.claude/settings.json` & `<workspace>/.claude/settings.local.json`
     - `~/.claude/settings.json` & `~/.claude/settings.local.json`
     - `<workspace>/.agents/hooks.json` & `<workspace>/.agents/hooks/**`
     - `~/.gemini/config/hooks.json` & `~/.gemini/antigravity-cli/**`

---

## 3. Antigravity Hook Protocol & Tool Argument Reference

### `hooks.json` Schema

Antigravity requires the following nesting in `.agents/hooks.json`:

~~~json
{
  "claude-permissions-bridge": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/.agents/hooks/claude-permissions.ts\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
~~~

### Tool & Argument Mapping Table

| Antigravity Tool | Claude Category | Documented Arguments (`antigravity.google/docs/hooks`) | Legacy / Fallback Aliases Checked |
| :--- | :--- | :--- | :--- |
| `run_command` | `Bash` (+ `Edit` on writes) | `CommandLine`, `Cwd`, `WaitMsBeforeAsync`, `RunPersistent`, `RequestedTerminalID` | `command`, `cmd` |
| `view_file` | `Read` | `AbsolutePath`, `StartLine`, `EndLine`, `IsSkillFile` | `file_path`, `path`, `target_file` |
| `view_file_outline` | `Read` | *(IDE/App tool)* | `AbsolutePath`, `file_path`, `path` |
| `view_code_item` | `Read` | *(IDE/App tool)* | `AbsolutePath`, `file_path`, `path` |
| `list_dir` | `Read`, `Glob` | `DirectoryPath` | `directory`, `dir_path`, `path` |
| `find_by_name` | `Read`, `Glob` | `SearchDirectory`, `Pattern`, `Type`, `Excludes`, `Extensions`, `FullPath`, `MaxDepth` | `directory`, `dir_path`, `path` |
| `grep_search` | `Grep`, `Read` | `SearchPath`, `Query`, `IsRegex`, `CaseInsensitive`, `Includes`, `MatchPerLine` | `SearchDirectory`, `directory`, `path` |
| `write_to_file` | `Edit`, `Write` | `TargetFile`, `Overwrite`, `CodeContent`, `Description`, `IsArtifact`, `ArtifactMetadata` | `file_path`, `path`, `target_file` |
| `replace_file_content` | `Edit`, `Write` | `TargetFile`, `Instruction`, `Description`, `AllowMultiple`, `TargetContent`, `ReplacementContent`, `StartLine`, `EndLine` | `file_path`, `path`, `target_file` |
| `multi_replace_file_content` | `Edit`, `Write` | `TargetFile`, `Instruction`, `Description`, `ReplacementChunks` | `file_path`, `path`, `target_file` |
| `search_web` | `WebSearch` | `query`, `domain` | — |
| `read_url_content` | `WebFetch` | `Url` | `url`, `target` |

> **Missing Path Rule:** If any mapped file, directory, or search tool is called without a recognized non-empty path argument, the hook MUST NOT fall back to checking `cwd`. It checks bare `deny` rules and otherwise returns `force_ask`.

---

## 4. Shell Lexer, Wildcards & Path Semantics

### Shell Lexer Rules
- **Single quotes (`'...'`):** Strictly literal. No escape sequences, operators, or substitutions are interpreted inside single quotes.
- **Double quotes (`"..."`):** Preserves literal operators (`&&`, `||`, `;`, `|`), while `$(...)`, `` `...` ``, and `$((...))` remain active and are flagged by `checkArbitraryExecution`.
- **Numeric FD Duplications (`2>&1`):** `[0-9]*>[&][0-9-]+` and `[0-9]*<&[0-9-]+` are lexed as safe descriptor tokens, never flagged as arbitrary execution or file writes.
- **Working Directory Tracking (`Cwd`, `cd`, `pushd`, `popd`):** Write targets resolve against `args.Cwd`. Any `cd`, `pushd`, or `popd` updates the simulated directory for subsequent commands and forces relative writes after the directory change to at least `force_ask` (unless denied).

### `:*` vs. ` *` vs. `*` in `Bash(...)`
- `Bash(cmd)` — Exact match (0 arguments).
- `Bash(cmd:*)` — Word-boundary prefix match (`cmd` alone OR `cmd` followed by space, tab, or `/` and 0+ arguments). Does not match `cmd_other`.
- `Bash(cmd *)` — Space-anchored glob (`cmd ` followed by 1+ characters). Requires a trailing space and argument; does NOT match bare `cmd`.
- `Bash(cmd*)` — Raw prefix glob without a word boundary (matches `cmd`, `cmd arg`, and `cmd_other`).

### Path Normalization & Scoping
- Rules retain the `baseDir` of the file they were loaded from (`~` for `~/.claude/settings*.json`, `<workspace>` for `<workspace>/.claude/settings*.json`).
- `//path` is filesystem-absolute; `/path` and `./path` are relative to `baseDir`.
- Single-slash POSIX root fallback (`/etc/**`, `/home/**`, `/mnt/**`) applies **only** to `deny` and `ask` rules (`allowSystemRootFallback = false` on `allow` rules).
- Patterns without slashes (`.env`) match at any depth inside `baseDir`.
- Symlinks are resolved via `fs.realpathSync` (walking up existing parent directories for non-existent target files).

---

## 5. Testing Rules for Maintainers

1. **Test via `evaluateRequestWithSettings`:** Exercise the real Antigravity payload shape (`{ toolCall: { name, args }, workspacePaths }`) and assert both `result.decision` and `result.reason`.
2. **Isolate Filesystem State:** Inject `homeDir` and use temporary directories (`fs.mkdtempSync`) cleaned up in `afterEach`.
3. **Every Fix Needs a Regression Test:** Every bypass or edge case fixed must have a dedicated test case in `test/claude-permissions.test.ts`.
4. **Pair Positive Tests with Negative Tests:** Always verify that everyday developer commands (`npm test 2>&1 | tail -20`, `git log --oneline`, `grep -rn foo src`, `jq '{a,b}'`) are not falsely flagged.
5. **Test `setupTargetRepository`:** Verify the generated `.agents/hooks.json` structure, absolute path command, idempotency, and corrupt-file protection.