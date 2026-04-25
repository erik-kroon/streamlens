export type AgentState = "ready";

export type AgentStatus = {
  agentId: string;
  version: string;
  state: AgentState;
  startedAt: string;
  uptimeMs: number;
  liveClients: number;
  endpoints: Record<string, string>;
};

export type AgentError = {
  message: string;
  code?: string;
};

export type CaptureStats = {
  connections: number;
  events: number;
  issues: number;
  liveClients: number;
  uptimeMs: number;
};

export type AgentToUiMessage =
  | { type: "agent.ready"; payload: AgentStatus }
  | { type: "agent.error"; payload: AgentError }
  | { type: "capture.stats"; payload: CaptureStats };

export function isAgentToUiMessage(value: unknown): value is AgentToUiMessage {
  if (!isRecord(value) || typeof value.type !== "string" || !("payload" in value)) {
    return false;
  }

  if (value.type === "agent.ready") {
    return isAgentStatus(value.payload);
  }

  if (value.type === "agent.error") {
    return isRecord(value.payload) && typeof value.payload.message === "string";
  }

  if (value.type === "capture.stats") {
    return isCaptureStats(value.payload);
  }

  return false;
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.version === "string" &&
    value.state === "ready" &&
    typeof value.startedAt === "string" &&
    typeof value.uptimeMs === "number" &&
    typeof value.liveClients === "number" &&
    isRecord(value.endpoints)
  );
}

function isCaptureStats(value: unknown): value is CaptureStats {
  return (
    isRecord(value) &&
    typeof value.connections === "number" &&
    typeof value.events === "number" &&
    typeof value.issues === "number" &&
    typeof value.liveClients === "number" &&
    typeof value.uptimeMs === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
