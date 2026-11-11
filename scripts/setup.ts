import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_HOOK_PATH = path.join(REPO_ROOT, "src", "claude-permissions.ts");
const SOURCE_README_PATH = path.join(REPO_ROOT, "README.md");

const START_TAG = "<!-- CLAUDE-PERMISSIONS-HOOK:START -->";
const END_TAG = "<!-- CLAUDE-PERMISSIONS-HOOK:END -->";

// ----------------------------------------------------------------------------
// 1. Resolve Target Directory from CLI Arguments
// ----------------------------------------------------------------------------
const cliArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const targetDirInput = cliArgs[0] || ".";
const TARGET_DIR = path.resolve(process.cwd(), targetDirInput);

console.log(`\n======================================================`);
console.log(` Antigravity Permissions Hook: Target Setup`);
console.log(`======================================================`);
console.log(`Source Repo Root : ${REPO_ROOT}`);
console.log(`Target Directory : ${TARGET_DIR}\n`);

if (!fs.existsSync(SOURCE_HOOK_PATH)) {
  console.error(`Error: Source hook file not found at: ${SOURCE_HOOK_PATH}`);
  process.exit(1);
}

if (!fs.existsSync(TARGET_DIR)) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

// ----------------------------------------------------------------------------
// 2. Copy Hook Script (.agents/hooks/claude-permissions.ts)
// ----------------------------------------------------------------------------
const targetAgentsHooksDir = path.join(TARGET_DIR, ".agents", "hooks");
fs.mkdirSync(targetAgentsHooksDir, { recursive: true });

const targetHookPath = path.join(targetAgentsHooksDir, "claude-permissions.ts");
fs.copyFileSync(SOURCE_HOOK_PATH, targetHookPath);
console.log(`✓ Installed hook -> ${path.relative(TARGET_DIR, targetHookPath)}`);

// ----------------------------------------------------------------------------
// 3. Register Hook in Target (.agents/hooks.json) Using Antigravity Schema
// ----------------------------------------------------------------------------
const targetHooksJsonPath = path.join(TARGET_DIR, ".agents", "hooks.json");
let hooksConfig: { hooks?: { PreToolUse?: any[]; [key: string]: any } } = {
  hooks: {},
};

if (fs.existsSync(targetHooksJsonPath)) {
  try {
    hooksConfig = JSON.parse(fs.readFileSync(targetHooksJsonPath, "utf8"));
    if (!hooksConfig.hooks) hooksConfig.hooks = {};
  } catch (err: any) {
    console.warn(
      `! Existing hooks.json could not be parsed (${err.message}). Creating fresh config.`,
    );
    hooksConfig = { hooks: {} };
  }
}

if (!Array.isArray(hooksConfig.hooks!.PreToolUse)) {
  hooksConfig.hooks!.PreToolUse = [];
}

// Antigravity CLI hook handler schema: { type: "command", command: string, timeout?: number }
const hookHandler = {
  type: "command",
  command: "node .agents/hooks/claude-permissions.ts",
  timeout: 10,
};

const existingIndex = hooksConfig.hooks!.PreToolUse.findIndex(
  (h: any) =>
    typeof h?.command === "string" &&
    h.command.includes("claude-permissions.ts"),
);

if (existingIndex >= 0) {
  hooksConfig.hooks!.PreToolUse[existingIndex] = hookHandler;
  console.log(
    `✓ Updated existing PreToolUse entry in ${path.relative(TARGET_DIR, targetHooksJsonPath)}`,
  );
} else {
  hooksConfig.hooks!.PreToolUse.push(hookHandler);
  console.log(
    `✓ Added PreToolUse entry to ${path.relative(TARGET_DIR, targetHooksJsonPath)}`,
  );
}

fs.writeFileSync(
  targetHooksJsonPath,
  JSON.stringify(hooksConfig, null, 2) + "\n",
  "utf8",
);

// ----------------------------------------------------------------------------
// 4. Update Target .gitignore
// ----------------------------------------------------------------------------
const targetGitignorePath = path.join(TARGET_DIR, ".gitignore");
const gitignoreEntry = ".agents/hooks/*.log";

if (fs.existsSync(targetGitignorePath)) {
  const gitignoreContent = fs.readFileSync(targetGitignorePath, "utf8");
  if (!gitignoreContent.includes(gitignoreEntry)) {
    const updatedGitignore =
      gitignoreContent.trimEnd() +
      `\n\n# Antigravity permissions hook audit log\n${gitignoreEntry}\n`;
    fs.writeFileSync(targetGitignorePath, updatedGitignore, "utf8");
    console.log(`✓ Added '${gitignoreEntry}' to target .gitignore`);
  }
} else {
  fs.writeFileSync(
    targetGitignorePath,
    `# Antigravity permissions hook audit log\n${gitignoreEntry}\n`,
    "utf8",
  );
  console.log(`✓ Created target .gitignore containing '${gitignoreEntry}'`);
}

// ----------------------------------------------------------------------------
// 5. Scrape Demarcated Documentation from README.md & Sync to Target README.md
// ----------------------------------------------------------------------------
if (fs.existsSync(SOURCE_README_PATH)) {
  const sourceReadme = fs.readFileSync(SOURCE_README_PATH, "utf8");
  const blockRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
  const match = sourceReadme.match(blockRegex);

  if (match) {
    const docSection = match[0];
    const targetReadmePath = path.join(TARGET_DIR, "README.md");

    if (fs.existsSync(targetReadmePath)) {
      const currentReadme = fs.readFileSync(targetReadmePath, "utf8");
      const targetRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
      if (targetRegex.test(currentReadme)) {
        fs.writeFileSync(
          targetReadmePath,
          currentReadme.replace(targetRegex, docSection),
          "utf8",
        );
        console.log(
          `✓ Updated hook documentation block in ${path.relative(TARGET_DIR, targetReadmePath)}`,
        );
      } else {
        fs.writeFileSync(
          targetReadmePath,
          currentReadme.trimEnd() + `\n\n${docSection}\n`,
          "utf8",
        );
        console.log(
          `✓ Appended hook documentation block to ${path.relative(TARGET_DIR, targetReadmePath)}`,
        );
      }
    } else {
      fs.writeFileSync(
        targetReadmePath,
        `# Project\n\n${docSection}\n`,
        "utf8",
      );
      console.log(
        `✓ Created ${path.relative(TARGET_DIR, targetReadmePath)} with hook documentation`,
      );
    }
  } else {
    console.warn(
      `! Markers ${START_TAG} .. ${END_TAG} not found in ${SOURCE_README_PATH}`,
    );
  }
}

console.log(`\nSetup completed successfully!\n`);
