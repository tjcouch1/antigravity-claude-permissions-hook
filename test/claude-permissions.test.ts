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
  extractShellWriteTargets,
  ClaudeSettings,
} from "../src/claude-permissions.js";

describe("1. Antigravity Payload Contract & Decision Mapping", () => {
  const baseSettings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "ask",
    "agy-cli-permission-hook-arbitrary-command-execution": "deny",
    permissions: {
      deny: [
        "Bash(rm -rf:*)",
        "Read(./secrets/**)",
        "Edit(.claude/settings.json)",
      ],
      ask: ["Bash(npm publish:*)"],
      allow: [
        "Bash(git status)",
        "Read",
        "Edit",
        "WebSearch",
        "WebFetch(github.com:*)",
      ],
    },
  };

  it("reads Antigravity's native { toolCall: { name, args }, workspacePaths } payload", () => {
    const res = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "git status" },
        },
        workspacePaths: ["/workspace/app"],
      },
      baseSettings,
    );
    expect(res.decision).toBe("auto_approve");
  });

  it("NEVER allows an empty or missing CommandLine in run_command", () => {
    const emptyRes = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: "   " } },
        workspacePaths: ["/workspace/app"],
      },
      { ...baseSettings, "agy-cli-permission-hook-default-access": "allow" },
    );
    expect(emptyRes.decision).toBe("deny");

    const missingRes = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: {} },
        workspacePaths: ["/workspace/app"],
      },
      { ...baseSettings, "agy-cli-permission-hook-default-access": "allow" },
    );
    expect(missingRes.decision).toBe("deny");
  });

  it("maps Antigravity file, search, and web tools and parameters accurately", () => {
    const cwd = "/workspace/app";

    // view_file with AbsolutePath -> denied by Read(./secrets/**)
    const viewSecret = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: "/workspace/app/secrets/api.key" },
        },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(viewSecret.decision).toBe("deny");

    // list_dir with DirectoryPath -> denied by Read(./secrets/**)
    const listSecret = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "list_dir",
          args: { DirectoryPath: "/workspace/app/secrets" },
        },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(listSecret.decision).toBe("deny");

    // write_to_file & replace_file_content with TargetFile -> denied by Edit(.claude/settings.json)
    const writeSettings = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: "/workspace/app/.claude/settings.json" },
        },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(writeSettings.decision).toBe("deny");

    const replaceSettings = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "replace_file_content",
          args: { TargetFile: "/workspace/app/.claude/settings.json" },
        },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(replaceSettings.decision).toBe("deny");

    // search_web -> auto_approve
    const searchWeb = evaluateRequestWithSettings(
      {
        toolCall: { name: "search_web", args: { query: "vitest docs" } },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(searchWeb.decision).toBe("auto_approve");

    // read_url_content with Url -> auto_approve for github.com, force_ask for unknown
    const readGithub = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "read_url_content",
          args: { Url: "https://api.github.com/zen" },
        },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(readGithub.decision).toBe("auto_approve");

    const readOther = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "read_url_content",
          args: { Url: "https://example.com" },
        },
        workspacePaths: [cwd],
      },
      baseSettings,
    );
    expect(readOther.decision).toBe("force_ask");
  });

  it("maps 'ask' to 'force_ask' and sanitizes invalid/typo settings values", () => {
    const askRes = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: "npm publish" } },
        workspacePaths: ["/workspace/app"],
      },
      baseSettings,
    );
    expect(askRes.decision).toBe("force_ask");

    // Invalid typo "Deny" should never pass through raw; must normalize safely
    const typoSettings: any = {
      "agy-cli-permission-hook-default-access": "Deny",
      "agy-cli-permission-hook-arbitrary-command-execution": "Allow",
      permissions: {},
    };
    const fallbackRes = evaluateRequestWithSettings(
      {
        toolCall: { name: "unknown_tool", args: {} },
        workspacePaths: ["/workspace/app"],
      },
      typoSettings,
    );
    expect(fallbackRes.decision).toBe("force_ask");

    const arbTypoRes = evaluateRequestWithSettings(
      {
        toolCall: { name: "run_command", args: { CommandLine: "echo $(id)" } },
        workspacePaths: ["/workspace/app"],
      },
      typoSettings,
    );
    expect(["deny", "force_ask"]).toContain(arbTypoRes.decision);
  });
});

describe("2. Wrapper & Env-Var Isolation (Deny/Ask vs Allow)", () => {
  const settings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "ask",
    "agy-cli-permission-hook-arbitrary-command-execution": "deny",
    permissions: {
      deny: ["Bash(rm -rf:*)"],
      ask: ["Bash(git push:*)"],
      allow: ["Bash(git status)", "Bash(npm test:*)"],
    },
  };

  it("does NOT strip wrappers or env vars when matching ALLOW rules", () => {
    const cases = [
      "sudo git status",
      "doas git status",
      "LD_PRELOAD=/tmp/evil.so git status",
      "PAGER=/tmp/evil git status",
      "GIT_SSH_COMMAND='ssh -i /tmp/k' git status",
      "NODE_OPTIONS=--require=./evil.js npm test",
    ];

    for (const cmd of cases) {
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        settings,
      );
      expect(res.decision).not.toBe("auto_approve");
    }
  });

  it("DOES strip wrappers, env vars, quotes, and binary paths when matching DENY and ASK rules", () => {
    const denyCases = [
      "/bin/rm -rf /",
      "/usr/bin/rm -rf /tmp/foo",
      "sudo rm -rf /",
      "sudo -u root rm -rf /",
      "env rm -rf /",
      "env -i FOO=bar rm -rf /",
      "timeout 5 rm -rf /",
      "timeout -s KILL 10 rm -rf /",
      "setsid rm -rf /",
      "chroot /mnt rm -rf /",
      "watch -n 1 rm -rf /",
      "script -c 'rm -rf /'",
      "nohup rm -rf /",
      "nice -n 10 rm -rf /",
      "\\rm -rf /",
      "'rm' -rf /",
    ];

    for (const cmd of denyCases) {
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        settings,
      );
      expect(res.decision).toBe("deny");
    }

    const askRes = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "sudo /usr/bin/git push origin feature" },
        },
      },
      settings,
    );
    expect(askRes.decision).toBe("force_ask");
  });
});

describe("3. Multi-Subcommand Arbitrary Execution & Interpreter Bypasses", () => {
  const allowAllBashSettings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "ask",
    "agy-cli-permission-hook-arbitrary-command-execution": "deny",
    permissions: {
      allow: ["Bash"],
    },
  };

  it("checks arbitrary execution on EVERY subcommand in a chain", () => {
    const chains = [
      "true && bash -c 'id'",
      'ls; eval "$x"',
      "git log | xargs rm",
      "echo ok || python3 -c 'import os'",
    ];

    for (const cmd of chains) {
      const res = evaluateRequestWithSettings(
        { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
        allowAllBashSettings,
      );
      expect(res.decision).toBe("deny");
      expect(res.reason).toContain("Arbitrary command execution detected");
    }
  });

  it("catches all dangerous git flags including compact -c and -C combinations", () => {
    const dangerousGit = [
      "git -c alias.x='!id' x",
      "git -c core.sshCommand='evil' fetch",
      "git -c core.fsmonitor=evil status",
      "git -c core.hooksPath=/tmp/hooks commit",
      "git -c credential.helper='!evil' pull",
      "git -ccore.pager=evil log",
      "git -C /repo -c core.editor=evil commit",
      "git --config-env=core.pager=MY_PAGER log",
      "git --upload-pack=evil clone repo",
      "git --receive-pack=evil push",
    ];

    for (const cmd of dangerousGit) {
      expect(checkArbitraryExecution(cmd).detected).toBe(true);
    }

    // Safe git -C (uppercase directory change) must NOT be falsely flagged
    expect(checkArbitraryExecution("git -C /repo status").detected).toBe(false);
  });

  it("catches full-path binaries, clustered shell flags, versioned interpreters, and tool execs", () => {
    const bypassAttempts = [
      "/bin/bash -c 'id'",
      "bash -lc 'id'",
      "sh -ec 'id'",
      "python3.12 -c 'print(1)'",
      "node --eval 'process.exit()'",
      "node -p '1+1'",
      "perl -E 'say 1'",
      "ruby -e 'puts 1'",
      "php -r 'echo 1;'",
      "pwsh -c 'Get-Process'",
      "powershell.exe -EncodedCommand UwB0AGEAcgB0AA==",
      "busybox sh -c 'id'",
      "awk '{system(\"id\")}' file.txt",
      "sed 's/a/b/e' file.txt",
      "tar -I gzip -xf archive.tar",
      "tar --use-compress-program=evil -xf archive.tar",
      "tar --to-command evil -xf archive.tar",
      "bash <<EOF\nid\nEOF",
    ];

    for (const cmd of bypassAttempts) {
      expect(checkArbitraryExecution(cmd).detected).toBe(true);
    }
  });
});

describe("4. Self-Protection of Settings, Hooks & Shell Redirections", () => {
  const permissiveSettings: ClaudeSettings = {
    "agy-cli-permission-hook-default-access": "allow",
    "agy-cli-permission-hook-arbitrary-command-execution": "ask",
    permissions: {
      deny: ["Edit(.env)"],
      allow: ["Bash", "Edit", "Write"],
    },
  };

  it("never auto-approves edits to .claude/settings*.json, .agents/hooks.json, or .agents/hooks/**", () => {
    const cwd = "/workspace/project";
    const protectedTargets = [
      "/workspace/project/.claude/settings.json",
      "/workspace/project/.claude/settings.local.json",
      "/workspace/project/.agents/hooks.json",
      "/workspace/project/.agents/hooks/claude-permissions.ts",
    ];

    for (const target of protectedTargets) {
      const res = evaluateRequestWithSettings(
        {
          toolCall: { name: "write_to_file", args: { TargetFile: target } },
          workspacePaths: [cwd],
        },
        permissiveSettings,
      );
      expect(res.decision).toBe("force_ask");
    }
  });

  it("intercepts shell output redirections (>, >>, tee) against Edit/Write and self-protection rules", () => {
    const cwd = "/workspace/project";

    // Redirecting to denied Edit(.env) -> deny
    const redirectDenied = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo SECRET=1 > .env" },
        },
        workspacePaths: [cwd],
      },
      permissiveSettings,
    );
    expect(redirectDenied.decision).toBe("deny");

    // Redirecting to .claude/settings.local.json -> force_ask
    const redirectSettings = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: {
            CommandLine:
              'echo \'{"permissions":{"allow":["Bash"]}}\' > .claude/settings.local.json',
          },
        },
        workspacePaths: [cwd],
      },
      permissiveSettings,
    );
    expect(redirectSettings.decision).toBe("force_ask");

    // Piping into tee .agents/hooks/claude-permissions.ts -> force_ask
    const teeHook = evaluateRequestWithSettings(
      {
        toolCall: {
          name: "run_command",
          args: {
            CommandLine:
              "cat payload.ts | tee .agents/hooks/claude-permissions.ts",
          },
        },
        workspacePaths: [cwd],
      },
      permissiveSettings,
    );
    expect(teeHook.decision).toBe("force_ask");
  });
});

describe("5. Path Semantics (/ vs //), Gitignore Depth, Symlinks & Global Settings", () => {
  it("distinguishes settings-relative /path from filesystem-absolute //path", () => {
    const cwd = "/workspace/app";

    // /secrets/** is relative to workspace root
    expect(
      matchesPathPattern("/workspace/app/secrets/key.pem", "/secrets/**", cwd),
    ).toBe(true);
    expect(matchesPathPattern("/secrets/key.pem", "/secrets/**", cwd)).toBe(
      false,
    );

    // //etc/** is filesystem-absolute
    expect(matchesPathPattern("/etc/passwd", "//etc/**", cwd)).toBe(true);
    expect(
      matchesPathPattern("/workspace/app/etc/passwd", "//etc/**", cwd),
    ).toBe(false);

    // //c/Users/... is Windows drive absolute
    expect(
      matchesPathPattern(
        "C:\\Users\\tj_co\\roms\\oot.z64",
        "//c/Users/tj_co/roms/**",
        cwd,
      ),
    ).toBe(true);
    expect(
      matchesPathPattern(
        "/mnt/c/Users/tj_co/roms/oot.z64",
        "//c/Users/tj_co/roms/**",
        cwd,
      ),
    ).toBe(true);
  });

  it("matches patterns without slashes at any directory depth (gitignore semantics)", () => {
    const cwd = "/workspace/app";

    // No slash: matches at root AND nested directories
    expect(matchesPathPattern("/workspace/app/.env", ".env", cwd)).toBe(true);
    expect(matchesPathPattern("/workspace/app/config/.env", ".env", cwd)).toBe(
      true,
    );
    expect(
      matchesPathPattern("/workspace/app/packages/api/.env", ".env", cwd),
    ).toBe(true);

    // Explicit ./ slash: anchored to workspace root only
    expect(matchesPathPattern("/workspace/app/.env", "./.env", cwd)).toBe(true);
    expect(
      matchesPathPattern("/workspace/app/config/.env", "./.env", cwd),
    ).toBe(false);
  });

  describe("Symlink resolution & global settings merging on real filesystem", () => {
    let tmpDir: string;
    let workspaceDir: string;
    let secretDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-perm-test-"));
      workspaceDir = path.join(tmpDir, "workspace");
      secretDir = path.join(tmpDir, "outside-secrets");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(secretDir, { recursive: true });
      fs.writeFileSync(path.join(secretDir, "id_rsa"), "PRIVATE KEY", "utf8");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolves symlinks inside the workspace pointing to denied targets outside", () => {
      const symlinkPath = path.join(workspaceDir, "innocent-link");
      fs.symlinkSync(path.join(secretDir, "id_rsa"), symlinkPath);

      const settings: ClaudeSettings = {
        "agy-cli-permission-hook-default-access": "allow",
        permissions: {
          deny: [
            `Read(//${normalizeUniversalPath(secretDir).replace(/^\/+/, "")}/**)`,
          ],
          allow: ["Read"],
        },
      };

      const res = evaluateRequestWithSettings(
        {
          toolCall: { name: "view_file", args: { AbsolutePath: symlinkPath } },
          workspacePaths: [workspaceDir],
        },
        settings,
      );
      expect(res.decision).toBe("deny");
    });

    it("merges global user settings with project settings", () => {
      const fakeHome = path.join(tmpDir, "home");
      fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });

      fs.writeFileSync(
        path.join(fakeHome, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Bash(curl:*)"],
          },
        }),
        "utf8",
      );

      fs.writeFileSync(
        path.join(workspaceDir, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash"],
          },
        }),
        "utf8",
      );

      const merged = loadMergedClaudeSettings(workspaceDir, fakeHome);
      const res = evaluateRequestWithSettings(
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: "curl https://example.com" },
          },
          workspacePaths: [workspaceDir],
        },
        merged,
      );
      expect(res.decision).toBe("deny");
    });
  });
});
