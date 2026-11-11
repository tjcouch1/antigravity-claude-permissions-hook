import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

export const START_TAG = "<!-- CLAUDE-PERMISSIONS-HOOK:START -->";
export const END_TAG = "<!-- CLAUDE-PERMISSIONS-HOOK:END -->";
export const HOOK_NAME = "claude-permissions-bridge";

export interface SetupResult {
  targetDir: string;
  targetHookPath: string;
  targetHooksJsonPath: string;
  command: string;
}

/**
 * Installs or updates the Claude permissions hook into `targetDir`.
 * Exported so the test suite can verify the generated files directly.
 */
export function setupTargetRepository(targetDirInput: string, repoRoot = DEFAULT_REPO_ROOT): SetupResult {
  const targetDir = path.resolve(process.cwd(), targetDirInput);
  const sourceHookPath = path.join(repoRoot, "src", "claude-permissions.ts");
  const sourceReadmePath = path.join(repoRoot, "README.md");

  if (!fs.existsSync(sourceHookPath)) {
    throw new Error(`Source hook file not found at: ${sourceHookPath}`);
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. Copy hook script to <target>/.agents/hooks/claude-permissions.ts
  const targetAgentsHooksDir = path.join(targetDir, ".agents", "hooks");
  fs.mkdirSync(targetAgentsHooksDir, { recursive: true });

  const targetHookPath = path.join(targetAgentsHooksDir, "claude-permissions.ts");
  fs.copyFileSync(sourceHookPath, targetHookPath);

  // 2. Register hook in <target>/.agents/hooks.json using Antigravity's exact schema
  // Schema: { "<hook-name>": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "...", "timeout": 10 } ] } ] } }
  const targetHooksJsonPath = path.join(targetDir, ".agents", "hooks.json");
  let hooksConfig: Record<string, any> = {};

  if (fs.existsSync(targetHooksJsonPath)) {
    const existingRaw = fs.readFileSync(targetHooksJsonPath, "utf8").trim();
    if (existingRaw.length > 0) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Root of hooks.json is not a JSON object");
        }
        hooksConfig = parsed;
      } catch (err: any) {
        throw new Error(
          `Refusing to overwrite existing malformed ${targetHooksJsonPath}: ${err?.message || err}`
        );
      }
    }
  }

  const normalizedAbsHookPath = targetHookPath.replace(/\\/g, "/");
  const hookCommand = `node "${normalizedAbsHookPath}"`;

  hooksConfig[HOOK_NAME] = {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: hookCommand,
            timeout: 10
          }
        ]
      }
    ]
  };

  fs.writeFileSync(targetHooksJsonPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");

  // 3. Update <target>/.gitignore to ignore hook audit logs
  const targetGitignorePath = path.join(targetDir, ".gitignore");
  const gitignoreEntry = ".agents/hooks/*.log";

  if (fs.existsSync(targetGitignorePath)) {
    const gitignoreContent = fs.readFileSync(targetGitignorePath, "utf8");
    if (!gitignoreContent.includes(gitignoreEntry)) {
      const updatedGitignore =
        gitignoreContent.trimEnd() + `\n\n# Antigravity permissions hook audit log\n${gitignoreEntry}\n`;
      fs.writeFileSync(targetGitignorePath, updatedGitignore, "utf8");
    }
  } else {
    fs.writeFileSync(targetGitignorePath, `# Antigravity permissions hook audit log\n${gitignoreEntry}\n`, "utf8");
  }

  // 4. Scrape demarcated block from source README.md and inject/update in <target>/README.md
  if (fs.existsSync(sourceReadmePath)) {
    const sourceReadme = fs.readFileSync(sourceReadmePath, "utf8");
    const blockRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
    const match = sourceReadme.match(blockRegex);

    if (match) {
      const docSection = match[0];
      const targetReadmePath = path.join(targetDir, "README.md");

      if (fs.existsSync(targetReadmePath)) {
        const currentReadme = fs.readFileSync(targetReadmePath, "utf8");
        const targetRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
        if (targetRegex.test(currentReadme)) {
          fs.writeFileSync(targetReadmePath, currentReadme.replace(targetRegex, docSection), "utf8");
        } else {
          fs.writeFileSync(targetReadmePath, currentReadme.trimEnd() + `\n\n${docSection}\n`, "utf8");
        }
      } else {
        fs.writeFileSync(targetReadmePath, `# Project\n\n${docSection}\n`, "utf8");
      }
    }
  }

  return {
    targetDir,
    targetHookPath,
    targetHooksJsonPath,
    command: hookCommand
  };
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
  const cliArgs = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const targetDirInput = cliArgs[0] || ".";
  try {
    const res = setupTargetRepository(targetDirInput);
    console.log(`✓ Installed hook -> ${res.targetHookPath}`);
    console.log(`✓ Configured PreToolUse in -> ${res.targetHooksJsonPath}`);
    console.log(`✓ Command registered -> ${res.command}`);
  } catch (err: any) {
    console.error(`Setup failed: ${err?.message || err}`);
    process.exit(1);
  }
}