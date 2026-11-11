/**
 * ============================================================================
 * ANTIGRAVITY CLI -> CLAUDE CODE PERMISSIONS BRIDGE (PreToolUse Hook)
 * ============================================================================
 *
 * @file    claude-permissions.ts
 * @summary Translates Claude Code's (.claude/settings.json) permission model
 *          into Antigravity CLI's PreToolUse hook lifecycle.
 *
 * ----------------------------------------------------------------------------
 * 1. PURPOSE & GOALS
 * ----------------------------------------------------------------------------
 * Enforces tool authorization rules from Claude Code configuration files
 * (~/.claude/settings.json, .claude/settings.json, and .claude/settings.local.json)
 * during Antigravity CLI PreToolUse hook execution:
 *   - "auto_approve" : Maps from Claude "allow". Approves execution directly.
 *   - "force_ask"    : Maps from Claude "ask" and high-risk overrides.
 *   - "deny"         : Maps from Claude "deny". Blocks tool execution.
 *
 * ----------------------------------------------------------------------------
 * 2. CONFIGURATION & CUSTOM ROOT PROPERTIES
 * ----------------------------------------------------------------------------
 * - "agy-cli-permission-hook-default-access" ("allow" | "ask" | "deny", default: "ask")
 * - "agy-cli-permission-hook-arbitrary-command-execution" ("allow" | "ask" | "deny", default: "ask")
 * - "permissions": { "deny": string[], "ask": string[], "allow": string[] }
 *
 * ----------------------------------------------------------------------------
 * 3. LOGGING & AUDIT TRAIL
 * ----------------------------------------------------------------------------
 * Writes timestamped evaluation logs to .agents/hooks/claude-permissions.log.
 * ============================================================================
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type RuleLevel = "allow" | "ask" | "deny";
export type AntigravityDecision = "auto_approve" | "force_ask" | "deny";

export interface HookInput {
  toolCall?: {
    name: string;
    args?: Record<string, any>;
  };
  workspacePaths?: string[];
  // Fallback properties for synthetic test calls
  tool?: string;
  parameters?: Record<string, any>;
  context?: {
    cwd?: string;
    sessionId?: string;
  };
  cwd?: string;
}

export interface HookOutput {
  decision: AntigravityDecision;
  reason?: string;
}

export interface ClaudeSettings {
  permissions?: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  };
  "agy-cli-permission-hook-default-access"?: RuleLevel;
  "agy-cli-permission-hook-arbitrary-command-execution"?: RuleLevel;
  [key: string]: any;
}

// ============================================================================
// Decision Mapping & Validation
// ============================================================================

export function parseRuleLevel(value: unknown, fallback: RuleLevel): RuleLevel {
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }
  return fallback;
}

export function toAntigravityDecision(level: RuleLevel): AntigravityDecision {
  switch (level) {
    case "allow":
      return "auto_approve";
    case "ask":
      return "force_ask";
    case "deny":
      return "deny";
  }
}

// ============================================================================
// Logging Engine
// ============================================================================

const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = path.join(HOOK_DIR, "claude-permissions.log");

function log(msg: string): void {
  try {
    fs.mkdirSync(HOOK_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`, "utf8");
  } catch {
    // Never crash on audit logging failures
  }
}

// ============================================================================
// Shell Lexer, Compound Splitter & Redirection Extractor
// ============================================================================

export interface ShellToken {
  type: "word" | "op" | "redir" | "heredoc" | "newline" | "comment";
  value: string;
}

export function tokenizeShell(script: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let cur = "";
  let i = 0;
  const len = script.length;

  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < len) {
    const c = script[i];

    // Line continuation outside single quotes
    if (
      !inSingleQuote &&
      c === "\\" &&
      i + 1 < len &&
      (script[i + 1] === "\n" || script[i + 1] === "\r")
    ) {
      i +=
        script[i + 1] === "\r" && i + 2 < len && script[i + 2] === "\n" ? 3 : 2;
      continue;
    }

    // 1. Single quotes: strictly literal
    if (inSingleQuote) {
      cur += c;
      if (c === "'") inSingleQuote = false;
      i++;
      continue;
    }

    // 2. Double quotes: handle backslash escapes
    if (inDoubleQuote) {
      cur += c;
      if (c === "\\" && i + 1 < len) {
        cur += script[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inDoubleQuote = false;
      i++;
      continue;
    }

    // 3. Backslash escape outside quotes
    if (c === "\\") {
      if (i + 1 < len) {
        cur += c + script[i + 1];
        i += 2;
      } else {
        cur += c;
        i++;
      }
      continue;
    }

    // 4. Quote starts
    if (c === "'") {
      inSingleQuote = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDoubleQuote = true;
      cur += c;
      i++;
      continue;
    }

    // 5. Comments
    if (c === "#" && (cur.length === 0 || /\s/.test(script[i - 1]))) {
      if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }
      let commentText = "";
      while (i < len && script[i] !== "\n" && script[i] !== "\r") {
        commentText += script[i];
        i++;
      }
      tokens.push({ type: "comment", value: commentText });
      continue;
    }

    // 6. Newlines
    if (c === "\n" || c === "\r") {
      if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }
      if (c === "\r" && i + 1 < len && script[i + 1] === "\n") i++;
      tokens.push({ type: "newline", value: "\n" });
      i++;
      continue;
    }

    // 7. Heredoc operator: << or <<- (but not <<< here-string)
    if (
      c === "<" &&
      i + 1 < len &&
      script[i + 1] === "<" &&
      (i + 2 >= len || script[i + 2] !== "<")
    ) {
      if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }
      const isDash = i + 2 < len && script[i + 2] === "-";
      tokens.push({ type: "heredoc", value: isDash ? "<<-" : "<<" });
      i += isDash ? 3 : 2;
      continue;
    }

    // 8. Output redirection operators: >>, >|, >&, &>>, &>, > (and fd-prefixed 1>, 2>, 1>>, 2>>)
    if (c === ">") {
      // If current token is strictly digits (e.g. "1" or "2"), attach fd to redirection
      let fdPrefix = "";
      if (/^\d+$/.test(cur)) {
        fdPrefix = cur;
        cur = "";
      } else if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }

      const next = i + 1 < len ? script[i + 1] : "";
      if (next === ">" || next === "|" || next === "&") {
        tokens.push({ type: "redir", value: fdPrefix + c + next });
        i += 2;
      } else {
        tokens.push({ type: "redir", value: fdPrefix + c });
        i += 1;
      }
      continue;
    }

    // 9. Operators: &&, ||, |&, &>, &>>, |, ;, &
    if (c === "&" || c === "|" || c === ";") {
      const next = i + 1 < len ? script[i + 1] : "";
      const next2 = i + 2 < len ? script[i + 2] : "";

      if (c === "&" && next === ">") {
        if (cur.trim()) {
          tokens.push({ type: "word", value: cur });
          cur = "";
        }
        if (next2 === ">") {
          tokens.push({ type: "redir", value: "&>>" });
          i += 3;
        } else {
          tokens.push({ type: "redir", value: "&>" });
          i += 2;
        }
        continue;
      }

      if (
        (c === "&" && next === "&") ||
        (c === "|" && next === "|") ||
        (c === "|" && next === "&")
      ) {
        if (cur.trim()) {
          tokens.push({ type: "word", value: cur });
          cur = "";
        }
        tokens.push({ type: "op", value: c + next });
        i += 2;
        continue;
      }

      if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }

    // 10. Whitespace
    if (/\s/.test(c)) {
      if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }
      i++;
      continue;
    }

    cur += c;
    i++;
  }

  if (cur.trim()) {
    tokens.push({ type: "word", value: cur });
  }

  return tokens;
}

export function dequoteWord(word: string): string {
  let result = "";
  let inS = false;
  let inD = false;

  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (inS) {
      if (c === "'") inS = false;
      else result += c;
      continue;
    }
    if (inD) {
      if (c === "\\") {
        if (i + 1 < word.length) {
          result += word[i + 1];
          i++;
        }
        continue;
      }
      if (c === '"') inD = false;
      else result += c;
      continue;
    }
    if (c === "'") {
      inS = true;
      continue;
    }
    if (c === '"') {
      inD = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < word.length) {
        result += word[i + 1];
        i++;
      }
      continue;
    }
    result += c;
  }
  return result;
}

function isBalanced(str: string, openChar: string, closeChar: string): boolean {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

export function unwrapGrouping(cmd: string): string {
  let trimmed = cmd.trim();
  let changed = true;

  while (changed) {
    changed = false;
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      const inner = trimmed.slice(1, -1).trim();
      if (isBalanced(inner, "(", ")")) {
        trimmed = inner;
        changed = true;
        continue;
      }
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const inner = trimmed.slice(1, -1).trim();
      if (isBalanced(inner, "{", "}")) {
        trimmed = inner.endsWith(";") ? inner.slice(0, -1).trim() : inner;
        changed = true;
        continue;
      }
    }
  }
  return trimmed;
}

export function splitCompoundCommands(commandLine: string): string[] {
  const tokens = tokenizeShell(commandLine);
  const commands: string[] = [];
  let currentTokens: string[] = [];

  for (const token of tokens) {
    if (token.type === "comment") continue;

    if (token.type === "op" || token.type === "newline") {
      if (currentTokens.length > 0) {
        commands.push(unwrapGrouping(currentTokens.join(" ")));
        currentTokens = [];
      }
    } else {
      currentTokens.push(token.value);
    }
  }

  if (currentTokens.length > 0) {
    commands.push(unwrapGrouping(currentTokens.join(" ")));
  }

  return commands.filter((c) => c.length > 0);
}

/**
 * Extracts file targets written to by output redirections (>, >>, >|, &>, tee).
 */
export function extractShellWriteTargets(commandLine: string): string[] {
  const tokens = tokenizeShell(commandLine);
  const targets: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "redir") {
      const next = tokens[i + 1];
      if (next && next.type === "word") {
        const target = dequoteWord(next.value);
        // Ignore fd targets (&1, &2) and null/stdio devices
        if (
          !target.startsWith("&") &&
          !["/dev/null", "/dev/stdout", "/dev/stderr"].includes(target)
        ) {
          targets.push(target);
        }
      }
    }
  }

  // Also detect `tee` file arguments in each subcommand
  const subCommands = splitCompoundCommands(commandLine);
  for (const sub of subCommands) {
    const { dequoted } = stripWrappersForDenyAsk(sub);
    const words = dequoted.split(/\s+/);
    const bin = getBinaryBasename(words[0] || "");
    if (bin === "tee") {
      for (let i = 1; i < words.length; i++) {
        if (!words[i].startsWith("-") && words[i].length > 0) {
          targets.push(words[i]);
        }
      }
    }
  }

  return Array.from(new Set(targets));
}

function getBinaryBasename(word: string): string {
  const clean = dequoteWord(word);
  return path.win32.basename(clean).toLowerCase();
}

/**
 * Strips environment assignments, execution wrappers, quotes, and leading binary paths.
 * Used ONLY for Deny and Ask matching (NEVER for Allow matching).
 */
export function stripWrappersForDenyAsk(cmd: string): {
  stripped: string;
  dequoted: string;
  baseNormalized: string;
} {
  let working = unwrapGrouping(cmd.trim());
  let advanced = true;

  while (advanced) {
    advanced = false;

    // 1. Strip leading KEY=VAL environment assignments
    const envMatch = working.match(
      /^[a-zA-Z_][a-zA-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+(.*)$/,
    );
    if (envMatch) {
      working = envMatch[1].trim();
      advanced = true;
      continue;
    }

    const words = working.split(/\s+/);
    if (words.length <= 1) break;

    const firstBase = getBinaryBasename(words[0]);

    // 2. Simple prefix wrappers
    const simpleWrappers = [
      "command",
      "builtin",
      "nohup",
      "ionice",
      "time",
      "doas",
      "setsid",
    ];
    if (simpleWrappers.includes(firstBase)) {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) idx++;
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 3. sudo / env / nice / stdbuf / timeout / watch / chroot / script
    if (firstBase === "sudo") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (
          ["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t"].includes(words[idx])
        )
          idx += 2;
        else idx += 1;
      }
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    if (firstBase === "env") {
      let idx = 1;
      while (idx < words.length) {
        const w = words[idx];
        if (w.startsWith("-")) {
          if (
            ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(
              w,
            )
          )
            idx += 2;
          else idx += 1;
        } else if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(w)) {
          idx += 1;
        } else {
          break;
        }
      }
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    if (firstBase === "timeout") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-s", "--signal", "-k", "--kill-after"].includes(words[idx]))
          idx += 2;
        else idx += 1;
      }
      // Skip duration argument
      if (idx < words.length) idx += 1;
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    if (firstBase === "nice" || firstBase === "watch") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-n", "--adjustment", "--interval"].includes(words[idx])) idx += 2;
        else idx += 1;
      }
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    if (firstBase === "chroot") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) idx += 1;
      // Skip NEWROOT argument
      if (idx < words.length) idx += 1;
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    if (firstBase === "script") {
      const cIdx = words.findIndex(
        (w, i) =>
          i > 0 && (dequoteWord(w) === "-c" || dequoteWord(w) === "--command"),
      );
      if (cIdx >= 0 && cIdx + 1 < words.length) {
        working = dequoteWord(words[cIdx + 1]).trim();
        advanced = true;
        continue;
      }
    }
  }

  const dequotedWords = working.split(/\s+/).map(dequoteWord);
  const dequoted = dequotedWords.join(" ");

  // Also create a version where the binary path is reduced to its basename (e.g. /bin/rm -> rm)
  const baseWords = [...dequotedWords];
  if (
    baseWords.length > 0 &&
    (baseWords[0].includes("/") || baseWords[0].includes("\\"))
  ) {
    baseWords[0] = path.win32.basename(baseWords[0]);
  }
  const baseNormalized = baseWords.join(" ");

  return { stripped: working, dequoted, baseNormalized };
}

// ============================================================================
// Arbitrary Command Execution Inspector
// ============================================================================

export interface ArbitraryCheckResult {
  detected: boolean;
  reason?: string;
}

const DANGEROUS_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "BASH_ENV",
  "ENV",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "PAGER",
  "GIT_PAGER",
  "EDITOR",
  "VISUAL",
]);

/**
 * Inspects a single subcommand (after wrapper/path normalization) for
 * interpreters, subcommand flags, and dynamic execution mechanics.
 */
function checkSubcommandArbitraryExecution(
  subCmd: string,
): ArbitraryCheckResult {
  const { dequoted } = stripWrappersForDenyAsk(subCmd);
  const words = dequoted.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { detected: false };

  // Check if raw subcommand sets dangerous execution environment variables
  const rawWords = subCmd.trim().split(/\s+/);
  for (const rw of rawWords) {
    const envMatch = rw.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=/);
    if (!envMatch) break;
    if (DANGEROUS_ENV_VARS.has(envMatch[1].toUpperCase())) {
      return {
        detected: true,
        reason: `Dangerous execution environment variable '${envMatch[1]}' detected`,
      };
    }
  }

  const baseCmd = getBinaryBasename(words[0]);
  const args = words.slice(1);

  // 1. Dynamic command name ($CMD, ${RUN}, `cmd`, $(cmd))
  if (
    words[0].startsWith("$") ||
    words[0].includes("`") ||
    words[0].includes("$(")
  ) {
    return {
      detected: true,
      reason: `Dynamic command name '${words[0]}' detected`,
    };
  }

  // 2. Shell built-in evaluators & xargs
  if (["eval", "exec", "source", ".", "xargs"].includes(baseCmd)) {
    return {
      detected: true,
      reason: `Arbitrary execution runner '${baseCmd}' detected`,
    };
  }

  // 3. BusyBox applet wrapper (e.g., busybox sh, busybox awk)
  if (baseCmd === "busybox" && args.length > 0) {
    const applet = getBinaryBasename(args[0]);
    if (["sh", "ash", "bash", "awk", "sed", "find", "xargs"].includes(applet)) {
      return checkSubcommandArbitraryExecution(args.join(" "));
    }
  }

  // 4. POSIX / Unix shells (bash, sh, zsh, dash, ksh, ash, fish) with -c / -lc / -ec / --command
  if (["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"].includes(baseCmd)) {
    for (const arg of args) {
      if (
        arg === "--command" ||
        arg.startsWith("--command=") ||
        /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)
      ) {
        return {
          detected: true,
          reason: `Shell inline execution flag '${arg}' detected for '${baseCmd}'`,
        };
      }
    }
  }

  // 5. Python (python, python2, python3, python3.12, python.exe) with -c
  if (/^python(\d+(\.\d+)*)?(\.exe)?$/i.test(baseCmd)) {
    for (const arg of args) {
      if (
        arg === "-c" ||
        arg.startsWith("-c") ||
        arg === "--command" ||
        /^-[a-zA-Z]*c/.test(arg)
      ) {
        return {
          detected: true,
          reason: `Python inline code execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 6. Node / Deno / Bun with -e / --eval / -p / --print
  if (["node", "node.exe", "nodejs", "deno", "bun"].includes(baseCmd)) {
    for (const arg of args) {
      if (
        ["-e", "--eval", "-p", "--print"].includes(arg) ||
        arg.startsWith("--eval=") ||
        arg.startsWith("--print=") ||
        /^-[a-zA-Z]*[ep][a-zA-Z]*$/.test(arg)
      ) {
        return {
          detected: true,
          reason: `JS runtime inline execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 7. Perl / Ruby / Lua with -e / -E
  if (/^(perl\d*|ruby|irb|lua|luajit)(\.exe)?$/i.test(baseCmd)) {
    for (const arg of args) {
      if (["-e", "-E"].includes(arg) || /^-[a-zA-Z]*[eE]/.test(arg)) {
        return {
          detected: true,
          reason: `Interpreter inline execution flag '${arg}' detected for '${baseCmd}'`,
        };
      }
    }
  }

  // 8. PHP with -r
  if (/^php(\d+(\.\d+)*)?(\.exe)?$/i.test(baseCmd)) {
    for (const arg of args) {
      if (arg === "-r" || /^-[a-zA-Z]*r/.test(arg)) {
        return {
          detected: true,
          reason: `PHP inline code execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 9. PowerShell / pwsh with -c / -Command / -EncodedCommand / -enc
  if (["pwsh", "pwsh.exe", "powershell", "powershell.exe"].includes(baseCmd)) {
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (
        lower === "-c" ||
        lower === "-e" ||
        ("-command".startsWith(lower) && lower.length >= 2) ||
        ("-encodedcommand".startsWith(lower) && lower.length >= 4)
      ) {
        return {
          detected: true,
          reason: `PowerShell inline execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 10. cmd / cmd.exe with /c or /k
  if (["cmd", "cmd.exe"].includes(baseCmd)) {
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (
        lower === "/c" ||
        lower === "/k" ||
        lower.startsWith("/c") ||
        lower.startsWith("/k")
      ) {
        return {
          detected: true,
          reason: `Windows Command Prompt execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 11. Git arbitrary execution flags (-c, -c<val>, --config-env, --exec-path, --upload-pack, --receive-pack)
  if (baseCmd === "git" || baseCmd === "git.exe") {
    for (const arg of args) {
      if (
        arg === "-c" ||
        (arg.startsWith("-c") && arg.length > 2) ||
        arg === "--config-env" ||
        arg.startsWith("--config-env=") ||
        arg === "--exec-path" ||
        arg.startsWith("--exec-path=") ||
        arg === "--upload-pack" ||
        arg.startsWith("--upload-pack=") ||
        arg === "--receive-pack" ||
        arg.startsWith("--receive-pack=")
      ) {
        return {
          detected: true,
          reason: `Git arbitrary execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 12. Tar subcommand / compression program execution
  if (baseCmd === "tar" || baseCmd === "tar.exe") {
    for (const arg of args) {
      if (
        arg === "--to-command" ||
        arg.startsWith("--to-command=") ||
        arg.startsWith("--checkpoint-action=") ||
        arg === "-I" ||
        (arg.startsWith("-I") && arg.length > 2) ||
        arg === "--use-compress-program" ||
        arg.startsWith("--use-compress-program=")
      ) {
        return {
          detected: true,
          reason: `Tar subcommand execution flag '${arg}' detected`,
        };
      }
    }
  }

  // 13. Find -exec / -execdir / -ok / -okdir
  if (baseCmd === "find" || baseCmd === "find.exe") {
    if (args.some((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a))) {
      return {
        detected: true,
        reason: "Find subcommand execution flag (-exec/-ok) detected",
      };
    }
  }

  // 14. AWK system() or command piping
  if (["awk", "gawk", "mawk", "nawk"].includes(baseCmd)) {
    const joinedArgs = args.join(" ");
    if (/\bsystem\s*\(/.test(joinedArgs) || /\|\s*getline\b/.test(joinedArgs)) {
      return {
        detected: true,
        reason: `AWK arbitrary command execution detected in '${baseCmd}'`,
      };
    }
  }

  // 15. GNU sed 'e' command / substitution flag
  if (["sed", "gsed"].includes(baseCmd)) {
    for (const arg of args) {
      if (
        !arg.startsWith("-") &&
        (/s(.)[^\1]*\1[^\1]*\1[gip]*e/.test(arg) || /(^|;)\s*e(\s|$)/.test(arg))
      ) {
        return {
          detected: true,
          reason: "GNU sed command execution flag 'e' detected",
        };
      }
    }
  }

  return { detected: false };
}

/**
 * Checks both full-line shell syntax (substitutions, arithmetic, brace expansion,
 * heredocs, socket redirects) AND every individual subcommand in the chain.
 */
export function checkArbitraryExecution(cmd: string): ArbitraryCheckResult {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;
  const len = cmd.length;

  while (i < len) {
    const c = cmd[i];

    if (inSingleQuote) {
      if (c === "'") inSingleQuote = false;
      i++;
      continue;
    }

    if (c === "\\") {
      i += 2;
      continue;
    }

    // ANSI-C quoting ($'...')
    if (c === "$" && i + 1 < len && cmd[i + 1] === "'") {
      return {
        detected: true,
        reason: "ANSI-C style quoting ($'...') detected",
      };
    }

    if (c === "'") {
      inSingleQuote = true;
      i++;
      continue;
    }

    if (c === '"') {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    // Command substitution $(...) & arithmetic $((...))
    if (c === "$" && i + 1 < len && cmd[i + 1] === "(") {
      if (i + 2 < len && cmd[i + 2] === "(") {
        return {
          detected: true,
          reason: "Arithmetic evaluation context $((...)) detected",
        };
      }
      return { detected: true, reason: "Command substitution $(...) detected" };
    }

    // Legacy arithmetic $[...]
    if (c === "$" && i + 1 < len && cmd[i + 1] === "[") {
      return {
        detected: true,
        reason: "Arithmetic evaluation context $[...] detected",
      };
    }

    // Backticks `...`
    if (c === "`") {
      return {
        detected: true,
        reason: "Backtick command substitution detected",
      };
    }

    if (!inDoubleQuote) {
      // Heredoc << or <<- (not <<<)
      if (
        c === "<" &&
        i + 1 < len &&
        cmd[i + 1] === "<" &&
        (i + 2 >= len || cmd[i + 2] !== "<")
      ) {
        return {
          detected: true,
          reason: "Heredoc (<<) input redirection detected",
        };
      }

      // Process substitution <(...) or >(...)
      if ((c === "<" || c === ">") && i + 1 < len && cmd[i + 1] === "(") {
        return {
          detected: true,
          reason: "Process substitution <(...) or >(...) detected",
        };
      }

      // Brace expansion {a,b} or {1..10}
      if (c === "{") {
        const closeIdx = cmd.indexOf("}", i);
        if (closeIdx > i) {
          const inner = cmd.slice(i + 1, closeIdx);
          if (inner.includes(",") || inner.includes("..")) {
            return {
              detected: true,
              reason: `Shell brace expansion {${inner}} detected`,
            };
          }
        }
      }

      // Network socket redirection /dev/tcp or /dev/udp
      if (c === "/" && /^\/dev\/(tcp|udp)\//i.test(cmd.slice(i))) {
        return {
          detected: true,
          reason:
            "Network socket redirection via /dev/tcp or /dev/udp detected",
        };
      }

      // Complex fd redirection >& or <&
      if ((c === ">" || c === "<") && i + 1 < len && cmd[i + 1] === "&") {
        return {
          detected: true,
          reason: "File descriptor redirection (>& or <&) detected",
        };
      }
    }

    i++;
  }

  // Check every individual subcommand in the chain
  const subCommands = splitCompoundCommands(cmd);
  for (const subCmd of subCommands) {
    const subCheck = checkSubcommandArbitraryExecution(subCmd);
    if (subCheck.detected) {
      return subCheck;
    }
  }

  return { detected: false };
}

// ============================================================================
// Universal Path Normalization, Symlink Resolution & Glob Matching
// ============================================================================

export function normalizeUniversalPath(rawPath: string): string {
  let p = rawPath.replace(/\\/g, "/");

  // Preserve UNC host prefix (e.g. //wsl.localhost/...) while collapsing duplicate slashes
  const isUncHost = /^\/\/[^/]+\//.test(p) && !/^\/\/([a-zA-Z]|mnt)\//.test(p);
  p = p.replace(/\/+/g, "/");
  if (isUncHost && !p.startsWith("//")) {
    p = "/" + p;
  }

  // Canonicalize WSL mounts: /mnt/c/... or //mnt/c/... -> /c/...
  p = p.replace(
    /^\/?mnt\/([a-zA-Z])(\/|$)/,
    (_, d, sep) => `/${d.toLowerCase()}${sep}`,
  );

  // Canonicalize MSYS / Git-Bash style: //c/... -> /c/...
  p = p.replace(
    /^\/\/([a-zA-Z])(\/|$)/,
    (_, d, sep) => `/${d.toLowerCase()}${sep}`,
  );

  // Canonicalize Windows drive letter: C:/... -> /c/...
  const winMatch = p.match(/^([a-zA-Z]):(\/(.*)|)$/);
  if (winMatch) {
    p = `/${winMatch[1].toLowerCase()}${winMatch[2] || "/"}`;
  }

  // Lowercase single-letter drive prefix at root: /C/... -> /c/...
  const rootDriveMatch = p.match(/^\/([a-zA-Z])(\/(.*)|)$/);
  if (rootDriveMatch) {
    p = `/${rootDriveMatch[1].toLowerCase()}${rootDriveMatch[2] || "/"}`;
  }

  const normalized = path.posix.normalize(p);
  return isUncHost && !normalized.startsWith("//")
    ? "/" + normalized
    : normalized;
}

/**
 * Resolves symlinks on existing files, or walks up existing parent directories
 * when creating a new file inside a symlinked directory.
 */
function resolveRealPathWithAncestors(absPath: string): string {
  try {
    return fs.realpathSync(absPath);
  } catch {
    const parent = path.dirname(absPath);
    if (parent === absPath) return absPath;
    return path.join(
      resolveRealPathWithAncestors(parent),
      path.basename(absPath),
    );
  }
}

export function resolveCandidatePaths(
  targetPath: string,
  cwd: string,
  homeDir = os.homedir(),
): string[] {
  let expanded = targetPath.trim();

  if (
    expanded === "~" ||
    expanded.startsWith("~/") ||
    expanded.startsWith("~\\")
  ) {
    expanded = path.join(homeDir, expanded.slice(1));
  } else if (
    !path.isAbsolute(expanded) &&
    !/^[a-zA-Z]:[/\\]/.test(expanded) &&
    !expanded.startsWith("//")
  ) {
    expanded = path.resolve(cwd, expanded);
  }

  const lexicalNorm = normalizeUniversalPath(expanded);
  const realFsPath = resolveRealPathWithAncestors(expanded);
  const realNorm = normalizeUniversalPath(realFsPath);

  return lexicalNorm === realNorm ? [lexicalNorm] : [lexicalNorm, realNorm];
}

function isCaseInsensitivePath(normalizedPath: string): boolean {
  return (
    process.platform === "win32" ||
    /^\/[a-z]\//.test(normalizedPath) ||
    normalizedPath.startsWith("//wsl.localhost/")
  );
}

export function globToRegExp(pattern: string, caseInsensitive = false): RegExp {
  const normalized = normalizeUniversalPath(pattern);
  let regexStr = "";
  let i = 0;
  const len = normalized.length;

  while (i < len) {
    const c = normalized[i];

    if (c === "*" && i + 1 < len && normalized[i + 1] === "*") {
      if (i + 2 < len && normalized[i + 2] === "/") {
        regexStr += "(?:.*\\/)?";
        i += 3;
        continue;
      }
      if (i + 2 === len && normalized[i - 1] === "/") {
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += ".*";
      i += 2;
      continue;
    }

    if (c === "*") {
      regexStr += "[^/]*";
      i++;
      continue;
    }

    if (c === "?") {
      regexStr += "[^/]";
      i++;
      continue;
    }

    if (/[-[\]{}()+.,^$|#\s\\]/.test(c)) {
      regexStr += "\\" + c;
    } else {
      regexStr += c;
    }

    i++;
  }

  return new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
}

function testNormalizedPattern(
  normalizedTarget: string,
  normalizedPattern: string,
): boolean {
  const ci =
    isCaseInsensitivePath(normalizedTarget) ||
    isCaseInsensitivePath(normalizedPattern);
  if (globToRegExp(normalizedPattern, ci).test(normalizedTarget)) {
    return true;
  }
  if (normalizedPattern.endsWith("/**")) {
    const rootDir = normalizedPattern.slice(0, -3);
    if (ci) {
      if (normalizedTarget.toLowerCase() === rootDir.toLowerCase()) return true;
    } else {
      if (normalizedTarget === rootDir) return true;
    }
  }
  return false;
}

/**
 * Matches a target file path against a Claude Code path rule pattern:
 * - `~/...`   : relative to home directory
 * - `//...`   : filesystem-absolute path
 * - `/...`    : relative to settings/workspace root (also checks POSIX system roots)
 * - `./...`   : anchored to settings/workspace root
 * - `foo`     : no slash -> gitignore-style match at any directory depth inside workspace
 * - `a/b`     : contains slash -> anchored to settings/workspace root
 */
export function matchesPathPattern(
  targetPath: string,
  rulePattern: string,
  cwd: string,
  homeDir = os.homedir(),
): boolean {
  const pat = rulePattern.trim();
  const candidates = resolveCandidatePaths(targetPath, cwd, homeDir);
  const cwdNorm = normalizeUniversalPath(cwd);

  return candidates.some((normalizedTarget) => {
    // 1. Home directory: ~/.ssh/**
    if (pat === "~" || pat.startsWith("~/") || pat.startsWith("~\\")) {
      const absPattern = normalizeUniversalPath(
        path.join(homeDir, pat.slice(1)),
      );
      return testNormalizedPattern(normalizedTarget, absPattern);
    }

    // 2. Double slash //path -> filesystem-absolute (Claude Code spec)
    if (pat.startsWith("//")) {
      const isUnc = /^\/\/wsl\.localhost\//i.test(pat);
      const rawAbs = isUnc ? pat : pat.slice(1);
      const absPattern = normalizeUniversalPath(rawAbs);
      return testNormalizedPattern(normalizedTarget, absPattern);
    }

    // 3. Explicit Windows drive letter C:/...
    if (/^[a-zA-Z]:[/\\]/.test(pat)) {
      const absPattern = normalizeUniversalPath(pat);
      return testNormalizedPattern(normalizedTarget, absPattern);
    }

    // 4. Single leading slash /path -> settings/workspace-relative per Claude Code spec
    if (pat.startsWith("/")) {
      const relPart = pat.slice(1);
      const wsPattern = normalizeUniversalPath(`${cwdNorm}/${relPart}`);
      if (testNormalizedPattern(normalizedTarget, wsPattern)) return true;

      // Compatibility fallback for POSIX root paths written with single '/'
      if (/^\/(mnt|home|Users|etc|var|tmp|opt|usr|[a-zA-Z])\//.test(pat)) {
        const sysPattern = normalizeUniversalPath(pat);
        if (testNormalizedPattern(normalizedTarget, sysPattern)) return true;
      }
      return false;
    }

    // 5. Explicit ./ prefix -> anchored to workspace root
    if (pat.startsWith("./")) {
      const relPart = pat.slice(2);
      const wsPattern = normalizeUniversalPath(`${cwdNorm}/${relPart}`);
      return testNormalizedPattern(normalizedTarget, wsPattern);
    }

    // 6. Pattern starting with **/
    if (pat.startsWith("**/")) {
      const wsRecursive = normalizeUniversalPath(`${cwdNorm}/${pat}`);
      return (
        testNormalizedPattern(normalizedTarget, wsRecursive) ||
        testNormalizedPattern(normalizedTarget, pat)
      );
    }

    // 7. Gitignore semantics: no slash -> match at ANY depth inside workspace
    if (!pat.includes("/")) {
      const anyDepthPattern = normalizeUniversalPath(`${cwdNorm}/**/${pat}`);
      return testNormalizedPattern(normalizedTarget, anyDepthPattern);
    }

    // 8. Relative path containing slash -> anchored to workspace root
    const anchoredPattern = normalizeUniversalPath(`${cwdNorm}/${pat}`);
    return testNormalizedPattern(normalizedTarget, anchoredPattern);
  });
}

// ============================================================================
// Self-Protection of Permissions & Hook Governance Files
// ============================================================================

function isSelfProtectedGovernanceFile(
  targetPath: string,
  cwd: string,
  homeDir = os.homedir(),
): boolean {
  const protectedPatterns = [
    "./.claude/settings.json",
    "./.claude/settings.local.json",
    "~/.claude/settings.json",
    "~/.claude/settings.local.json",
    "./.agents/hooks.json",
    "./.agents/hooks/**",
  ];

  return protectedPatterns.some((pat) =>
    matchesPathPattern(targetPath, pat, cwd, homeDir),
  );
}

// ============================================================================
// Bash & WebFetch Rule Matchers
// ============================================================================

export function matchesBashRule(command: string, rule: string): boolean {
  if (rule === "Bash") return true;

  const match = rule.match(/^Bash\((.*)\)$/);
  if (!match) return false;

  const inner = match[1].trim();

  // Delimited prefix: Bash(cmd:*)
  if (inner.endsWith(":*")) {
    const prefix = inner.slice(0, -2);
    return (
      command === prefix ||
      command.startsWith(prefix + " ") ||
      command.startsWith(prefix + "\t") ||
      command.startsWith(prefix + "/")
    );
  }

  // Standard glob: Bash(cmd*)
  if (inner.includes("*")) {
    const escaped = inner
      .replace(/[-[\]{}()+?.,^$|#\s]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(command);
  }

  // Exact match
  return command === inner;
}

export function matchesWebFetchRule(urlStr: string, rule: string): boolean {
  if (rule === "WebFetch") return true;

  const match = rule.match(/^WebFetch\((.*)\)$/);
  if (!match) return false;

  const inner = match[1].trim();
  let hostname = "";
  try {
    hostname = new URL(urlStr).hostname.toLowerCase();
  } catch {
    hostname = urlStr.toLowerCase();
  }

  if (inner.endsWith(":*")) {
    const domainPrefix = inner.slice(0, -2).toLowerCase();
    return hostname === domainPrefix || hostname.endsWith("." + domainPrefix);
  }

  if (inner.includes("*")) {
    const escaped = inner
      .replace(/[-[\]{}()+?.,^$|#\s]/g, "\\$&")
      .replace(/\*/g, ".*");
    return (
      new RegExp(`^${escaped}$`, "i").test(hostname) ||
      new RegExp(`^${escaped}$`, "i").test(urlStr)
    );
  }

  return (
    hostname === inner.toLowerCase() ||
    urlStr.toLowerCase().startsWith(inner.toLowerCase())
  );
}

// ============================================================================
// Settings Loader (Merges Global User + Project + Local Settings)
// ============================================================================

export function loadMergedClaudeSettings(
  cwd: string,
  homeDir = os.homedir(),
): ClaudeSettings {
  const candidateFiles = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(homeDir, ".claude", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];

  const merged: ClaudeSettings = {
    permissions: { deny: [], ask: [], allow: [] },
  };

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed: ClaudeSettings = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      );
      if (parsed.permissions) {
        if (Array.isArray(parsed.permissions.deny)) {
          merged.permissions!.deny!.push(...parsed.permissions.deny);
        }
        if (Array.isArray(parsed.permissions.ask)) {
          merged.permissions!.ask!.push(...parsed.permissions.ask);
        }
        if (Array.isArray(parsed.permissions.allow)) {
          merged.permissions!.allow!.push(...parsed.permissions.allow);
        }
      }
      if (parsed["agy-cli-permission-hook-default-access"] !== undefined) {
        merged["agy-cli-permission-hook-default-access"] =
          parsed["agy-cli-permission-hook-default-access"];
      }
      if (
        parsed["agy-cli-permission-hook-arbitrary-command-execution"] !==
        undefined
      ) {
        merged["agy-cli-permission-hook-arbitrary-command-execution"] =
          parsed["agy-cli-permission-hook-arbitrary-command-execution"];
      }
    } catch (err) {
      log(`Error parsing settings file ${filePath}: ${err}`);
    }
  }

  return merged;
}

// ============================================================================
// File Path Evaluation Helper (Shared by File Tools & Shell Redirections)
// ============================================================================

function evaluateFilePaths(
  paths: string[],
  mode: "read" | "edit" | "search",
  settings: ClaudeSettings,
  cwd: string,
  homeDir = os.homedir(),
): { level: RuleLevel; reason?: string } {
  const defaultAccess = parseRuleLevel(
    settings["agy-cli-permission-hook-default-access"],
    "ask",
  );
  const denyList = settings.permissions?.deny || [];
  const askList = settings.permissions?.ask || [];
  const allowList = settings.permissions?.allow || [];

  const actionPrefixes =
    mode === "edit"
      ? ["Edit", "Write"]
      : mode === "search"
        ? ["Grep", "Read"]
        : ["Read", "Glob"];
  const results: { target: string; level: RuleLevel; reason?: string }[] = [];

  for (const rawPath of paths) {
    let level: RuleLevel = defaultAccess;
    let reason: string | undefined;

    // 1. Deny checks (highest precedence)
    for (const rule of denyList) {
      for (const act of actionPrefixes) {
        if (rule === act) {
          level = "deny";
          reason = `Claude Permission Hook: ${act} denied by rule '${rule}'`;
          break;
        }
        const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
        if (m && matchesPathPattern(rawPath, m[1], cwd, homeDir)) {
          level = "deny";
          reason = `Claude Permission Hook: Path '${rawPath}' denied by rule '${rule}'`;
          break;
        }
      }
      if (level === "deny") break;
    }

    // 2. Self-protection check: never allow silent edits to settings or hook files
    if (
      level !== "deny" &&
      mode === "edit" &&
      isSelfProtectedGovernanceFile(rawPath, cwd, homeDir)
    ) {
      level = "ask";
      reason = `Claude Permission Hook: Modifying permission/hook governance file '${rawPath}' requires explicit approval`;
      results.push({ target: rawPath, level, reason });
      continue;
    }

    // 3. Ask checks
    if (level !== "deny") {
      for (const rule of askList) {
        for (const act of actionPrefixes) {
          if (rule === act) {
            level = "ask";
            reason = `Claude Permission Hook: ${act} requires confirmation by rule '${rule}'`;
            break;
          }
          const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
          if (m && matchesPathPattern(rawPath, m[1], cwd, homeDir)) {
            level = "ask";
            reason = `Claude Permission Hook: Path '${rawPath}' requires confirmation by rule '${rule}'`;
            break;
          }
        }
        if (level === "ask") break;
      }
    }

    // 4. Allow checks
    if (level !== "deny" && level !== "ask") {
      for (const rule of allowList) {
        for (const act of actionPrefixes) {
          if (rule === act) {
            level = "allow";
            break;
          }
          const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
          if (m && matchesPathPattern(rawPath, m[1], cwd, homeDir)) {
            level = "allow";
            break;
          }
        }
        if (level === "allow") break;
      }
    }

    if (level !== "allow" && !reason) {
      reason = `Claude Permission Hook: Default access (${level}) applied for path '${rawPath}'`;
    }

    results.push({ target: rawPath, level, reason });
  }

  const denied = results.find((r) => r.level === "deny");
  if (denied) return { level: "deny", reason: denied.reason };

  const asked = results.find((r) => r.level === "ask");
  if (asked) return { level: "ask", reason: asked.reason };

  return { level: "allow" };
}

// ============================================================================
// Core Evaluation Engine
// ============================================================================

export function evaluateRequestWithSettings(
  input: HookInput,
  settings: ClaudeSettings,
  homeDir = os.homedir(),
): HookOutput {
  const toolName = input.toolCall?.name || input.tool || "";
  const args = input.toolCall?.args || input.parameters || {};
  const cwd =
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
    input.context?.cwd ||
    input.cwd ||
    process.cwd();

  const defaultAccess = parseRuleLevel(
    settings["agy-cli-permission-hook-default-access"],
    "ask",
  );
  const arbitraryOverride = parseRuleLevel(
    settings["agy-cli-permission-hook-arbitrary-command-execution"],
    "ask",
  );

  const denyList = settings.permissions?.deny || [];
  const askList = settings.permissions?.ask || [];
  const allowList = settings.permissions?.allow || [];

  log(
    `Evaluating tool: "${toolName}" | cwd: "${cwd}" | args: ${JSON.stringify(args)}`,
  );

  // --------------------------------------------------------------------------
  // 1. Shell Command Execution (run_command)
  // --------------------------------------------------------------------------
  const isCommandTool = [
    "run_command",
    "Bash",
    "bash",
    "execute_command",
    "terminal",
  ].includes(toolName);
  if (isCommandTool) {
    const rawCommand = args.CommandLine ?? args.command ?? args.cmd;

    // Never allow empty, missing, or non-string commands
    if (typeof rawCommand !== "string" || !rawCommand.trim()) {
      return {
        decision: "deny",
        reason:
          "Claude Permission Hook: Empty or unreadable command is not allowed",
      };
    }

    // Step A: Arbitrary command execution inspection (full line + every subcommand)
    const arbitraryCheck = checkArbitraryExecution(rawCommand);
    if (arbitraryCheck.detected) {
      return {
        decision: toAntigravityDecision(arbitraryOverride),
        reason: `Claude Permission Hook: Arbitrary command execution detected (${arbitraryCheck.reason})`,
      };
    }

    // Step B: Check shell output redirections (>, >>, tee) against Edit/Write & self-protection rules
    const writeTargets = extractShellWriteTargets(rawCommand);
    if (writeTargets.length > 0) {
      const redirEval = evaluateFilePaths(
        writeTargets,
        "edit",
        settings,
        cwd,
        homeDir,
      );
      if (redirEval.level === "deny" || redirEval.level === "ask") {
        return {
          decision: toAntigravityDecision(redirEval.level),
          reason: redirEval.reason,
        };
      }
    }

    // Step C: Composite line check for Deny & Ask rules (e.g. "Bash(git checkout main && git push)")
    const trimmedFull = rawCommand.trim();
    for (const rule of denyList) {
      if (matchesBashRule(trimmedFull, rule)) {
        return {
          decision: "deny",
          reason: `Claude Permission Hook: Command line denied by rule '${rule}'`,
        };
      }
    }
    for (const rule of askList) {
      if (matchesBashRule(trimmedFull, rule)) {
        return {
          decision: "force_ask",
          reason: `Claude Permission Hook: Command line requires confirmation by rule '${rule}'`,
        };
      }
    }

    // Step D: Evaluate each subcommand individually
    const subCommands = splitCompoundCommands(rawCommand);
    if (subCommands.length === 0) {
      return {
        decision: "deny",
        reason:
          "Claude Permission Hook: Command parsed to zero executable tokens",
      };
    }

    const subResults: { cmd: string; level: RuleLevel; reason?: string }[] = [];

    for (const subCmd of subCommands) {
      // For Deny & Ask: evaluate raw + unwrapped + dequoted + binary-basename-normalized
      const { stripped, dequoted, baseNormalized } =
        stripWrappersForDenyAsk(subCmd);
      const denyAskCandidates = Array.from(
        new Set([subCmd.trim(), stripped, dequoted, baseNormalized]),
      );

      let level: RuleLevel = defaultAccess;
      let reason: string | undefined;

      // 1. Deny check
      for (const rule of denyList) {
        if (denyAskCandidates.some((cand) => matchesBashRule(cand, rule))) {
          level = "deny";
          reason = `Claude Permission Hook: Subcommand '${subCmd}' denied by rule '${rule}'`;
          break;
        }
      }

      // 2. Ask check
      if (level !== "deny") {
        for (const rule of askList) {
          if (denyAskCandidates.some((cand) => matchesBashRule(cand, rule))) {
            level = "ask";
            reason = `Claude Permission Hook: Subcommand '${subCmd}' requires confirmation by rule '${rule}'`;
            break;
          }
        }
      }

      // 3. Allow check: NEVER strip wrappers or env vars for Allow rules!
      if (level !== "deny" && level !== "ask") {
        const allowTarget = subCmd.trim();
        for (const rule of allowList) {
          if (matchesBashRule(allowTarget, rule)) {
            level = "allow";
            break;
          }
        }
      }

      if (level !== "allow" && !reason) {
        reason = `Claude Permission Hook: Default access (${level}) applied for subcommand '${subCmd}'`;
      }

      subResults.push({ cmd: subCmd, level, reason });
    }

    // Precedence aggregation: Deny > Ask > Allow
    const denied = subResults.find((r) => r.level === "deny");
    if (denied) {
      return { decision: "deny", reason: denied.reason };
    }

    const asked = subResults.find((r) => r.level === "ask");
    if (asked) {
      return { decision: "force_ask", reason: asked.reason };
    }

    return { decision: "auto_approve" };
  }

  // --------------------------------------------------------------------------
  // 2. File & Directory Operations
  // --------------------------------------------------------------------------
  const readTools = [
    "view_file",
    "view_file_outline",
    "view_code_item",
    "read_file",
    "Read",
    "list_dir",
    "find_by_name",
    "find_files",
    "directory_list",
    "Glob",
    "glob",
  ];
  const editTools = [
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "edit_file",
    "write_file",
    "create_file",
    "patch_file",
    "replace_in_file",
    "Edit",
    "Write",
  ];
  const searchTools = ["grep_search", "grep", "search_files", "Grep"];

  const isRead = readTools.includes(toolName);
  const isEdit = editTools.includes(toolName);
  const isSearch = searchTools.includes(toolName);

  if (isRead || isEdit || isSearch) {
    const rawPaths: string[] = [];
    const pathKeys = [
      "AbsolutePath",
      "TargetFile",
      "DirectoryPath",
      "SearchDirectory",
      "SearchPath",
      "file_path",
      "path",
      "directory",
      "dir_path",
      "target_file",
    ];

    for (const key of pathKeys) {
      if (typeof args[key] === "string" && args[key].trim()) {
        rawPaths.push(args[key]);
      }
    }
    if (Array.isArray(args.paths)) {
      rawPaths.push(
        ...args.paths.filter(
          (p: unknown): p is string =>
            typeof p === "string" && p.trim().length > 0,
        ),
      );
    }

    const mode = isEdit ? "edit" : isSearch ? "search" : "read";

    if (rawPaths.length > 0) {
      const evalRes = evaluateFilePaths(rawPaths, mode, settings, cwd, homeDir);
      return {
        decision: toAntigravityDecision(evalRes.level),
        reason: evalRes.reason,
      };
    }

    // Bare tool check when no specific path parameter is supplied
    const bareEval = evaluateFilePaths([cwd], mode, settings, cwd, homeDir);
    return {
      decision: toAntigravityDecision(bareEval.level),
      reason:
        bareEval.reason ||
        `Claude Permission Hook: Default access applied for '${toolName}'`,
    };
  }

  // --------------------------------------------------------------------------
  // 3. Web & Research Tools (search_web, read_url_content)
  // --------------------------------------------------------------------------
  const isWebSearch = [
    "search_web",
    "web_search",
    "google_search",
    "WebSearch",
  ].includes(toolName);
  const isWebFetch = [
    "read_url_content",
    "web_fetch",
    "fetch_web_page",
    "http_request",
    "WebFetch",
  ].includes(toolName);

  if (isWebSearch) {
    if (denyList.includes("WebSearch")) {
      return {
        decision: "deny",
        reason: "Claude Permission Hook: WebSearch denied by rule",
      };
    }
    if (askList.includes("WebSearch")) {
      return {
        decision: "force_ask",
        reason:
          "Claude Permission Hook: WebSearch requires confirmation by rule",
      };
    }
    if (allowList.includes("WebSearch")) {
      return { decision: "auto_approve" };
    }
    return {
      decision: toAntigravityDecision(defaultAccess),
      reason: `Claude Permission Hook: Default access (${defaultAccess}) applied for WebSearch`,
    };
  }

  if (isWebFetch) {
    const rawUrl = String(args.Url ?? args.url ?? args.target ?? "");

    for (const rule of denyList) {
      if (matchesWebFetchRule(rawUrl, rule)) {
        return {
          decision: "deny",
          reason: `Claude Permission Hook: WebFetch denied by rule '${rule}'`,
        };
      }
    }
    for (const rule of askList) {
      if (matchesWebFetchRule(rawUrl, rule)) {
        return {
          decision: "force_ask",
          reason: `Claude Permission Hook: WebFetch requires confirmation by rule '${rule}'`,
        };
      }
    }
    for (const rule of allowList) {
      if (matchesWebFetchRule(rawUrl, rule)) {
        return { decision: "auto_approve" };
      }
    }
    return {
      decision: toAntigravityDecision(defaultAccess),
      reason: `Claude Permission Hook: Default access (${defaultAccess}) applied for WebFetch`,
    };
  }

  // --------------------------------------------------------------------------
  // 4. Fallback for Unmapped Tools
  // --------------------------------------------------------------------------
  return {
    decision: toAntigravityDecision(defaultAccess),
    reason: `Claude Permission Hook: Fallback default access (${defaultAccess}) for tool '${toolName || "unknown"}'`,
  };
}

// ============================================================================
// CLI Standard Input Entry Point (Fail-Closed on Error)
// ============================================================================

export function main(): void {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
  });

  process.stdin.on("end", () => {
    try {
      if (!buffer.trim()) {
        const emptyOut: HookOutput = {
          decision: "deny",
          reason: "Claude Permission Hook: Empty payload received on stdin",
        };
        log(`Outcome: DENY | Reason: ${emptyOut.reason}`);
        process.stdout.write(JSON.stringify(emptyOut) + "\n");
        return;
      }

      const input: HookInput = JSON.parse(buffer);
      const cwd =
        (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
        input.context?.cwd ||
        input.cwd ||
        process.cwd();

      const settings = loadMergedClaudeSettings(cwd);
      const result = evaluateRequestWithSettings(input, settings);

      log(
        `Outcome: ${result.decision.toUpperCase()} | Reason: ${result.reason || "N/A"}`,
      );
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (err: any) {
      log(`Fatal Hook Error: ${err?.stack || err}`);
      const failClosed: HookOutput = {
        decision: "deny",
        reason: `Claude Permission Hook internal error (fail-closed): ${err?.message || "Unknown error"}`,
      };
      process.stdout.write(JSON.stringify(failClosed) + "\n");
    }
  });
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return (
      pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
    );
  }
})();

if (isMainModule) {
  main();
}
