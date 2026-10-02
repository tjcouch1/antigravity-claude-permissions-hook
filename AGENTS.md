# Agent Guidelines: Antigravity Claude Permissions Hook

This document is for AI agents developing, auditing, or maintaining this repository.

---

## 1. Core Architecture & Philosophy

The project acts as an authoritative security boundary between the **Antigravity CLI** execution lifecycle and the tool invocations an agent requests. It reads `.claude/settings.json` (and `.claude/settings.local.json`) to enforce permissions for shell commands, filesystem operations, and network requests.

### Fundamental Invariants
1. **Zero External Runtime Dependencies:** The production hook script (`src/claude-permissions.ts`) must run using standard Node.js built-ins (`node:fs`, `node:path`, `node:os`). Do not introduce runtime npm dependencies.
2. **Deny > Ask > Allow:** An explicit `deny` must always override an `ask`, and an `ask` must always override an `allow`.
3. **Strictest Rule Across Aggregations:** If a compound command contains three sub-commands where two are `allow` and one is `deny`, the entire pipeline is **denied**. If one requires `ask`, the entire pipeline requires confirmation.
4. **Preserve Compound Rules:** Always evaluate both the composite raw line (to match rules like `Bash(git checkout main && git push)`) and the individual parsed sub-commands.
5. **Fail-Safe Defaults:** If any parsing or runtime error occurs in the hook, fail-closed (`"ask"` or `"deny"`), never silently allow.

---

## 2. Shell Lexer & Security Invariants

Do not use simple regular expressions to evaluate command lines. Shell execution rules must be evaluated through the integrated tokenizer (`tokenizeShell`).

### Shell Tokenizer State Tracking
* **Quote Contexts:** 
  * Single quotes (`'...'`): Strictly literal. Operators like `&&`, `;`, or characters like `$()` inside single quotes are text, not executions.
  * Double quotes (`"..."`): Variable and command substitutions (`$()`, \`\` \` \`\`, `$((...))`) are active; operators (`&&`, `;`) are literal.
* **Command Separators:** Commands are separated by `&&`, `||`, `;`, `&`, `|`, `|&`, and unescaped newlines (`\n`, `\r\n`).
* **Subshell & Grouping Extraction:**
  * Subshells `(cmd)` and POSIX blocks `{ cmd; }` must have their outer groupings unwrapped before checking rule prefixes.
* **Wrapper Peeling:**
  * Commands prefixed with `sudo`, `env`, `command`, `builtin`, `nohup`, or `time` must be evaluated both in their raw form and with the wrappers peeled down to the underlying executable.
* **Token De-quoting:**
  * Commands like `\rm -rf /` or `'rm' -rf /` must be normalized to `rm -rf /` to prevent evasion of `Bash(rm -rf:*)`.

---

## 3. Difference Between `:*` and `*` in Rules

When modifying command-matching logic, keep this distinction intact:
* **`Bash(command:*)` (Delimited Prefix):**
  Matches `command` with zero arguments OR `command` followed immediately by a whitespace delimiter (` `, `\t`, `/`) and arbitrary arguments.
  * `Bash(npm test:*)` matches `npm test` and `npm test --watch`.
  * It does **not** match `npm testing` or `npm testflight`.
* **`Bash(cmd*)` (Wildcard Glob):**
  Matches `cmd` followed by any characters, without requiring a word boundary.
  * `Bash(npm test*)` matches `npm test`, but also matches `npm testing`.
* **`Bash(command)` (Exact Match):**
  Matches `command` byte-for-byte with zero additional arguments.

---

## 4. Path Normalization Guarantees

All file operations (`Read`, `Edit`, `Write`, `Glob`, `Grep`) must normalize incoming paths and rule globs using `normalizeUniversalPath`:
* `C:\Users\...` -> `/c/Users/...`
* `/mnt/c/Users/...` -> `/c/Users/...`
* `//c/Users/...` -> `/c/Users/...`
* `\\wsl.localhost\Ubuntu\...` -> `//wsl.localhost/Ubuntu/...`
* `~` -> User home directory (`os.homedir()`)
* Rules ending in `/**` (e.g. `secrets/**`) must match both files inside the directory and the directory itself (to block directory reads/listings).

---

## 5. Development & Testing Workflow

* **Running Tests:** `npm test` runs the Vitest suite.
* **Adding Test Cases:** Any time a new bypass, escape character, or shell parsing vector is addressed, a corresponding test must be added to `test/claude-permissions.test.ts`.
* **Updating the Installer:** The installer script lives in `scripts/setup.ts`. Always verify it handles both relative and absolute paths across both POSIX and Windows separators.