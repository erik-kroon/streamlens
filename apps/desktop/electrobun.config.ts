import type { ElectrobunConfig } from "electrobun";

const webBuildDir = "../web/dist";
const bundledAgentDir = "resources/agent";

export default {
  app: {
    name: "streamlens",
    identifier: "dev.bettertstack.streamlens.desktop",
    version: "0.0.1",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      [webBuildDir]: "views/mainview",
      [bundledAgentDir]: "agent",
    },
    watch: ["../agent/cmd/streamlens-agent", "scripts"],
    watchIgnore: [`${webBuildDir}/**`],
    mac: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
  },
  scripts: {
    preBuild: "./scripts/build-agent.ts",
  },
} satisfies ElectrobunConfig;
