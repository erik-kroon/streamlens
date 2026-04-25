import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";

import { BrowserWindow, PATHS, Updater, type WindowOptionsType } from "electrobun/bun";

const DEV_SERVER_PORT = 3001;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const PREFERRED_AGENT_PORT = 8790;
const PREFERRED_DEMO_PORT = 8791;
const AGENT_HOST = "127.0.0.1";
export const TRAFFIC_LIGHT_POSITION = {
  x: 14,
  y: 15,
} as const;

type TrafficLightPosition = typeof TRAFFIC_LIGHT_POSITION;
type WindowOptionsWithTrafficLights = Partial<WindowOptionsType> & {
  trafficLightOffset: TrafficLightPosition;
};
type TrafficLightWindow = BrowserWindow & {
  setTrafficLightOffset?: (position: TrafficLightPosition) => void;
};

type DesktopAgent = {
  process: ReturnType<typeof Bun.spawn>;
  httpUrl: string;
  demoHttpUrl: string;
  demoWsUrl: string;
};

// Check if the web dev server is running for HMR
async function getMainViewUrl(agent: DesktopAgent): Promise<string> {
  const channel = await Updater.localInfo.channel();
  const params = new URLSearchParams({
    agentUrl: agent.httpUrl,
    demoHttpUrl: agent.demoHttpUrl,
    demoWsUrl: agent.demoWsUrl,
  });

  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using web dev server at ${DEV_SERVER_URL}`);
      return `${DEV_SERVER_URL}?${params.toString()}`;
    } catch {
      console.log('Web dev server not running. Run "bun run dev:hmr" for HMR support.');
    }
  }

  return `views://mainview/index.html?${params.toString()}`;
}

const agent = await startAgent();
const url = await getMainViewUrl(agent);

const windowOptions = {
  title: "wiretap",
  url,
  frame: {
    width: 1280,
    height: 820,
    x: 120,
    y: 120,
  },
  titleBarStyle: "hiddenInset",
  trafficLightOffset: TRAFFIC_LIGHT_POSITION,
} satisfies WindowOptionsWithTrafficLights;

const window = new BrowserWindow(windowOptions);
(window as TrafficLightWindow).setTrafficLightOffset?.(TRAFFIC_LIGHT_POSITION);

window.on("close", () => stopAgent(agent, "window closed"));
process.on("SIGINT", () => stopAgent(agent, "SIGINT"));
process.on("SIGTERM", () => stopAgent(agent, "SIGTERM"));
process.on("exit", () => stopAgent(agent, "process exit"));

console.log(`Electrobun desktop shell started with agent at ${agent.httpUrl}.`);

async function startAgent(): Promise<DesktopAgent> {
  const agentPort = await findAvailablePort(PREFERRED_AGENT_PORT);
  const demoPort = await findAvailablePort(PREFERRED_DEMO_PORT, agentPort);
  const httpUrl = `http://${AGENT_HOST}:${agentPort}`;
  const demoHttpUrl = `http://${AGENT_HOST}:${demoPort}`;
  const demoWsUrl = `ws://${AGENT_HOST}:${demoPort}`;
  const dataDir = resolveDataDir();
  await mkdir(dataDir, { recursive: true });

  const command = resolveAgentCommand();
  console.log(`Starting Wiretap agent from ${command.label}.`);

  const child = Bun.spawn(
    [
      ...command.argv,
      "-addr",
      `${AGENT_HOST}:${agentPort}`,
      "-demo-addr",
      `${AGENT_HOST}:${demoPort}`,
      "-data-dir",
      dataDir,
    ],
    {
      cwd: command.cwd,
      env: {
        ...process.env,
        WIRETAP_DATA_DIR: dataDir,
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      onExit: (_process, exitCode, signalCode, error) => {
        if (error) {
          console.error("Wiretap agent failed:", error);
        } else if (exitCode !== 0) {
          console.error(`Wiretap agent exited with code ${exitCode} signal ${signalCode ?? ""}`);
        }
      },
    },
  );

  try {
    await waitForAgentHealth(httpUrl);
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    process: child,
    httpUrl,
    demoHttpUrl,
    demoWsUrl,
  };
}

function stopAgent(agent: DesktopAgent, reason: string) {
  if (agent.process.killed) {
    return;
  }

  console.log(`Stopping Wiretap agent: ${reason}.`);
  agent.process.kill();
}

function resolveAgentCommand(): { argv: string[]; cwd?: string; label: string } {
  const binaryName = process.platform === "win32" ? "wiretap-agent.exe" : "wiretap-agent";
  const bundledAgentPath = resolve(PATHS.VIEWS_FOLDER, "..", "agent", binaryName);
  if (existsSync(bundledAgentPath)) {
    return { argv: [bundledAgentPath], label: bundledAgentPath };
  }

  const sourceBuiltAgentPath = resolve(import.meta.dir, "..", "..", "resources", "agent", binaryName);
  if (existsSync(sourceBuiltAgentPath)) {
    return { argv: [sourceBuiltAgentPath], label: sourceBuiltAgentPath };
  }

  const sourceAgentDir = resolve(import.meta.dir, "..", "..", "..", "agent");
  if (existsSync(resolve(sourceAgentDir, "go.mod"))) {
    return {
      argv: ["go", "run", "./cmd/wiretap-agent"],
      cwd: sourceAgentDir,
      label: `${sourceAgentDir} via go run`,
    };
  }

  throw new Error("Unable to locate the bundled Wiretap agent.");
}

function resolveDataDir(): string {
  const envDataDir = process.env.WIRETAP_DATA_DIR?.trim();
  if (envDataDir) {
    return resolve(envDataDir);
  }

  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Wiretap");
  }
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA ?? homedir(), "Wiretap");
  }
  return resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "wiretap");
}

async function findAvailablePort(preferredPort: number, reservedPort?: number): Promise<number> {
  if (preferredPort !== reservedPort && (await canListen(preferredPort))) {
    return preferredPort;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await allocateEphemeralPort();
    if (port !== reservedPort) {
      return port;
    }
  }

  throw new Error("failed to allocate a local port");
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen({ host: AGENT_HOST, port }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: AGENT_HOST, port: 0 }, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("failed to allocate a local port"));
        }
      });
    });
  });
}

async function waitForAgentHealth(httpUrl: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting; the agent may still be binding its HTTP listener.
    }
    await Bun.sleep(100);
  }

  throw new Error(`Wiretap agent did not become healthy at ${httpUrl}`);
}
