import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const targetOS = process.env.ELECTROBUN_OS ?? platformToGoOS(process.platform);
const targetArch = process.env.ELECTROBUN_ARCH ?? archToGoArch(process.arch);
const binaryName =
  targetOS === "windows" || targetOS === "win" ? "streamlens-agent.exe" : "streamlens-agent";
const outputPath = resolve("resources", "agent", binaryName);
const agentDir = resolve("..", "agent");

mkdirSync(dirname(outputPath), { recursive: true });

const result = Bun.spawnSync(["go", "build", "-o", outputPath, "./cmd/streamlens-agent"], {
  cwd: agentDir,
  env: {
    ...process.env,
    GOOS: normalizeGoOS(targetOS),
    GOARCH: archToGoArch(targetArch),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

if (result.exitCode !== 0) {
  throw new Error(`failed to build StreamLens agent for ${targetOS}/${targetArch}`);
}

if (!binaryName.endsWith(".exe")) {
  chmodSync(outputPath, 0o755);
}

console.log(`Built StreamLens agent: ${outputPath}`);

function normalizeGoOS(value: string): string {
  if (value === "macos" || value === "darwin") {
    return "darwin";
  }
  if (value === "win" || value === "windows") {
    return "windows";
  }
  return value;
}

function platformToGoOS(value: NodeJS.Platform): string {
  if (value === "darwin") {
    return "darwin";
  }
  if (value === "win32") {
    return "windows";
  }
  return "linux";
}

function archToGoArch(value: string): string {
  if (value === "x64" || value === "amd64") {
    return "amd64";
  }
  if (value === "arm64" || value === "aarch64") {
    return "arm64";
  }
  return value;
}
