export type AgentState =
  | "ready"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error";

export type AgentStatus = {
  agentId: string;
  version: string;
  state: AgentState;
  startedAt: string;
  uptimeMs: number;
  liveClients: number;
  targetUrl?: string;
  lastError?: string;
  streams?: StreamStatus[];
  endpoints: Record<string, string>;
};

export type AgentError = {
  message: string;
  code?: string;
};

export type CaptureStats = {
  connections: number;
  events: number;
  retainedEvents: number;
  droppedEvents: number;
  bufferCapacity: number;
  issues: number;
  liveClients: number;
  uptimeMs: number;
  state: AgentState;
  targetUrl?: string;
  connectedAt?: string;
  activeStreams?: number;
  streams?: StreamStatus[];
};

export type StreamStatus = {
  id: string;
  url?: string;
  state: AgentState;
  lastError?: string;
  connectedAt?: string;
  connectionId?: string;
  connections: number;
  events: number;
  issues: number;
};

export type CaptureSession = {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  targetUrl?: string;
  eventCount: number;
  issueCount: number;
  retainedEventCount: number;
};

export type CaptureIssue = {
  code: string;
  severity: "info" | "warning" | "error" | string;
  message: string;
  topic?: string;
  key?: string;
  details?: unknown;
};

export type WiretapEnvelope = {
  topic: string;
  type: string;
  seq?: number;
  ts?: unknown;
  key?: string;
  symbol?: string;
  payload?: unknown;
};

export type CaptureEvent = {
  id?: string;
  streamId?: string;
  connectionId?: string;
  captureSeq: number;
  receivedAt: string;
  direction: "inbound" | string;
  opcode: "text" | "binary" | string;
  originalSizeBytes?: number;
  sizeBytes: number;
  raw?: string;
  rawBase64?: string;
  rawTruncated?: boolean;
  truncated: boolean;
  oversized: boolean;
  topic?: string;
  displayTopic?: string;
  eventType?: string;
  displayType?: string;
  key?: string;
  effectiveKey?: string;
  seq?: number;
  sourceTs?: unknown;
  envelope?: WiretapEnvelope;
  parseError?: string;
  statuses?: string[];
  issues?: CaptureIssue[];
};

export type TopicState = {
  id: string;
  streamId?: string;
  topic: string;
  key?: string;
  name: string;
  scope: "topic" | "topicKey" | string;
  count: number;
  bytes: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventId?: string;
  lastSeq?: number;
  eventsPerSec: number;
  bytesPerSec: number;
  stale: boolean;
  staleSince?: string;
  staleThresholdMs?: number | null;
  issueCount: number;
  staleCount: number;
  gapCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  parseErrorCount: number;
  schemaErrorCount: number;
};

export type ConnectRequest = {
  streamId?: string;
  url: string;
  headers: Record<string, string>;
  bearerToken: string;
  apiKeyHeader: string;
  apiKey: string;
  subprotocols: string[];
  autoReconnect: boolean;
};

export type SchemaPluginRule = {
  id: string;
  name: string;
  enabled: boolean;
  required?: string[];
  stringFields?: string[];
  numberFields?: string[];
  integerFields?: string[];
  enumFields?: Record<string, string[]>;
};

export type ExtractionRules = {
  topicPath: string;
  typePath: string;
  seqPath: string;
  timestampPath: string;
  payloadPath: string;
  keyPaths: string[];
  schemaPlugins: SchemaPluginRule[];
  sandboxBoundary: string;
};

export type AgentToUiMessage =
  | { type: "agent.ready"; payload: AgentStatus }
  | { type: "agent.error"; payload: AgentError }
  | { type: "capture.stats"; payload: CaptureStats }
  | { type: "capture.event"; payload: CaptureEvent }
  | { type: "capture.snapshot"; payload: CaptureEvent[] }
  | { type: "topic.updated"; payload: TopicState }
  | { type: "topic.snapshot"; payload: TopicState[] };

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

  if (value.type === "capture.event") {
    return isCaptureEvent(value.payload);
  }

  if (value.type === "capture.snapshot") {
    return Array.isArray(value.payload) && value.payload.every(isCaptureEvent);
  }

  if (value.type === "topic.updated") {
    return isTopicState(value.payload);
  }

  if (value.type === "topic.snapshot") {
    return Array.isArray(value.payload) && value.payload.every(isTopicState);
  }

  return false;
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.version === "string" &&
    isAgentState(value.state) &&
    typeof value.startedAt === "string" &&
    typeof value.uptimeMs === "number" &&
    typeof value.liveClients === "number" &&
    isRecord(value.endpoints)
  );
}

export function isCaptureEvent(value: unknown): value is CaptureEvent {
  return (
    isRecord(value) &&
    typeof value.captureSeq === "number" &&
    typeof value.receivedAt === "string" &&
    typeof value.direction === "string" &&
    typeof value.opcode === "string" &&
    typeof value.sizeBytes === "number" &&
    typeof value.truncated === "boolean" &&
    typeof value.oversized === "boolean"
  );
}

export function isCaptureSession(value: unknown): value is CaptureSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.schemaVersion === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.eventCount === "number" &&
    typeof value.issueCount === "number" &&
    typeof value.retainedEventCount === "number"
  );
}

function isCaptureStats(value: unknown): value is CaptureStats {
  return (
    isRecord(value) &&
    typeof value.connections === "number" &&
    typeof value.events === "number" &&
    typeof value.retainedEvents === "number" &&
    typeof value.droppedEvents === "number" &&
    typeof value.bufferCapacity === "number" &&
    typeof value.issues === "number" &&
    typeof value.liveClients === "number" &&
    typeof value.uptimeMs === "number" &&
    isAgentState(value.state)
  );
}

function isTopicState(value: unknown): value is TopicState {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.topic === "string" &&
    typeof value.name === "string" &&
    typeof value.scope === "string" &&
    typeof value.count === "number" &&
    typeof value.bytes === "number" &&
    typeof value.firstSeenAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    typeof value.eventsPerSec === "number" &&
    typeof value.bytesPerSec === "number" &&
    typeof value.stale === "boolean" &&
    typeof value.issueCount === "number" &&
    typeof value.staleCount === "number"
  );
}

function isAgentState(value: unknown): value is AgentState {
  return (
    value === "ready" ||
    value === "connecting" ||
    value === "connected" ||
    value === "disconnected" ||
    value === "reconnecting" ||
    value === "error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
