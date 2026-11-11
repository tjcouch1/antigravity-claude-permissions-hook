import { describe, it, expect } from "vitest";
import {
  matchesBashRule,
  splitCompoundCommands,
  checkArbitraryExecution,
  normalizeUniversalPath,
  matchesPathPattern,
  matchesWebFetchRule,
  evaluateRequestWithSettings,
  ClaudeSettings
} from "../src/claude-permissions.js";

describe("Claude Permission Hook: Shell Rule Matchers", () => {
  it("verifies exact command matching: Bash(command)", () => {
    const rule = "Bash(git status)";
    expect(matchesBashRule("git status", rule)).toBe(true);
    expect(matchesBashRule("git status -s", rule)).toBe(false);
    expect(matchesBashRule("git status --short", rule)).toBe(false);
  });

  it("verifies delimited prefix matching: Bash(command:*) enforces word boundaries", () => {
    const rule = "Bash(npm test:*)";
    expect(matchesBashRule("npm test", rule)).toBe(true);
    expect(matchesBashRule("npm test --watch", rule)).toBe(true);
    expect(matchesBashRule("npm test/unit", rule)).toBe(true);
    // Boundary check: must NOT match commands with different suffixes
    expect(matchesBashRule("npm testrun", rule)).toBe(false);
    expect(matchesBashRule("npm testing", rule)).toBe(false);
  });

  it("verifies glob matching: Bash(cmd*) across arbitrary substrings", () => {
    const rule = "Bash(git push origin master*)";
    expect(matchesBashRule("git push origin master", rule)).toBe(true);
    expect(matchesBashRule("git push origin master:main", rule)).toBe(true);
    expect(matchesBashRule("git push origin master-fix", rule)).toBe(true);
    expect(matchesBashRule("git push origin feature", rule)).toBe(false);
  });

  it("verifies wildcard argument rules: Bash(git commit -m:*)", () => {
    const rule = "Bash(git commit -m:*)";
    expect(matchesBashRule("git commit -m 'Initial commit'", rule)).toBe(true);
    expect(matchesBashRule("git commit --amend", rule)).toBe(false);
  });
});

describe("Compound & Aggregated Command Splitting", () => {
  it("splits commands across operators (&&, ||, ;, |, &)", () => {
    const cmd = "git status && git diff || echo fail; cat log | grep error &";
    const subCommands = splitCompoundCommands(cmd);
    expect(subCommands).toEqual([
      "git status",
      "git diff",
      "echo fail",
      "cat log",
      "grep error"
    ]);
  });

  it("preserves compound operators inside quotes", () => {
    const cmd = 'git commit -m "feat: add && update logic; test || pass" && git push';
    const subCommands = splitCompoundCommands(cmd);
    expect(subCommands).toEqual([
      'git commit -m "feat: add && update logic; test || pass"',
      "git push"
    ]);
  });

  it("splits multiline commands containing newlines and comments", () => {
    const cmd = "echo line1\n# this is a comment\necho line2";
    const subCommands = splitCompoundCommands(cmd);
    expect(subCommands).toEqual(["echo line1", "echo line2"]);
  });

  it("unwraps parenthetical subshell and POSIX brace groups", () => {
    const cmd = "(rm -rf /) && { npm test; }";
    const subCommands = splitCompoundCommands(cmd);
    expect(subCommands).toEqual(["rm -rf /", "npm test"]);
  });
});

describe("Arbitrary Command Execution Detection", () => {
  it("detects command substitutions: $(...) and backticks", () => {
    expect(checkArbitraryExecution("echo $(cat /etc/passwd)").detected).toBe(true);
    expect(checkArbitraryExecution("echo `id`").detected).toBe(true);
  });

  it("ignores $(...) inside literal single quotes", () => {
    expect(checkArbitraryExecution("git commit -m 'Fixed $(err) bug'").detected).toBe(false);
  });

  it("detects process and arithmetic substitutions", () => {
    expect(checkArbitraryExecution("diff <(ls -a) <(ls -b)").detected).toBe(true);
    expect(checkArbitraryExecution("echo $((1 + 2))").detected).toBe(true);
    expect(checkArbitraryExecution("echo $[1 + 2]").detected).toBe(true);
  });

  it("detects brace expansion", () => {
    expect(checkArbitraryExecution("rm -rf {a,b,c}").detected).toBe(true);
    expect(checkArbitraryExecution("cat file{1..5}.txt").detected).toBe(true);
    // Non-expansion literal braces
    expect(checkArbitraryExecution("echo {hello}").detected).toBe(false);
  });

  it("detects socket redirections and file descriptor manipulation", () => {
    expect(checkArbitraryExecution("cat /dev/tcp/127.0.0.1/8080").detected).toBe(true);
    expect(checkArbitraryExecution("cmd >&2").detected).toBe(true);
  });

  it("detects dangerous subcommand flags in tools", () => {
    expect(checkArbitraryExecution("git -c core.pager=rm status").detected).toBe(true);
    expect(checkArbitraryExecution("tar --to-command=evil -xvf file.tar").detected).toBe(true);
    expect(checkArbitraryExecution("find . -name '*.txt' -exec rm {} +").detected).toBe(true);
    expect(checkArbitraryExecution("xargs rm").detected).toBe(true);
    expect(checkArbitraryExecution("python3 -c 'import os; os.system(\"ls\")'").detected).toBe(true);
  });
});

describe("Cross-Platform Path Normalization", () => {
  it("canonicalizes Windows, WSL, UNC, and POSIX style paths to uniform format", () => {
    expect(normalizeUniversalPath("C:\\Users\\alice\\roms\\game.z64")).toBe("/c/Users/alice/roms/game.z64");
    expect(normalizeUniversalPath("/mnt/c/Users/alice/roms/game.z64")).toBe("/c/Users/alice/roms/game.z64");
    expect(normalizeUniversalPath("//c/Users/alice/roms/game.z64")).toBe("/c/Users/alice/roms/game.z64");
    expect(normalizeUniversalPath("//wsl.localhost/Ubuntu/home/alice/repo")).toBe("//wsl.localhost/Ubuntu/home/alice/repo");
  });

  it("matches recursive directory globs across platforms", () => {
    const rule = "//c/Users/tj_co/roms/**";
    const winTarget = "C:\\Users\\tj_co\\roms\\oot\\baserom.z64";
    const wslTarget = "/mnt/c/Users/tj_co/roms/oot/baserom.z64";
    const gitBashTarget = "//c/Users/tj_co/roms/oot/baserom.z64";

    expect(matchesPathPattern(winTarget, rule, "/c")).toBe(true);
    expect(matchesPathPattern(wslTarget, rule, "/c")).toBe(true);
    expect(matchesPathPattern(gitBashTarget, rule, "/c")).toBe(true);
  });

  it("guards directory root when pattern ends with /**", () => {
    const rule = "./secrets/**";
    const cwd = "/workspace/project";

    // Both inner files and the base directory itself must match
    expect(matchesPathPattern("/workspace/project/secrets/key.pem", rule, cwd)).toBe(true);
    expect(matchesPathPattern("/workspace/project/secrets", rule, cwd)).toBe(true);
    expect(matchesPathPattern("/workspace/project/other", rule, cwd)).toBe(false);
  });
});

describe("WebFetch Domain Filters", () => {
  it("matches exact domains and wildcard subdomains", () => {
    expect(matchesWebFetchRule("https://api.github.com/v1/repos", "WebFetch(github.com:*)")).toBe(true);
    expect(matchesWebFetchRule("https://github.com/profile", "WebFetch(github.com:*)")).toBe(true);
    expect(matchesWebFetchRule("https://notgithub.com", "WebFetch(github.com:*)")).toBe(false);
    expect(matchesWebFetchRule("https://registry.npmjs.org/vitest", "WebFetch(registry.npmjs.org)")).toBe(true);
  });
});

describe("End-to-End Decision Evaluation with Precedence", () => {
  const settings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "ask",
    "agy-cli-permission-hook-arbitrary-command-execution": "deny",
    permissions: {
      deny: [
        "Bash(rm -rf /)",
        "Bash(rm -rf /*)",
        "Bash(git push origin main)",
        "Bash(git checkout main && git push)",
        "Read(./secrets/**)",
        "Edit(.claude/settings.json)",
        "WebFetch(malicious.org:*)"
      ],
      ask: [
        "Bash(npm publish:*)",
        "Bash(git reset --hard:*)"
      ],
      allow: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "WebSearch",
        "WebFetch(github.com:*)"
      ]
    }
  };

  it("Denies composite commands matching exact deny rules even if Bash is allowed", () => {
    const res = evaluateRequestWithSettings(
      { tool: "run_command", parameters: { command: "git checkout main && git push" } },
      settings
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("denied by rule");
  });

  it("Denies compound line if any individual subcommand is denied", () => {
    const res = evaluateRequestWithSettings(
      { tool: "run_command", parameters: { command: "echo starting && rm -rf /" } },
      settings
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("rm -rf /");
  });

  it("Forces ask if any subcommand requires confirmation", () => {
    const res = evaluateRequestWithSettings(
      { tool: "run_command", parameters: { command: "git status && npm publish --access public" } },
      settings
    );
    expect(res.decision).toBe("ask");
    expect(res.reason).toContain("npm publish --access public");
  });

  it("Overrides decisions with deny when arbitrary execution is detected", () => {
    const res = evaluateRequestWithSettings(
      { tool: "run_command", parameters: { command: "echo $(whoami)" } },
      settings
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("Arbitrary command execution detected");
  });

  it("Protects sensitive paths from Read operations", () => {
    const res = evaluateRequestWithSettings(
      {
        tool: "read_file",
        parameters: { file_path: "./secrets/id_rsa" },
        context: { cwd: "/workspace" }
      },
      settings
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("denied by rule");
  });

  it("Enforces WebFetch domain restrictions", () => {
    const blocked = evaluateRequestWithSettings(
      { tool: "web_fetch", parameters: { url: "https://malicious.org/payload" } },
      settings
    );
    expect(blocked.decision).toBe("deny");

    const allowed = evaluateRequestWithSettings(
      { tool: "web_fetch", parameters: { url: "https://api.github.com/repos" } },
      settings
    );
    expect(allowed.decision).toBe("allow");
  });
});