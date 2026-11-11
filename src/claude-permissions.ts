import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type Decision = "allow" | "ask" | "deny";

export interface HookInput {
  tool: string;
  parameters: Record<string, any>;
  context?: {
    cwd?: string;
    sessionId?: string;
  };
}

export interface HookOutput {
  decision: Decision;
  reason?: string;
}

export interface ClaudeSettings {
  permissions?: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  };
  "agy-cli-permission-hook-default-access"?: Decision;
  "agy-cli-permission-hook-arbitrary-command-execution"?: Decision;
  [key: string]: any;
}

// --- Shell Lexer & Compound Parser ---

export interface ShellToken {
  type: "word" | "op" | "newline" | "comment";
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

    if (c === "\\" && i + 1 < len && (script[i + 1] === "\n" || script[i + 1] === "\r")) {
      i += script[i + 1] === "\r" && i + 2 < len && script[i + 2] === "\n" ? 3 : 2;
      continue;
    }

    if (inSingleQuote) {
      cur += c;
      if (c === "'") inSingleQuote = false;
      i++;
      continue;
    }

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

    if (c === "&" || c === "|" || c === ";") {
      const next = i + 1 < len ? script[i + 1] : "";

      if ((c === "&" && next === "&") || (c === "|" && next === "|") || (c === "|" && next === "&")) {
        if (cur.trim()) {
          tokens.push({ type: "word", value: cur });
          cur = "";
        }
        tokens.push({ type: "op", value: c + next });
        i += 2;
        continue;
      }

      if (c === "&" && (next === ">" || script[i - 1] === ">" || script[i - 1] === "<")) {
        cur += c;
        i++;
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

export function unwrapGrouping(cmd: string): string {
  let trimmed = cmd.trim();
  let changed = true;

  while (changed) {
    changed = false;
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      trimmed = trimmed.slice(1, -1).trim();
      changed = true;
      continue;
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const inner = trimmed.slice(1, -1).trim();
      trimmed = inner.endsWith(";") ? inner.slice(0, -1).trim() : inner;
      changed = true;
      continue;
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

export function extractUnderlyingCommand(cmd: string): { effective: string; dequoted: string; wrappers: string[] } {
  let working = cmd.trim();
  const wrappers: string[] = [];

  let advanced = true;
  while (advanced) {
    advanced = false;

    const envMatch = working.match(/^[a-zA-Z_][a-zA-Z0-9_]*=[^\s]*\s+(.*)$/);
    if (envMatch) {
      working = envMatch[1].trim();
      advanced = true;
      continue;
    }

    const words = working.split(/\s+/);
    const firstWordDequoted = dequoteWord(words[0] || "").toLowerCase();

    const passthroughWrappers = ["command", "builtin", "nohup", "nice", "ionice", "time", "stdbuf", "doas"];
    if (passthroughWrappers.includes(firstWordDequoted) && words.length > 1) {
      wrappers.push(firstWordDequoted);
      working = words.slice(1).join(" ").trim();
      advanced = true;
      continue;
    }

    if (firstWordDequoted === "sudo" && words.length > 1) {
      wrappers.push("sudo");
      let idx = 1;
      while (idx < words.length && words[idx].startsWith("-")) {
        if (["-u", "-g", "-h", "-p"].includes(words[idx])) {
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
  }

  const dequotedWords = working.split(/\s+/).map(dequoteWord);

  return {
    effective: working,
    dequoted: dequotedWords.join(" "),
    wrappers
  };
}

// --- Arbitrary Command Detection ---

export function checkArbitraryExecution(cmd: string): { detected: boolean; reason?: string } {
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

    if (c === "$" && i + 1 < len && cmd[i + 1] === "(") {
      if (i + 2 < len && cmd[i + 2] === "(") {
        return { detected: true, reason: "Arithmetic evaluation context $((...)) detected" };
      }
      return { detected: true, reason: "Command substitution $(...) detected" };
    }

    if (c === "$" && i + 1 < len && cmd[i + 1] === "[") {
      return { detected: true, reason: "Arithmetic evaluation context $[...] detected" };
    }

    if (c === "`") {
      return { detected: true, reason: "Backtick command substitution detected" };
    }

    if (!inDoubleQuote) {
      if ((c === "<" || c === ">") && i + 1 < len && cmd[i + 1] === "(") {
        return { detected: true, reason: "Process substitution <(...) or >(...) detected" };
      }

      if (c === "{") {
        const closeIdx = cmd.indexOf("}", i);
        if (closeIdx > i) {
          const inner = cmd.slice(i + 1, closeIdx);
          if (inner.includes(",") || inner.includes("..")) {
            return { detected: true, reason: `Shell brace expansion {${inner}} detected` };
          }
        }
      }

      if (c === "/" && cmd.slice(i).match(/^\/dev\/(tcp|udp)\//i)) {
        return { detected: true, reason: "Network socket redirection via /dev/tcp or /dev/udp detected" };
      }

      if ((c === ">" || c === "<") && i + 1 < len && cmd[i + 1] === "&") {
        return { detected: true, reason: "File descriptor redirection (>& or <&) detected" };
      }
    }

    i++;
  }

  const { effective, dequoted } = extractUnderlyingCommand(cmd);
  const words = effective.split(/\s+/);
  const dequotedWords = dequoted.split(/\s+/);
  const baseCmd = dequotedWords[0] || "";

  if (baseCmd.startsWith("$") || baseCmd.includes("`") || baseCmd.includes("$(")) {
    return { detected: true, reason: `Dynamic command name evaluation '${baseCmd}' detected` };
  }

  const dangerousRunners = ["eval", "exec", "source", "."];
  if (dangerousRunners.includes(baseCmd)) {
    return { detected: true, reason: `Arbitrary command runner '${baseCmd}' detected` };
  }

  if (baseCmd === "git") {
    for (let t = 1; t < words.length; t++) {
      const tok = dequoteWord(words[t]);
      if (tok.startsWith("--exec-path=") || tok === "--exec-path" || tok.startsWith("--config-env=")) {
        return { detected: true, reason: `Git flag '${tok}' permits arbitrary command execution` };
      }
      if (tok === "-c" && t + 1 < words.length) {
        const configVal = dequoteWord(words[t + 1]);
        if (/^(core\.pager|core\.editor|diff\.external|sequence\.editor)=/i.test(configVal)) {
          return { detected: true, reason: `Git -c configuration '${configVal}' executes subcommands` };
        }
      }
    }
  }

  if (baseCmd === "tar") {
    if (cmd.includes("--to-command=") || cmd.includes("--checkpoint-action=")) {
      return { detected: true, reason: "Tar subcommand execution flag detected" };
    }
  }

  if (baseCmd === "find") {
    if (dequotedWords.some(t => ["-exec", "-execdir", "-ok", "-okdir"].includes(t))) {
      return { detected: true, reason: "Find command execution flag (-exec/-ok) detected" };
    }
  }

  if (baseCmd === "xargs") {
    return { detected: true, reason: "Arbitrary execution runner 'xargs' detected" };
  }

  const interpreterFlags = [
    { bin: "bash", flag: "-c" },
    { bin: "sh", flag: "-c" },
    { bin: "zsh", flag: "-c" },
    { bin: "cmd", flag: "/c" },
    { bin: "cmd.exe", flag: "/c" },
    { bin: "powershell", flag: "-command" },
    { bin: "powershell.exe", flag: "-command" },
    { bin: "pwsh", flag: "-command" },
    { bin: "python", flag: "-c" },
    { bin: "python3", flag: "-c" },
    { bin: "node", flag: "-e" },
    { bin: "perl", flag: "-e" }
  ];

  for (const { bin, flag } of interpreterFlags) {
    if (baseCmd.toLowerCase() === bin && dequotedWords.some(t => t.toLowerCase() === flag)) {
      return { detected: true, reason: `Inline script execution flag detected for interpreter '${bin}'` };
    }
  }

  return { detected: false };
}

// --- Path Normalization & Pattern Matching ---

export function normalizeUniversalPath(rawPath: string): string {
  let p = rawPath.replace(/\\/g, "/");

  const isUnc = p.startsWith("//");
  p = p.replace(/\/+/g, "/");
  if (isUnc && !p.startsWith("//")) {
    p = "/" + p;
  }

  p = p.replace(/^\/?mnt\/([a-zA-Z])\//, "/$1/");
  p = p.replace(/^\/\/([a-zA-Z])\//, "/$1/");

  const winMatch = p.match(/^([a-zA-Z]):\/(.*)$/);
  if (winMatch) {
    p = `/${winMatch[1].toLowerCase()}/${winMatch[2]}`;
  }

  const rootDriveMatch = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (rootDriveMatch) {
    p = `/${rootDriveMatch[1].toLowerCase()}/${rootDriveMatch[2]}`;
  }

  return path.posix.normalize(p);
}

export function resolveTargetFilePath(targetPath: string, cwd: string): string {
  const homeDir = os.homedir();
  let expanded = targetPath.trim();

  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(homeDir, expanded.slice(1));
  } else if (!path.isAbsolute(expanded) && !/^[a-zA-Z]:[/\\]/.test(expanded) && !expanded.startsWith("//")) {
    expanded = path.resolve(cwd, expanded);
  }

  return normalizeUniversalPath(expanded);
}

export function globToRegExp(pattern: string): RegExp {
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

  return new RegExp(`^${regexStr}$`, "i");
}

export function matchesPathPattern(targetPath: string, rulePattern: string, cwd: string): boolean {
  let pat = rulePattern.trim();

  if (pat.startsWith("./")) {
    pat = pat.slice(2);
  }

  const normalizedTarget = normalizeUniversalPath(targetPath);

  const matchesDirectoryBoundary = (basePattern: string): boolean => {
    if (basePattern.endsWith("/**")) {
      const rootDir = basePattern.slice(0, -3);
      if (normalizedTarget.toLowerCase() === rootDir.toLowerCase()) return true;
    }
    return false;
  };

  if (pat.startsWith("~/") || pat.startsWith("~\\")) {
    const absPattern = normalizeUniversalPath(path.join(os.homedir(), pat.slice(2)));
    if (globToRegExp(absPattern).test(normalizedTarget)) return true;
    if (matchesDirectoryBoundary(absPattern)) return true;
    return false;
  }

  if (pat.startsWith("/") || pat.startsWith("//") || /^[a-zA-Z]:[/\\]/.test(pat)) {
    const absPattern = normalizeUniversalPath(pat);
    if (globToRegExp(absPattern).test(normalizedTarget)) return true;
    if (matchesDirectoryBoundary(absPattern)) return true;
    return false;
  }

  const cwdNormalized = normalizeUniversalPath(cwd);
  const fullWorkspacePattern = `${cwdNormalized}/${pat}`;
  if (globToRegExp(fullWorkspacePattern).test(normalizedTarget)) return true;
  if (matchesDirectoryBoundary(fullWorkspacePattern)) return true;

  if (pat.startsWith("**")) {
    if (globToRegExp(pat).test(normalizedTarget)) return true;
    if (matchesDirectoryBoundary(pat)) return true;
  }

  return false;
}

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
    return new RegExp(`^${escaped}$`, "i").test(command);
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
    const parsed = new URL(urlStr);
    hostname = parsed.hostname.toLowerCase();
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

export function evaluateRequestWithSettings(input: HookInput, settings: ClaudeSettings): HookOutput {
  const cwd = input.context?.cwd || process.cwd();

  const defaultAccess: Decision = settings["agy-cli-permission-hook-default-access"] || "ask";
  const arbitraryExecutionOverride: Decision = settings["agy-cli-permission-hook-arbitrary-command-execution"] || "ask";

  const denyList = settings.permissions?.deny || [];
  const askList = settings.permissions?.ask || [];
  const allowList = settings.permissions?.allow || [];

  const { tool, parameters } = input;

  const isCommand = ["run_command", "Bash", "bash", "execute_command", "terminal"].includes(tool);
  if (isCommand) {
    const rawCommand: string = parameters.command || parameters.cmd || "";
    if (!rawCommand.trim()) {
      return { decision: "allow" };
    }

    const arbitraryCheck = checkArbitraryExecution(rawCommand);
    if (arbitraryCheck.detected) {
      return {
        decision: arbitraryExecutionOverride,
        reason: `Claude Permission Hook: Arbitrary command execution detected (${arbitraryCheck.reason})`
      };
    }

    for (const rule of denyList) {
      if (matchesBashRule(rawCommand, rule)) {
        return {
          decision: "deny",
          reason: `Claude Permission Hook: Command line denied by rule '${rule}'`
        };
      }
    }
    for (const rule of askList) {
      if (matchesBashRule(rawCommand, rule)) {
        return {
          decision: "ask",
          reason: `Claude Permission Hook: Command line requires confirmation by rule '${rule}'`
        };
      }
    }

    const subCommands = splitCompoundCommands(rawCommand);
    const decisions: { cmd: string; decision: Decision; matchedRule?: string }[] = [];

    for (const subCmd of subCommands) {
      const { effective, dequoted } = extractUnderlyingCommand(subCmd);
      let cmdDecision: Decision = defaultAccess;
      let matchedRule: string | undefined;

      const candidates = [subCmd, effective, dequoted].filter((v, i, a) => a.indexOf(v) === i);

      for (const rule of denyList) {
        if (candidates.some(cand => matchesBashRule(cand, rule))) {
          cmdDecision = "deny";
          matchedRule = rule;
          break;
        }
      }

      if (cmdDecision !== "deny") {
        for (const rule of askList) {
          if (candidates.some(cand => matchesBashRule(cand, rule))) {
            cmdDecision = "ask";
            matchedRule = rule;
            break;
          }
        }
      }

      if (cmdDecision !== "deny" && cmdDecision !== "ask") {
        for (const rule of allowList) {
          if (candidates.some(cand => matchesBashRule(cand, rule))) {
            cmdDecision = "allow";
            matchedRule = rule;
            break;
          }
        }
      }

      decisions.push({ cmd: subCmd, decision: cmdDecision, matchedRule });
    }

    const denied = decisions.find(d => d.decision === "deny");
    if (denied) {
      return {
        decision: "deny",
        reason: `Claude Permission Hook: Subcommand '${denied.cmd}' denied by rule '${denied.matchedRule || "default"}'`
      };
    }

    const asked = decisions.find(d => d.decision === "ask");
    if (asked) {
      return {
        decision: "ask",
        reason: `Claude Permission Hook: Subcommand '${asked.cmd}' requires confirmation by rule '${asked.matchedRule || "default"}'`
      };
    }

    if (decisions.every(d => d.decision === "allow") && decisions.length > 0) {
      return { decision: "allow" };
    }

    return {
      decision: defaultAccess,
      reason: `Claude Permission Hook: Fallback default-access applied for command`
    };
  }

  const isFileRead = ["read_file", "view_file", "Read", "list_dir", "directory_list", "find_files", "glob", "Glob"].includes(tool);
  const isFileEdit = ["edit_file", "write_file", "create_file", "patch_file", "replace_in_file", "Edit", "Write"].includes(tool);
  const isSearch = ["grep", "grep_search", "search_files", "Grep"].includes(tool);

  if (isFileRead || isFileEdit || isSearch) {
    const rawPaths: string[] = [];
    if (typeof parameters.file_path === "string") rawPaths.push(parameters.file_path);
    if (typeof parameters.path === "string") rawPaths.push(parameters.path);
    if (typeof parameters.directory === "string") rawPaths.push(parameters.directory);
    if (Array.isArray(parameters.paths)) rawPaths.push(...parameters.paths.filter((p: any) => typeof p === "string"));

    if (rawPaths.length > 0) {
      const actionPrefixes = isFileEdit ? ["Edit", "Write"] : isSearch ? ["Grep", "Read"] : ["Read", "Glob"];
      const decisions: { path: string; decision: Decision; matchedRule?: string }[] = [];

      for (const p of rawPaths) {
        const resolved = resolveTargetFilePath(p, cwd);
        let pathDecision: Decision = defaultAccess;
        let matchedRule: string | undefined;

        for (const rule of denyList) {
          for (const act of actionPrefixes) {
            if (rule === act) {
              pathDecision = "deny";
              matchedRule = rule;
              break;
            }
            const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
            if (m && matchesPathPattern(resolved, m[1], cwd)) {
              pathDecision = "deny";
              matchedRule = rule;
              break;
            }
          }
          if (pathDecision === "deny") break;
        }

        if (pathDecision !== "deny") {
          for (const rule of askList) {
            for (const act of actionPrefixes) {
              if (rule === act) {
                pathDecision = "ask";
                matchedRule = rule;
                break;
              }
              const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
              if (m && matchesPathPattern(resolved, m[1], cwd)) {
                pathDecision = "ask";
                matchedRule = rule;
                break;
              }
            }
            if (pathDecision === "ask") break;
          }
        }

        if (pathDecision !== "deny" && pathDecision !== "ask") {
          for (const rule of allowList) {
            for (const act of actionPrefixes) {
              if (rule === act) {
                pathDecision = "allow";
                matchedRule = rule;
                break;
              }
              const m = rule.match(new RegExp(`^${act}\\((.*)\\)$`));
              if (m && matchesPathPattern(resolved, m[1], cwd)) {
                pathDecision = "allow";
                matchedRule = rule;
                break;
              }
            }
            if (pathDecision === "allow") break;
          }
        }

        decisions.push({ path: p, decision: pathDecision, matchedRule });
      }

      const denied = decisions.find(d => d.decision === "deny");
      if (denied) {
        return {
          decision: "deny",
          reason: `Claude Permission Hook: Path '${denied.path}' denied by rule '${denied.matchedRule || "default"}'`
        };
      }

      const asked = decisions.find(d => d.decision === "ask");
      if (asked) {
        return {
          decision: "ask",
          reason: `Claude Permission Hook: Path '${asked.path}' requires confirmation by rule '${asked.matchedRule || "default"}'`
        };
      }

      if (decisions.every(d => d.decision === "allow")) {
        return { decision: "allow" };
      }
    }

    return { decision: defaultAccess, reason: `Claude Permission Hook: Default-access applied for '${tool}'` };
  }

  const isWebSearch = ["web_search", "google_search", "search", "WebSearch"].includes(tool);
  const isWebFetch = ["web_fetch", "fetch_web_page", "http_request", "WebFetch"].includes(tool);

  if (isWebSearch) {
    if (denyList.includes("WebSearch")) return { decision: "deny", reason: "Claude Permission Hook: WebSearch denied by rule" };
    if (askList.includes("WebSearch")) return { decision: "ask", reason: "Claude Permission Hook: WebSearch requires confirmation by rule" };
    if (allowList.includes("WebSearch")) return { decision: "allow" };
    return { decision: defaultAccess, reason: "Claude Permission Hook: Default-access applied for WebSearch" };
  }

  if (isWebFetch) {
    const rawUrl: string = parameters.url || parameters.target || "";
    for (const rule of denyList) {
      if (matchesWebFetchRule(rawUrl, rule)) return { decision: "deny", reason: `Claude Permission Hook: WebFetch denied by rule '${rule}'` };
    }
    for (const rule of askList) {
      if (matchesWebFetchRule(rawUrl, rule)) return { decision: "ask", reason: `Claude Permission Hook: WebFetch requires confirmation by rule '${rule}'` };
    }
    for (const rule of allowList) {
      if (matchesWebFetchRule(rawUrl, rule)) return { decision: "allow" };
    }
    return { decision: defaultAccess, reason: "Claude Permission Hook: Default-access applied for WebFetch" };
  }

  return { decision: defaultAccess, reason: `Claude Permission Hook: Fallback default-access for tool '${tool}'` };
}