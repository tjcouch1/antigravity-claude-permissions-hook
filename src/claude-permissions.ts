/**
 * ============================================================================
 * ANTIGRAVITY CLI -> CLAUDE CODE PERMISSIONS BRIDGE (PreToolUse Hook)
 * ============================================================================
 *
 * @file    claude-permissions.ts
 * @summary Enforces Claude Code's (.claude/settings.json) permission model
 *          inside Antigravity CLI's PreToolUse hook lifecycle.
 *
 * Key Guarantees:
 * - Zero external runtime dependencies (Node.js built-ins only).
 * - Strict precedence: Deny > Ask (force_ask) > Allow (auto_approve).
 * - Deny rules always take priority over arbitrary-execution and redirect checks.
 * - Fails closed (decision: "deny") on empty commands, broken settings JSON,
 *   or unexpected runtime exceptions.
 * - Protects governance files (.claude/settings*.json, .agents/hooks.json,
 *   .agents/hooks/**, ~/.gemini/config/hooks.json) against silent modification
 *   via file tools, shell redirections, or file-writing commands.
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

export interface ScopedRule {
  rule: string;
  baseDir: string;
}

export type RuleEntry = string | ScopedRule;

export interface HookInput {
  toolCall?: {
    name: string;
    args?: Record<string, any>;
  };
  workspacePaths?: string[];
  // Fallback properties for synthetic test inputs
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
    deny?: RuleEntry[];
    ask?: RuleEntry[];
    allow?: RuleEntry[];
  };
  "agy-cli-permission-hook-default-access"?: RuleLevel;
  "agy-cli-permission-hook-arbitrary-command-execution"?: RuleLevel;
  settingsErrors?: string[];
  [key: string]: any;
}

// ============================================================================
// Decision Mapping, Precedence & Validation
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

const LEVEL_RANK: Record<RuleLevel, number> = {
  allow: 1,
  ask: 2,
  deny: 3
};

export function strictestLevel(levels: RuleLevel[]): RuleLevel {
  let max: RuleLevel = "allow";
  for (const lvl of levels) {
    if (LEVEL_RANK[lvl] > LEVEL_RANK[max]) {
      max = lvl;
    }
  }
  return max;
}

function unpackRule(entry: RuleEntry, defaultBaseDir: string): ScopedRule {
  if (typeof entry === "string") {
    return { rule: entry, baseDir: defaultBaseDir };
  }
  return entry;
}

// ============================================================================
// Redacting & Size-Bounded Audit Logger
// ============================================================================

const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = path.join(HOOK_DIR, "claude-permissions.log");
const MAX_LOG_BYTES = 1024 * 1024; // 1 MB
const REDACTED_KEYS = new Set([
  "CodeContent",
  "ReplacementContent",
  "TargetContent",
  "ReplacementChunks",
  "content",
  "new_content",
  "old_content"
]);

export function sanitizeArgsForLog(args: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(args || {})) {
    if (REDACTED_KEYS.has(key)) {
      const len = typeof val === "string" ? val.length : JSON.stringify(val || "").length;
      sanitized[key] = `[REDACTED_CONTENT length=${len}]`;
    } else if (typeof val === "string") {
      // Mask inline secret assignments in command lines or strings
      const masked = val.replace(
        /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi,
        "$1=[REDACTED]"
      );
      sanitized[key] = masked.length > 160 ? masked.slice(0, 160) + "...[truncated]" : masked;
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

function log(msg: string): void {
  try {
    fs.mkdirSync(HOOK_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_BYTES) {
        const tail = fs.readFileSync(LOG_FILE, "utf8").slice(-Math.floor(MAX_LOG_BYTES / 2));
        fs.writeFileSync(LOG_FILE, `[Log rotated at ${new Date().toISOString()}]\n` + tail, "utf8");
      }
    }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`, "utf8");
  } catch {
    // Fail silently on logging issues
  }
}

// ============================================================================
// Shell Lexer & Compound Command Parser
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
    if (!inSingleQuote && c === "\\" && i + 1 < len && (script[i + 1] === "\n" || script[i + 1] === "\r")) {
      i += script[i + 1] === "\r" && i + 2 < len && script[i + 2] === "\n" ? 3 : 2;
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

    // 7. Heredoc operator: << or <<- (not <<< here-string)
    if (c === "<" && i + 1 < len && script[i + 1] === "<" && (i + 2 >= len || script[i + 2] !== "<")) {
      if (cur.trim()) {
        tokens.push({ type: "word", value: cur });
        cur = "";
      }
      const isDash = i + 2 < len && script[i + 2] === "-";
      tokens.push({ type: "heredoc", value: isDash ? "<<-" : "<<" });
      i += isDash ? 3 : 2;
      continue;
    }

    // 8. Safe numeric file-descriptor duplication/closure: e.g. 2>&1, 1>&2, >&2, <&0, 2>&-
    if ((c === ">" || c === "<") && i + 1 < len && script[i + 1] === "&") {
      const restAfterAmp = script.slice(i + 2);
      const fdMatch = restAfterAmp.match(/^([0-9]+|-)(?=\s|$|[;|&><)])/);
      if (fdMatch && (cur === "" || /^\d+$/.test(cur))) {
        const fdToken = `${cur}${c}&${fdMatch[1]}`;
        tokens.push({ type: "word", value: fdToken });
        cur = "";
        i += 2 + fdMatch[1].length;
        continue;
      }
    }

    // 9. Output redirection operators: >>, >|, >&, > (with optional fd prefix 1>, 2>)
    if (c === ">") {
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

    // 10. Operators: &&, ||, |&, &>, &>>, |, ;, &
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

      if ((c === "&" && next === "&") || (c === "|" && next === "|") || (c === "|" && next === "&")) {
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

    // 11. Whitespace
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

  return commands.filter(c => c.length > 0);
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
    const envMatch = working.match(/^[a-zA-Z_][a-zA-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+(.*)$/);
    if (envMatch) {
      working = envMatch[1].trim();
      advanced = true;
      continue;
    }

    // 2. Strip trailing safe fd duplications like 2>&1 for rule comparison
    const trailingFdMatch = working.match(/^(.*?)\s+\d*>[&][0-9-]+$/);
    if (trailingFdMatch && trailingFdMatch[1].trim()) {
      working = trailingFdMatch[1].trim();
      advanced = true;
      continue;
    }

    const words = working.split(/\s+/);
    if (words.length <= 1) break;

    const firstBase = getBinaryBasename(words[0]);

    // 3. Simple prefix wrappers
    const simpleWrappers = ["command", "builtin", "nohup", "time", "doas", "setsid"];
    if (simpleWrappers.includes(firstBase)) {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) idx++;
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 4. ionice (-c class, -n level, -p pid, -P pgid, -t)
    if (firstBase === "ionice") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid"].includes(words[idx])) {
          idx += 2;
        } else {
          idx += 1;
        }
      }
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 5. stdbuf (-i, -o, -e, --input, --output, --error)
    if (firstBase === "stdbuf") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-i", "-o", "-e", "--input", "--output", "--error"].includes(words[idx])) {
          idx += 2;
        } else {
          idx += 1;
        }
      }
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 6. sudo
    if (firstBase === "sudo") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t"].includes(words[idx])) idx += 2;
        else idx += 1;
      }
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 7. su (-c / --command)
    if (firstBase === "su") {
      const cIdx = words.findIndex((w, i) => i > 0 && ["-c", "--command", "--session-command"].includes(dequoteWord(w)));
      if (cIdx >= 0 && cIdx + 1 < words.length) {
        working = dequoteWord(words[cIdx + 1]).trim();
        advanced = true;
        continue;
      }
    }

    // 8. env
    if (firstBase === "env") {
      let idx = 1;
      while (idx < words.length) {
        const w = words[idx];
        if (w.startsWith("-")) {
          if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(w)) idx += 2;
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

    // 9. timeout
    if (firstBase === "timeout") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-s", "--signal", "-k", "--kill-after"].includes(words[idx])) idx += 2;
        else idx += 1;
      }
      if (idx < words.length) idx += 1; // duration
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 10. nice / watch
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

    // 11. chroot
    if (firstBase === "chroot") {
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) idx += 1;
      if (idx < words.length) idx += 1; // NEWROOT
      if (idx < words.length) {
        working = words.slice(idx).join(" ").trim();
        advanced = true;
        continue;
      }
    }

    // 12. script -c
    if (firstBase === "script") {
      const cIdx = words.findIndex((w, i) => i > 0 && ["-c", "--command"].includes(dequoteWord(w)));
      if (cIdx >= 0 && cIdx + 1 < words.length) {
        working = dequoteWord(words[cIdx + 1]).trim();
        advanced = true;
        continue;
      }
    }
  }

  const dequotedWords = working.split(/\s+/).map(dequoteWord);
  const dequoted = dequotedWords.join(" ");

  const baseWords = [...dequotedWords];
  if (baseWords.length > 0 && (baseWords[0].includes("/") || baseWords[0].includes("\\"))) {
    baseWords[0] = path.win32.basename(baseWords[0]);
  }
  const baseNormalized = baseWords.join(" ");

  return { stripped: working, dequoted, baseNormalized };
}

// ============================================================================
// Shell File-Write & Working-Directory Tracker
// ============================================================================

export interface ShellWriteAnalysis {
  targets: string[];
  hasWriteAfterDirChange: boolean;
  ambiguousTargets: string[];
}

/**
 * Extracts file targets from subcommand words for file-modifying CLI utilities:
 * tee, cp, mv, ln, install, dd, sed (-i or w), find (-fprint/-fprintf/-fls),
 * git (--output), curl (-o), wget (-O), rm, unlink, truncate, touch.
 */
function extractUtilityWriteTargets(subCmd: string): string[] {
  const { dequoted } = stripWrappersForDenyAsk(subCmd);
  const tokens = tokenizeShell(dequoted)
    .filter(t => t.type === "word")
    .map(t => dequoteWord(t.value));
  if (tokens.length === 0) return [];

  const bin = getBinaryBasename(tokens[0]);
  const args = tokens.slice(1);
  const out: string[] = [];

  if (bin === "tee") {
    for (const a of args) {
      if (!a.startsWith("-") && a.length > 0) out.push(a);
    }
  } else if (["cp", "mv", "ln", "install"].includes(bin)) {
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-t" || a === "--target-directory") {
        if (i + 1 < args.length) out.push(args[i + 1]);
        i++;
      } else if (a.startsWith("--target-directory=")) {
        out.push(a.slice("--target-directory=".length));
      } else if (["-S", "--suffix", "--backup", "-Z", "--context", "-o", "-g", "-m"].includes(a)) {
        i++;
      } else if (!a.startsWith("-")) {
        pos.push(a);
      }
    }
    if (out.length > 0 && pos.length > 0) {
      const targetDir = out[0];
      for (const src of pos) {
        out.push(`${targetDir.replace(/\/+$/, "")}/${path.posix.basename(src.replace(/\\/g, "/"))}`);
      }
    } else if (pos.length >= 2) {
      const dest = pos[pos.length - 1];
      out.push(dest);
      for (const src of pos.slice(0, -1)) {
        out.push(`${dest.replace(/\/+$/, "")}/${path.posix.basename(src.replace(/\\/g, "/"))}`);
      }
    }
  } else if (bin === "dd") {
    for (const a of args) {
      if (a.startsWith("of=") && a.length > 3) {
        out.push(a.slice(3));
      }
    }
  } else if (bin === "sed" || bin === "gsed") {
    let inPlace = false;
    let hasExplicitScript = false;
    const scripts: string[] = [];
    const pos: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(a)) {
        inPlace = true;
      } else if (a === "-e" || a === "--expression") {
        hasExplicitScript = true;
        if (i + 1 < args.length) scripts.push(args[++i]);
      } else if (a.startsWith("--expression=")) {
        hasExplicitScript = true;
        scripts.push(a.slice("--expression=".length));
      } else if (a === "-f" || a === "--file") {
        hasExplicitScript = true;
        i++;
      } else if (!a.startsWith("-")) {
        pos.push(a);
      }
    }

    if (!hasExplicitScript && pos.length > 0) {
      scripts.push(pos[0]);
      if (inPlace) out.push(...pos.slice(1));
    } else if (inPlace) {
      out.push(...pos);
    }

    // Check sed scripts for 'w <filename>' command or s/.../.../w <filename>
    for (const s of scripts) {
      const wMatches = s.matchAll(/(?:^|[;{}]\s*|\bs([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[0-9gipImlM]*)w\s+([^\s;{}]+)/g);
      for (const m of wMatches) {
        if (m[2]) out.push(m[2]);
      }
    }
  } else if (bin === "find" || bin === "find.exe") {
    for (let i = 0; i < args.length; i++) {
      if (["-fprint", "-fprint0", "-fls", "-fprintf"].includes(args[i]) && i + 1 < args.length) {
        out.push(args[i + 1]);
        i++;
      }
    }
  } else if (bin === "git" || bin === "git.exe") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === "--output" || a === "-o") && i + 1 < args.length) {
        out.push(args[i + 1]);
        i++;
      } else if (a.startsWith("--output=")) {
        out.push(a.slice("--output=".length));
      }
    }
  } else if (bin === "curl" || bin === "curl.exe") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === "-o" || a === "--output") && i + 1 < args.length) {
        out.push(args[i + 1]);
        i++;
      } else if (a.startsWith("--output=")) {
        out.push(a.slice("--output=".length));
      }
    }
  } else if (bin === "wget" || bin === "wget.exe") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((a === "-O" || a === "--output-document") && i + 1 < args.length) {
        out.push(args[i + 1]);
        i++;
      } else if (a.startsWith("--output-document=")) {
        out.push(a.slice("--output-document=".length));
      }
    }
  } else if (["rm", "unlink", "truncate", "touch"].includes(bin)) {
    for (const a of args) {
      if (!a.startsWith("-") && a.length > 0) out.push(a);
    }
  }

  return out;
}

/**
 * Analyzes shell writes across a compound command while tracking working directory
 * changes (cd, pushd, popd) and resolving targets against both currentCwd and initialCwd.
 */
export function analyzeShellWrites(
  commandLine: string,
  initialCwd: string,
  homeDir = os.homedir()
): ShellWriteAnalysis {
  const subCommands = splitCompoundCommands(commandLine);
  let currentCwd = initialCwd;
  let dirChanged = false;
  const resolvedTargets: string[] = [];
  const ambiguousTargets: string[] = [];

  for (const sub of subCommands) {
    const tokens = tokenizeShell(sub);
    const { dequoted } = stripWrappersForDenyAsk(sub);
    const words = dequoted.split(/\s+/).filter(Boolean);
    const bin = getBinaryBasename(words[0] || "");

    // Track directory change commands (cd, pushd, popd)
    if (["cd", "pushd", "popd"].includes(bin)) {
      dirChanged = true;
      if ((bin === "cd" || bin === "pushd") && words.length >= 2) {
        const targetDir = words[1];
        if (targetDir !== "-" && !/[$`*?[\]]/.test(targetDir)) {
          if (targetDir === "~" || targetDir.startsWith("~/") || targetDir.startsWith("~\\")) {
            currentCwd = path.join(homeDir, targetDir.slice(1));
          } else {
            currentCwd = path.resolve(currentCwd, targetDir);
          }
        }
      } else if (bin === "cd" && words.length === 1) {
        currentCwd = homeDir;
      }
    }

    // Collect redirection targets in this subcommand
    const rawSubTargets: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === "redir") {
        const next = tokens[i + 1];
        if (next && next.type === "word") {
          const target = dequoteWord(next.value);
          if (
            !target.startsWith("&") &&
            !/^\d+$/.test(target) &&
            !["/dev/null", "/dev/stdout", "/dev/stderr"].includes(target)
          ) {
            rawSubTargets.push(target);
          }
        }
      }
    }

    // Collect utility write targets in this subcommand
    rawSubTargets.push(...extractUtilityWriteTargets(sub));

    for (const rawT of rawSubTargets) {
      const isRel =
        !path.isAbsolute(rawT) &&
        !/^[a-zA-Z]:[/\\]/.test(rawT) &&
        !rawT.startsWith("//") &&
        rawT !== "~" &&
        !rawT.startsWith("~/");

      if (dirChanged && isRel) {
        ambiguousTargets.push(rawT);
      }

      if (rawT === "~" || rawT.startsWith("~/") || rawT.startsWith("~\\")) {
        resolvedTargets.push(path.join(homeDir, rawT.slice(1)));
      } else if (isRel) {
        resolvedTargets.push(path.resolve(currentCwd, rawT));
        if (currentCwd !== initialCwd) {
          resolvedTargets.push(path.resolve(initialCwd, rawT));
        }
      } else {
        resolvedTargets.push(rawT);
      }
    }
  }

  return {
    targets: Array.from(new Set(resolvedTargets)),
    hasWriteAfterDirChange: ambiguousTargets.length > 0,
    ambiguousTargets: Array.from(new Set(ambiguousTargets))
  };
}

export function extractShellWriteTargets(commandLine: string, initialCwd = process.cwd()): string[] {
  return analyzeShellWrites(commandLine, initialCwd).targets;
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
  "VISUAL"
]);

function checkSubcommandArbitraryExecution(subCmd: string): ArbitraryCheckResult {
  // Check raw words for dangerous env vars and variable/glob characters in command position
  const rawTokens = tokenizeShell(unwrapGrouping(subCmd))
    .filter(t => t.type === "word")
    .map(t => t.value);

  let cmdWordIdx = 0;
  while (cmdWordIdx < rawTokens.length) {
    const tok = rawTokens[cmdWordIdx];
    const envMatch = tok.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=/);
    if (!envMatch) break;
    if (DANGEROUS_ENV_VARS.has(envMatch[1].toUpperCase())) {
      return { detected: true, reason: `Dangerous execution environment variable '${envMatch[1]}' detected` };
    }
    cmdWordIdx++;
  }

  if (cmdWordIdx < rawTokens.length) {
    const rawCmdWord = rawTokens[cmdWordIdx];
    if (/[$`*?[\]]/.test(rawCmdWord)) {
      return {
        detected: true,
        reason: `Variable expansion or glob pattern in command name '${rawCmdWord}' detected`
      };
    }
  }

  const { stripped, dequoted } = stripWrappersForDenyAsk(subCmd);
  const strippedRawWords = stripped.split(/\s+/).filter(Boolean);
  if (strippedRawWords.length > 0 && /[$`*?[\]]/.test(strippedRawWords[0])) {
    return {
      detected: true,
      reason: `Variable expansion or glob pattern in command name '${strippedRawWords[0]}' detected`
    };
  }

  const words = dequoted.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { detected: false };

  const baseCmd = getBinaryBasename(words[0]);
  const args = words.slice(1);

  // 1. Dynamic command name
  if (/[$`*?[\]]/.test(words[0])) {
    return { detected: true, reason: `Dynamic command name '${words[0]}' detected` };
  }

  // 2. Shell built-in evaluators, xargs & su -c
  if (["eval", "exec", "source", ".", "xargs"].includes(baseCmd)) {
    return { detected: true, reason: `Arbitrary execution runner '${baseCmd}' detected` };
  }
  if (baseCmd === "su") {
    if (args.some(a => ["-c", "--command", "--session-command"].includes(a) || a.startsWith("--command="))) {
      return { detected: true, reason: "Privilege switch command execution 'su -c' detected" };
    }
  }

  // 3. BusyBox applet wrapper (busybox sh, busybox awk, etc.)
  if (baseCmd === "busybox" && args.length > 0) {
    return checkSubcommandArbitraryExecution(args.join(" "));
  }

  // 4. POSIX / Unix shells (bash, sh, zsh, dash, ksh, ash, fish) with -c / -lc / -ec / --command
  if (["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"].includes(baseCmd)) {
    for (const arg of args) {
      if (arg === "--command" || arg.startsWith("--command=") || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
        return { detected: true, reason: `Shell inline execution flag '${arg}' detected for '${baseCmd}'` };
      }
    }
  }

  // 5. Python (python, python2, python3, python3.12, python.exe) with -c
  if (/^python(\d+(\.\d+)*)?(\.exe)?$/i.test(baseCmd)) {
    for (const arg of args) {
      if (arg === "-c" || arg.startsWith("-c") || arg === "--command" || /^-[a-zA-Z]*c/.test(arg)) {
        return { detected: true, reason: `Python inline code execution flag '${arg}' detected` };
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
        return { detected: true, reason: `JS runtime inline execution flag '${arg}' detected` };
      }
    }
  }

  // 7. Perl / Ruby / Lua with -e / -E
  if (/^(perl\d*|ruby|irb|lua|luajit)(\.exe)?$/i.test(baseCmd)) {
    for (const arg of args) {
      if (["-e", "-E"].includes(arg) || /^-[a-zA-Z]*[eE]/.test(arg)) {
        return { detected: true, reason: `Interpreter inline execution flag '${arg}' detected for '${baseCmd}'` };
      }
    }
  }

  // 8. PHP with -r
  if (/^php(\d+(\.\d+)*)?(\.exe)?$/i.test(baseCmd)) {
    for (const arg of args) {
      if (arg === "-r" || /^-[a-zA-Z]*r/.test(arg)) {
        return { detected: true, reason: `PHP inline code execution flag '${arg}' detected` };
      }
    }
  }

  // 9. PowerShell / pwsh (-c, -ec, -e, -Command, -EncodedCommand, or bare command arguments)
  if (["pwsh", "pwsh.exe", "powershell", "powershell.exe"].includes(baseCmd)) {
    if (args.length > 0) {
      return { detected: true, reason: `PowerShell command/script execution detected via '${baseCmd}'` };
    }
  }

  // 10. cmd / cmd.exe with /c or /k
  if (["cmd", "cmd.exe"].includes(baseCmd)) {
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower === "/c" || lower === "/k" || lower.startsWith("/c") || lower.startsWith("/k")) {
        return { detected: true, reason: `Windows Command Prompt execution flag '${arg}' detected` };
      }
    }
  }

  // 11. Git arbitrary execution flags (-c, -c<val>, --config-env, --exec-path, --upload-pack, --receive-pack, git config hooks/pager/alias)
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
        return { detected: true, reason: `Git arbitrary execution flag '${arg}' detected` };
      }
    }
    if (args[0] === "config") {
      const joinedConfig = args.slice(1).join(" ");
      if (
        /\b(core\.(pager|editor|sshcommand|fsmonitor|hookspath)|diff\.external|sequence\.editor|credential\.helper|alias\.[a-zA-Z0-9_-]+)\b/i.test(
          joinedConfig
        )
      ) {
        return { detected: true, reason: "Git config modification of executable setting/alias detected" };
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
        return { detected: true, reason: `Tar subcommand execution flag '${arg}' detected` };
      }
    }
  }

  // 13. Find -exec / -execdir / -ok / -okdir
  if (baseCmd === "find" || baseCmd === "find.exe") {
    if (args.some(a => ["-exec", "-execdir", "-ok", "-okdir"].includes(a))) {
      return { detected: true, reason: "Find subcommand execution flag (-exec/-ok) detected" };
    }
  }

  // 14. AWK system(), | getline, |&, or print ... | "cmd"
  if (["awk", "gawk", "mawk", "nawk"].includes(baseCmd)) {
    const joinedArgs = args.join(" ");
    if (/\bsystem\s*\(/.test(joinedArgs) || /\|&/.test(joinedArgs) || /(?<!\|)\|(?!\|)/.test(joinedArgs)) {
      return { detected: true, reason: `AWK command execution or pipe detected in '${baseCmd}'` };
    }
  }

  // 15. GNU sed 'e' command (e.g. '1e id', '$e cmd', '/pat/e') or s///...e flag (including Ie, 2e)
  if (["sed", "gsed"].includes(baseCmd)) {
    for (let i = 0; i < args.length; i++) {
      let scriptCandidate = "";
      if (args[i] === "-e" || args[i] === "--expression") {
        scriptCandidate = args[i + 1] || "";
        i++;
      } else if (args[i].startsWith("--expression=")) {
        scriptCandidate = args[i].slice("--expression=".length);
      } else if (!args[i].startsWith("-")) {
        scriptCandidate = args[i];
      }

      if (scriptCandidate) {
        const hasSubstExec = /s([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[0-9gipImlM]*e[0-9gipImlM]*(?:\s|;|$|\})/.test(
          scriptCandidate
        );
        const hasAddrExec =
          /(?:^|[;{}]\s*)(?:\d+|\$|\/[^/]*\/)?(?:\s*,\s*(?:\d+|\$|\/[^/]*\/))?\s*e(?:\s|$)/.test(scriptCandidate);
        if (hasSubstExec || hasAddrExec) {
          return { detected: true, reason: "GNU sed command execution flag 'e' detected" };
        }
      }
    }
  }

  return { detected: false };
}

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
      return { detected: true, reason: "ANSI-C style quoting ($'...') detected" };
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
        return { detected: true, reason: "Arithmetic evaluation context $((...)) detected" };
      }
      return { detected: true, reason: "Command substitution $(...) detected" };
    }

    // Legacy arithmetic $[...]
    if (c === "$" && i + 1 < len && cmd[i + 1] === "[") {
      return { detected: true, reason: "Arithmetic evaluation context $[...] detected" };
    }

    // Backticks `...`
    if (c === "`") {
      return { detected: true, reason: "Backtick command substitution detected" };
    }

    if (!inDoubleQuote) {
      // Heredoc << or <<-
      if (c === "<" && i + 1 < len && cmd[i + 1] === "<" && (i + 2 >= len || cmd[i + 2] !== "<")) {
        return { detected: true, reason: "Heredoc (<<) input redirection detected" };
      }

      // Process substitution <(...) or >(...)
      if ((c === "<" || c === ">") && i + 1 < len && cmd[i + 1] === "(") {
        return { detected: true, reason: "Process substitution <(...) or >(...) detected" };
      }

      // Brace expansion {a,b} or {1..10}
      if (c === "{") {
        const closeIdx = cmd.indexOf("}", i);
        if (closeIdx > i) {
          const inner = cmd.slice(i + 1, closeIdx);
          if (inner.includes(",") || inner.includes("..")) {
            return { detected: true, reason: `Shell brace expansion {${inner}} detected` };
          }
        }
      }

      // Network socket redirection /dev/tcp or /dev/udp
      if (c === "/" && /^\/dev\/(tcp|udp)\//i.test(cmd.slice(i))) {
        return { detected: true, reason: "Network socket redirection via /dev/tcp or /dev/udp detected" };
      }

      // Non-numeric fd redirection >& or <& (allow standard numeric 2>&1, >&2, <&0, 2>&-)
      if ((c === ">" || c === "<") && i + 1 < len && cmd[i + 1] === "&") {
        const restAfterAmp = cmd.slice(i + 2);
        if (!/^([0-9]+|-)(?=\s|$|[;|&><)])/.test(restAfterAmp)) {
          return { detected: true, reason: "Complex file descriptor redirection (>& or <&) detected" };
        }
      }
    }

    i++;
  }

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

  const isUncHost = /^\/\/[^/]+\//.test(p) && !/^\/\/([a-zA-Z]|mnt)\//.test(p);
  p = p.replace(/\/+/g, "/");
  if (isUncHost && !p.startsWith("//")) {
    p = "/" + p;
  }

  p = p.replace(/^\/?mnt\/([a-zA-Z])(\/|$)/, (_, d, sep) => `/${d.toLowerCase()}${sep}`);
  p = p.replace(/^\/\/([a-zA-Z])(\/|$)/, (_, d, sep) => `/${d.toLowerCase()}${sep}`);

  const winMatch = p.match(/^([a-zA-Z]):(\/(.*)|)$/);
  if (winMatch) {
    p = `/${winMatch[1].toLowerCase()}${winMatch[2] || "/"}`;
  }

  const rootDriveMatch = p.match(/^\/([a-zA-Z])(\/(.*)|)$/);
  if (rootDriveMatch) {
    p = `/${rootDriveMatch[1].toLowerCase()}${rootDriveMatch[2] || "/"}`;
  }

  const normalized = path.posix.normalize(p);
  return isUncHost && !normalized.startsWith("//") ? "/" + normalized : normalized;
}

function resolveRealPathWithAncestors(absPath: string): string {
  try {
    return fs.realpathSync(absPath);
  } catch {
    const parent = path.dirname(absPath);
    if (parent === absPath) return absPath;
    return path.join(resolveRealPathWithAncestors(parent), path.basename(absPath));
  }
}

export function resolveCandidatePaths(targetPath: string, baseDir: string, homeDir = os.homedir()): string[] {
  let expanded = targetPath.trim();

  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(homeDir, expanded.slice(1));
  } else if (!path.isAbsolute(expanded) && !/^[a-zA-Z]:[/\\]/.test(expanded) && !expanded.startsWith("//")) {
    expanded = path.resolve(baseDir, expanded);
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

function testNormalizedPattern(normalizedTarget: string, normalizedPattern: string): boolean {
  const ci = isCaseInsensitivePath(normalizedTarget) || isCaseInsensitivePath(normalizedPattern);
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
 * Matches a target file path against a Claude Code path rule pattern.
 * Note: `allowSystemRootFallback` is ONLY enabled for `deny` and `ask` rules so
 * single-slash `/tmp/**` or `/d/**` never widens an `allow` rule to system paths.
 */
export function matchesPathPattern(
  targetPath: string,
  rulePattern: string,
  baseDir: string,
  homeDir = os.homedir(),
  allowSystemRootFallback = true
): boolean {
  const pat = rulePattern.trim();
  const candidates = resolveCandidatePaths(targetPath, baseDir, homeDir);
  const baseNorm = normalizeUniversalPath(baseDir);

  return candidates.some(normalizedTarget => {
    // 1. Home directory: ~/.ssh/**
    if (pat === "~" || pat.startsWith("~/") || pat.startsWith("~\\")) {
      const absPattern = normalizeUniversalPath(path.join(homeDir, pat.slice(1)));
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

    // 4. Single leading slash /path -> relative to settings/workspace baseDir
    if (pat.startsWith("/")) {
      const relPart = pat.slice(1);
      const wsPattern = normalizeUniversalPath(`${baseNorm}/${relPart}`);
      if (testNormalizedPattern(normalizedTarget, wsPattern)) return true;

      // Compatibility fallback ONLY for deny/ask rules on POSIX roots
      if (allowSystemRootFallback && /^\/(mnt|home|Users|etc|var|tmp|opt|usr|[a-zA-Z])\//.test(pat)) {
        const sysPattern = normalizeUniversalPath(pat);
        if (testNormalizedPattern(normalizedTarget, sysPattern)) return true;
      }
      return false;
    }

    // 5. Explicit ./ prefix -> anchored to baseDir
    if (pat.startsWith("./")) {
      const relPart = pat.slice(2);
      const wsPattern = normalizeUniversalPath(`${baseNorm}/${relPart}`);
      return testNormalizedPattern(normalizedTarget, wsPattern);
    }

    // 6. Recursive prefix **/
    if (pat.startsWith("**/")) {
      const wsRecursive = normalizeUniversalPath(`${baseNorm}/${pat}`);
      return testNormalizedPattern(normalizedTarget, wsRecursive) || testNormalizedPattern(normalizedTarget, pat);
    }

    // 7. Gitignore semantics: no slash -> match at ANY depth inside baseDir
    if (!pat.includes("/")) {
      const anyDepthPattern = normalizeUniversalPath(`${baseNorm}/**/${pat}`);
      return testNormalizedPattern(normalizedTarget, anyDepthPattern);
    }

    // 8. Relative path containing slash -> anchored to baseDir
    const anchoredPattern = normalizeUniversalPath(`${baseNorm}/${pat}`);
    return testNormalizedPattern(normalizedTarget, anchoredPattern);
  });
}

// ============================================================================
// Self-Protection of Permissions & Hook Governance Files
// ============================================================================

function isSelfProtectedGovernanceFile(
  targetPath: string,
  workspaceDirs: string[],
  homeDir = os.homedir()
): boolean {
  const workspacePatterns = [
    "./.claude/settings.json",
    "./.claude/settings.local.json",
    "./.agents/hooks.json",
    "./.agents/hooks/**",
    "./.agent/hooks.json",
    "./.agent/hooks/**"
  ];

  const homePatterns = [
    "~/.claude/settings.json",
    "~/.claude/settings.local.json",
    "~/.gemini/config/hooks.json",
    "~/.gemini/antigravity-cli/**",
    "~/.gemini/antigravity/**"
  ];

  for (const ws of workspaceDirs) {
    if (workspacePatterns.some(pat => matchesPathPattern(targetPath, pat, ws, homeDir, false))) {
      return true;
    }
  }

  return homePatterns.some(pat => matchesPathPattern(targetPath, pat, homeDir, homeDir, false));
}

// ============================================================================
// Bash & WebFetch Rule Matchers
// ============================================================================

export function matchesBashRule(command: string, rule: string): boolean {
  if (rule === "Bash") return true;

  const match = rule.match(/^Bash\((.*)\)$/);
  if (!match) return false;

  const inner = match[1].trim();

  if (inner.endsWith(":*")) {
    const prefix = inner.slice(0, -2);
    return (
      command === prefix ||
      command.startsWith(prefix + " ") ||
      command.startsWith(prefix + "\t") ||
      command.startsWith(prefix + "/")
    );
  }

  if (inner.includes("*")) {
    const escaped = inner
      .replace(/[-[\]{}()+?.,^$|#\s]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(command);
  }

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
    return new RegExp(`^${escaped}$`, "i").test(hostname) || new RegExp(`^${escaped}$`, "i").test(urlStr);
  }

  return hostname === inner.toLowerCase() || urlStr.toLowerCase().startsWith(inner.toLowerCase());
}

// ============================================================================
// Settings Loader (Merges Global User + Workspace Settings & Tracks BaseDir)
// ============================================================================

export function loadMergedClaudeSettings(
  workspaceDirs: string | string[],
  homeDir = os.homedir()
): ClaudeSettings {
  const wsList = Array.isArray(workspaceDirs) ? workspaceDirs : [workspaceDirs];
  const candidateFiles: { filePath: string; baseDir: string }[] = [
    { filePath: path.join(homeDir, ".claude", "settings.json"), baseDir: homeDir },
    { filePath: path.join(homeDir, ".claude", "settings.local.json"), baseDir: homeDir }
  ];

  for (const ws of wsList) {
    candidateFiles.push(
      { filePath: path.join(ws, ".claude", "settings.json"), baseDir: ws },
      { filePath: path.join(ws, ".claude", "settings.local.json"), baseDir: ws }
    );
  }

  const merged: ClaudeSettings = {
    permissions: { deny: [], ask: [], allow: [] },
    settingsErrors: []
  };

  for (const { filePath, baseDir } of candidateFiles) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed: any = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        merged.settingsErrors!.push(`Settings file ${filePath} root must be a JSON object`);
        continue;
      }

      if (parsed.permissions !== undefined) {
        if (!parsed.permissions || typeof parsed.permissions !== "object" || Array.isArray(parsed.permissions)) {
          merged.settingsErrors!.push(`'permissions' in ${filePath} must be an object`);
          continue;
        }
        for (const tier of ["deny", "ask", "allow"] as const) {
          const list = parsed.permissions[tier];
          if (list !== undefined) {
            if (!Array.isArray(list)) {
              merged.settingsErrors!.push(`'permissions.${tier}' in ${filePath} must be an array`);
            } else {
              for (const item of list) {
                if (typeof item === "string") {
                  merged.permissions![tier]!.push({ rule: item, baseDir });
                }
              }
            }
          }
        }
      }

      if (parsed["agy-cli-permission-hook-default-access"] !== undefined) {
        merged["agy-cli-permission-hook-default-access"] = parsed["agy-cli-permission-hook-default-access"];
      }
      if (parsed["agy-cli-permission-hook-arbitrary-command-execution"] !== undefined) {
        merged["agy-cli-permission-hook-arbitrary-command-execution"] =
          parsed["agy-cli-permission-hook-arbitrary-command-execution"];
      }
    } catch (err: any) {
      const errMsg = `Invalid JSON in settings file ${filePath}: ${err?.message || err}`;
      log(errMsg);
      merged.settingsErrors!.push(errMsg);
    }
  }

  return merged;
}

// ============================================================================
// File Path Evaluation Helper (Shared by File Tools & Shell Writes)
// ============================================================================

function evaluateFilePaths(
  paths: string[],
  mode: "read" | "edit" | "search",
  settings: ClaudeSettings,
  workspaceDirs: string[],
  homeDir = os.homedir()
): { level: RuleLevel; reason?: string } {
  const defaultAccess = parseRuleLevel(settings["agy-cli-permission-hook-default-access"], "ask");
  const denyList = settings.permissions?.deny || [];
  const askList = settings.permissions?.ask || [];
  const allowList = settings.permissions?.allow || [];

  const actionPrefixes = mode === "edit" ? ["Edit", "Write"] : mode === "search" ? ["Grep", "Read"] : ["Read", "Glob"];
  const results: { target: string; level: RuleLevel; reason?: string }[] = [];

  for (const rawPath of paths) {
    let level: RuleLevel = defaultAccess;
    let reason: string | undefined;

    // 1. Deny checks (highest precedence; checks rule's baseDir and all workspaceDirs)
    for (const entry of denyList) {
      const { rule, baseDir } = unpackRule(entry, workspaceDirs[0]);
      const dirsToCheck = typeof entry === "string" ? workspaceDirs : [baseDir];

      for (const act of actionPrefixes) {
        if (rule === act) {
          level = "deny";
          reason = `Claude Permission Hook: ${act} denied by rule '${rule}'`;
          break;
        }
        const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
        if (m && dirsToCheck.some(d => matchesPathPattern(rawPath, m[1], d, homeDir, true))) {
          level = "deny";
          reason = `Claude Permission Hook: Path '${rawPath}' denied by rule '${rule}'`;
          break;
        }
      }
      if (level === "deny") break;
    }

    // 2. Self-protection check: never auto-approve edits to governance files
    if (level !== "deny" && mode === "edit" && isSelfProtectedGovernanceFile(rawPath, workspaceDirs, homeDir)) {
      level = "ask";
      reason = `Claude Permission Hook: Modifying permission/hook governance file '${rawPath}' requires explicit approval`;
      results.push({ target: rawPath, level, reason });
      continue;
    }

    // 3. Ask checks
    if (level !== "deny") {
      for (const entry of askList) {
        const { rule, baseDir } = unpackRule(entry, workspaceDirs[0]);
        const dirsToCheck = typeof entry === "string" ? workspaceDirs : [baseDir];

        for (const act of actionPrefixes) {
          if (rule === act) {
            level = "ask";
            reason = `Claude Permission Hook: ${act} requires confirmation by rule '${rule}'`;
            break;
          }
          const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
          if (m && dirsToCheck.some(d => matchesPathPattern(rawPath, m[1], d, homeDir, true))) {
            level = "ask";
            reason = `Claude Permission Hook: Path '${rawPath}' requires confirmation by rule '${rule}'`;
            break;
          }
        }
        if (level === "ask") break;
      }
    }

    // 4. Allow checks (allowSystemRootFallback = false so /tmp/** never widens to system /tmp)
    if (level !== "deny" && level !== "ask") {
      for (const entry of allowList) {
        const { rule, baseDir } = unpackRule(entry, workspaceDirs[0]);
        const dirsToCheck = typeof entry === "string" ? workspaceDirs : [baseDir];

        for (const act of actionPrefixes) {
          if (rule === act) {
            level = "allow";
            break;
          }
          const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
          if (m && dirsToCheck.some(d => matchesPathPattern(rawPath, m[1], d, homeDir, false))) {
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

  const denied = results.find(r => r.level === "deny");
  if (denied) return { level: "deny", reason: denied.reason };

  const asked = results.find(r => r.level === "ask");
  if (asked) return { level: "ask", reason: asked.reason };

  return { level: "allow" };
}

// ============================================================================
// Core Evaluation Engine
// ============================================================================

export function evaluateRequestWithSettings(
  input: HookInput,
  settings: ClaudeSettings,
  homeDir = os.homedir()
): HookOutput {
  // Fail-closed if any settings file had broken/invalid JSON
  if (Array.isArray(settings.settingsErrors) && settings.settingsErrors.length > 0) {
    return {
      decision: "deny",
      reason: `Claude Permission Hook: Settings configuration error (${settings.settingsErrors[0]})`
    };
  }

  const toolName = input.toolCall?.name || input.tool || "";
  const args = input.toolCall?.args || input.parameters || {};

  const workspaceDirs: string[] =
    Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0
      ? input.workspacePaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [input.context?.cwd || input.cwd || process.cwd()];

  const primaryCwd = workspaceDirs[0];

  const defaultAccess = parseRuleLevel(settings["agy-cli-permission-hook-default-access"], "ask");
  const arbitraryOverride = parseRuleLevel(
    settings["agy-cli-permission-hook-arbitrary-command-execution"],
    "ask"
  );

  const denyList = (settings.permissions?.deny || []).map(e => unpackRule(e, primaryCwd).rule);
  const askList = (settings.permissions?.ask || []).map(e => unpackRule(e, primaryCwd).rule);
  const allowList = (settings.permissions?.allow || []).map(e => unpackRule(e, primaryCwd).rule);

  log(`Evaluating tool: "${toolName}" | cwd: "${primaryCwd}" | args: ${JSON.stringify(sanitizeArgsForLog(args))}`);

  // --------------------------------------------------------------------------
  // 1. Shell Command Execution (run_command)
  // --------------------------------------------------------------------------
  const isCommandTool = ["run_command", "Bash", "bash", "execute_command", "terminal"].includes(toolName);
  if (isCommandTool) {
    const rawCommand = args.CommandLine ?? args.command ?? args.cmd;

    if (typeof rawCommand !== "string" || !rawCommand.trim()) {
      return {
        decision: "deny",
        reason: "Claude Permission Hook: Empty or unreadable command is not allowed"
      };
    }

    const commandCwd =
      typeof args.Cwd === "string" && args.Cwd.trim()
        ? path.resolve(primaryCwd, args.Cwd.trim())
        : primaryCwd;

    // Dimension 1: Evaluate composite line & subcommands against Bash rules
    let bashLevel: RuleLevel = "allow";
    let bashReason: string | undefined;

    const trimmedFull = rawCommand.trim();
    for (const rule of denyList) {
      if (matchesBashRule(trimmedFull, rule)) {
        bashLevel = "deny";
        bashReason = `Claude Permission Hook: Command line denied by rule '${rule}'`;
        break;
      }
    }
    if (bashLevel !== "deny") {
      for (const rule of askList) {
        if (matchesBashRule(trimmedFull, rule)) {
          bashLevel = "ask";
          bashReason = `Claude Permission Hook: Command line requires confirmation by rule '${rule}'`;
          break;
        }
      }
    }

    const subCommands = splitCompoundCommands(rawCommand);
    if (subCommands.length === 0) {
      return {
        decision: "deny",
        reason: "Claude Permission Hook: Command parsed to zero executable tokens"
      };
    }

    const subResults: { cmd: string; level: RuleLevel; reason?: string }[] = [];
    for (const subCmd of subCommands) {
      const { stripped, dequoted, baseNormalized } = stripWrappersForDenyAsk(subCmd);
      // Also strip redirections (e.g. `rm -rf / > out.txt` -> `rm -rf /`) for Deny/Ask checks
      const withoutRedirs = (() => {
        const toks = tokenizeShell(subCmd);
        const kept: string[] = [];
        for (let i = 0; i < toks.length; i++) {
          if (toks[i].type === "redir" || toks[i].type === "heredoc") {
            i++; // skip redir and its target word
          } else if (toks[i].type === "word") {
            kept.push(toks[i].value);
          }
        }
        return kept.join(" ").trim();
      })();
      const strippedWithoutRedirs = stripWrappersForDenyAsk(withoutRedirs);

      const denyAskCandidates = Array.from(
        new Set([
          subCmd.trim(),
          stripped,
          dequoted,
          baseNormalized,
          withoutRedirs,
          strippedWithoutRedirs.stripped,
          strippedWithoutRedirs.dequoted,
          strippedWithoutRedirs.baseNormalized
        ])
      ).filter(Boolean);

      let subLevel: RuleLevel = defaultAccess;
      let subReason: string | undefined;

      // 1. Deny check
      for (const rule of denyList) {
        if (denyAskCandidates.some(cand => matchesBashRule(cand, rule))) {
          subLevel = "deny";
          subReason = `Claude Permission Hook: Subcommand '${subCmd}' denied by rule '${rule}'`;
          break;
        }
      }

      // 2. Ask check
      if (subLevel !== "deny") {
        for (const rule of askList) {
          if (denyAskCandidates.some(cand => matchesBashRule(cand, rule))) {
            subLevel = "ask";
            subReason = `Claude Permission Hook: Subcommand '${subCmd}' requires confirmation by rule '${rule}'`;
            break;
          }
        }
      }

      // 3. Allow check (NEVER strip wrappers or env vars for Allow rules; only strip safe 2>&1 fd duplication)
      if (subLevel !== "deny" && subLevel !== "ask") {
        const allowTarget = subCmd.trim();
        const allowTargetNoSafeFd = allowTarget.replace(/\s+\d*>[&][0-9-]+$/, "").trim();
        for (const rule of allowList) {
          if (matchesBashRule(allowTarget, rule) || matchesBashRule(allowTargetNoSafeFd, rule)) {
            subLevel = "allow";
            break;
          }
        }
      }

      if (subLevel !== "allow" && !subReason) {
        subReason = `Claude Permission Hook: Default access (${subLevel}) applied for subcommand '${subCmd}'`;
      }

      subResults.push({ cmd: subCmd, level: subLevel, reason: subReason });
    }

    const deniedSub = subResults.find(r => r.level === "deny");
    const askedSub = subResults.find(r => r.level === "ask");
    if (deniedSub) {
      bashLevel = "deny";
      bashReason = deniedSub.reason;
    } else if (bashLevel !== "deny" && askedSub) {
      bashLevel = "ask";
      bashReason = bashReason || askedSub.reason;
    }

    // Dimension 2: Arbitrary command execution inspection (full line + every subcommand)
    const arbitraryCheck = checkArbitraryExecution(rawCommand);
    const arbLevel: RuleLevel = arbitraryCheck.detected ? arbitraryOverride : "allow";
    const arbReason = arbitraryCheck.detected
      ? `Claude Permission Hook: Arbitrary command execution detected (${arbitraryCheck.reason})`
      : undefined;

    // Dimension 3: Shell file-write / redirection / Cwd & cd inspection
    const writeAnalysis = analyzeShellWrites(rawCommand, commandCwd, homeDir);
    let writeLevel: RuleLevel = "allow";
    let writeReason: string | undefined;

    if (writeAnalysis.targets.length > 0) {
      const redirEval = evaluateFilePaths(writeAnalysis.targets, "edit", settings, workspaceDirs, homeDir);
      writeLevel = redirEval.level;
      writeReason = redirEval.reason;

      if (writeLevel !== "deny" && writeAnalysis.hasWriteAfterDirChange) {
        writeLevel = "ask";
        writeReason = `Claude Permission Hook: File write '${writeAnalysis.ambiguousTargets[0]}' after directory change (cd/pushd/popd) requires confirmation`;
      }
    }

    // Combine all 3 dimensions using strict precedence: Deny > Ask > Allow
    const finalLevel = strictestLevel([bashLevel, arbLevel, writeLevel]);

    if (finalLevel === "deny") {
      const reason =
        (bashLevel === "deny" && bashReason) ||
        (writeLevel === "deny" && writeReason) ||
        (arbLevel === "deny" && arbReason) ||
        "Claude Permission Hook: Command denied";
      return { decision: "deny", reason };
    }

    if (finalLevel === "ask") {
      const reason =
        (arbLevel === "ask" && arbReason) ||
        (writeLevel === "ask" && writeReason) ||
        (bashLevel === "ask" && bashReason) ||
        "Claude Permission Hook: Command requires confirmation";
      return { decision: "force_ask", reason };
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
    "glob"
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
    "Write"
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
      "target_file"
    ];

    for (const key of pathKeys) {
      if (typeof args[key] === "string" && args[key].trim()) {
        rawPaths.push(args[key]);
      }
    }
    if (Array.isArray(args.paths)) {
      rawPaths.push(...args.paths.filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0));
    }

    const mode = isEdit ? "edit" : isSearch ? "search" : "read";
    const actionPrefixes = isEdit ? ["Edit", "Write"] : isSearch ? ["Grep", "Read"] : ["Read", "Glob"];

    if (rawPaths.length === 0) {
      // Never substitute workspace root when a mapped file tool has no recognized path argument!
      if (denyList.some(r => actionPrefixes.includes(r))) {
        return {
          decision: "deny",
          reason: `Claude Permission Hook: Tool '${toolName}' denied by bare rule`
        };
      }
      return {
        decision: "force_ask",
        reason: `Claude Permission Hook: Tool '${toolName}' called without a recognized path argument; prompting for safety`
      };
    }

    const evalRes = evaluateFilePaths(rawPaths, mode, settings, workspaceDirs, homeDir);
    return {
      decision: toAntigravityDecision(evalRes.level),
      reason: evalRes.reason
    };
  }

  // --------------------------------------------------------------------------
  // 3. Web & Research Tools (search_web, read_url_content)
  // --------------------------------------------------------------------------
  const isWebSearch = ["search_web", "web_search", "google_search", "WebSearch"].includes(toolName);
  const isWebFetch = ["read_url_content", "web_fetch", "fetch_web_page", "http_request", "WebFetch"].includes(toolName);

  if (isWebSearch) {
    if (denyList.includes("WebSearch")) {
      return { decision: "deny", reason: "Claude Permission Hook: WebSearch denied by rule" };
    }
    if (askList.includes("WebSearch")) {
      return { decision: "force_ask", reason: "Claude Permission Hook: WebSearch requires confirmation by rule" };
    }
    if (allowList.includes("WebSearch")) {
      return { decision: "auto_approve" };
    }
    return {
      decision: toAntigravityDecision(defaultAccess),
      reason: `Claude Permission Hook: Default access (${defaultAccess}) applied for WebSearch`
    };
  }

  if (isWebFetch) {
    const rawUrl = String(args.Url ?? args.url ?? args.target ?? "").trim();
    if (!rawUrl) {
      return {
        decision: "force_ask",
        reason: `Claude Permission Hook: '${toolName}' called without a recognized Url argument`
      };
    }

    for (const rule of denyList) {
      if (matchesWebFetchRule(rawUrl, rule)) {
        return { decision: "deny", reason: `Claude Permission Hook: WebFetch denied by rule '${rule}'` };
      }
    }
    for (const rule of askList) {
      if (matchesWebFetchRule(rawUrl, rule)) {
        return { decision: "force_ask", reason: `Claude Permission Hook: WebFetch requires confirmation by rule '${rule}'` };
      }
    }
    for (const rule of allowList) {
      if (matchesWebFetchRule(rawUrl, rule)) {
        return { decision: "auto_approve" };
      }
    }
    return {
      decision: toAntigravityDecision(defaultAccess),
      reason: `Claude Permission Hook: Default access (${defaultAccess}) applied for WebFetch`
    };
  }

  // --------------------------------------------------------------------------
  // 4. Fallback for Unmapped Tools
  // --------------------------------------------------------------------------
  return {
    decision: toAntigravityDecision(defaultAccess),
    reason: `Claude Permission Hook: Fallback default access (${defaultAccess}) for tool '${toolName || "unknown"}'`
  };
}

// ============================================================================
// CLI Standard Input Entry Point (Fail-Closed on Error)
// ============================================================================

function inferFallbackWorkspaceRoot(): string {
  // If running from <repo>/.agents/hooks/claude-permissions.ts, infer <repo>
  if (path.basename(HOOK_DIR) === "hooks" && path.basename(path.dirname(HOOK_DIR)) === ".agents") {
    return path.resolve(HOOK_DIR, "..", "..");
  }
  return process.cwd();
}

export function main(): void {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
  });

  process.stdin.on("end", () => {
    try {
      if (!buffer.trim()) {
        const emptyOut: HookOutput = {
          decision: "deny",
          reason: "Claude Permission Hook: Empty payload received on stdin"
        };
        log(`Outcome: DENY | Reason: ${emptyOut.reason}`);
        process.stdout.write(JSON.stringify(emptyOut) + "\n");
        return;
      }

      const input: HookInput = JSON.parse(buffer);
      const workspaceDirs =
        Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0
          ? input.workspacePaths
          : [input.context?.cwd || input.cwd || inferFallbackWorkspaceRoot()];

      const settings = loadMergedClaudeSettings(workspaceDirs);
      const result = evaluateRequestWithSettings(input, settings);

      log(`Outcome: ${result.decision.toUpperCase()} | Reason: ${result.reason || "N/A"}`);
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (err: any) {
      log(`Fatal Hook Error: ${err?.stack || err}`);
      const failClosed: HookOutput = {
        decision: "deny",
        reason: `Claude Permission Hook internal error (fail-closed): ${err?.message || "Unknown error"}`
      };
      process.stdout.write(JSON.stringify(failClosed) + "\n");
    }
  });
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
})();

if (isMainModule) {
  main();
}