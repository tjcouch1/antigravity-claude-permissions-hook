# Agent Guidelines: Antigravity Claude Permissions Hook

## 1. Repository File Layout

- `src/claude-permissions.ts` — Production hook engine & CLI entry point (zero external dependencies).
- `scripts/setup.ts` — Installer that copies `src/claude-permissions.ts`, registers it in `.agents/hooks.json`, updates `.gitignore`, and syncs the demarcated documentation block from `README.md`.
- `test/claude-permissions.test.ts` — Vitest TDD test suite.

## 2. Antigravity Hook Contract

- **Input (`stdin`):** `{ toolCall: { name, args }, workspacePaths, ... }`.
  - `run_command` passes `args.CommandLine`. Empty or missing commands MUST return `deny`.
  - File reads pass `args.AbsolutePath` or `args.DirectoryPath`.
  - File edits/writes pass `args.TargetFile`.
  - Web fetch passes `args.Url`.
- **Output (`stdout`):** `{ decision: "auto_approve" | "force_ask" | "deny", reason?: string }`.
  - Never emit `"allow"` or `"ask"` directly—Antigravity uses `"auto_approve"` and `"force_ask"`.
- **Registration (`.agents/hooks.json`):** `{ "type": "command", "command": "node .agents/hooks/claude-permissions.ts", "timeout": 10 }`.

## 3. Security Invariants

1. **Fail-Closed:** Any unexpected parse or runtime error MUST return `decision: "deny"`.
2. **Deny/Ask vs. Allow Asymmetry:** Strip wrappers (`sudo`, `env`, `timeout`, etc.), env vars, quotes, and binary paths ONLY when matching `deny` and `ask` rules. `allow` rules match the raw unstripped subcommand.
3. **Every Subcommand Audited:** Arbitrary-execution checks run on the full line AND on every subcommand in a compound chain.
4. **Self-Protection:** Edits or shell output redirections (`>`, `>>`, `tee`) targeting `.claude/settings*.json`, `~/.claude/settings*.json`, `.agents/hooks.json`, or `.agents/hooks/**` must never be `auto_approve`.
5. **Path Semantics:** `//path` is filesystem-absolute; `/path` and `./path` are workspace-relative; slash-free patterns (`.env`) match at any depth; symlinks are resolved via `fs.realpathSync`.
