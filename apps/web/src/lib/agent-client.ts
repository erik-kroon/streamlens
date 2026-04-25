import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  type AgentStatus,
  type CaptureEvent,
  type CaptureStats,
  type ConnectRequest,
  type TopicState,
  isAgentStatus,
  isAgentToUiMessage,
} from "@/lib/agent-protocol";

const DEFAULT_AGENT_HTTP_URL = "http://localhost:8790";
const RECONNECT_DELAY_MS = 1_500;
const MAX_UI_EVENTS = 10_000;

export type AgentClientPhase = "connecting" | "ready" | "disconnected" | "error";

export type AgentClientState = {
  status: () => AgentStatus | undefined;
  stats: () => CaptureStats | undefined;
  events: () => CaptureEvent[];
  topics: () => TopicState[];
  phase: () => AgentClientPhase;
  lastMessageAt: () => Date | undefined;
  error: () => string | undefined;
  httpUrl: string;
  liveUrl: string;
  reconnect: () => void;
  connectUpstream: (request: ConnectRequest) => Promise<void>;
  disconnectUpstream: () => Promise<void>;
  reconnectUpstream: () => Promise<void>;
  clearCapture: () => Promise<void>;
  exportJSONL: () => Promise<void>;
};

export function createAgentClient(): AgentClientState {
  const httpUrl = normalizeHttpUrl(import.meta.env.VITE_WIRETAP_AGENT_URL);
  const liveUrl = `${httpUrl.replace(/^http/, "ws")}/live`;

  const [status, setStatus] = createSignal<AgentStatus>();
  const [stats, setStats] = createSignal<CaptureStats>();
  const [events, setEvents] = createSignal<CaptureEvent[]>([]);
  const [topics, setTopics] = createSignal<TopicState[]>([]);
  const [phase, setPhase] = createSignal<AgentClientPhase>("connecting");
  const [lastMessageAt, setLastMessageAt] = createSignal<Date>();
  const [error, setError] = createSignal<string>();

  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let eventFlushFrame: number | undefined;
  let queuedEvents: CaptureEvent[] = [];
  let disposed = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const closeSocket = () => {
    socket?.close();
    socket = undefined;
  };

  const cancelEventFlush = () => {
    if (eventFlushFrame !== undefined) {
      window.cancelAnimationFrame(eventFlushFrame);
      eventFlushFrame = undefined;
    }
  };

  const flushQueuedEvents = () => {
    eventFlushFrame = undefined;
    if (queuedEvents.length === 0) {
      return;
    }

    const nextEvents = queuedEvents;
    queuedEvents = [];
    setEvents((current) => [...current, ...nextEvents].slice(-MAX_UI_EVENTS));
  };

  const enqueueEvent = (event: CaptureEvent) => {
    queuedEvents.push(event);
    if (eventFlushFrame === undefined) {
      eventFlushFrame = window.requestAnimationFrame(flushQueuedEvents);
    }
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  const readHealth = async () => {
    try {
      const response = await fetch(`${httpUrl}/health`);
      if (!response.ok) {
        throw new Error(`health returned ${response.status}`);
      }

      const payload: unknown = await response.json();
      if (!isAgentStatus(payload)) {
        throw new Error("health returned an invalid agent status");
      }

      setStatus(payload);
      setLastMessageAt(new Date());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "health request failed");
    }
  };

  const postControl = async (path: string, body?: unknown) => {
    const response = await fetch(`${httpUrl}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `${path} returned ${response.status}`;
      throw new Error(message);
    }
  };

  const downloadJSONL = async () => {
    const response = await fetch(`${httpUrl}/export/jsonl`);
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `export returned ${response.status}`;
      throw new Error(message);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename();
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  function connect() {
    clearReconnectTimer();
    closeSocket();
    setPhase("connecting");

    const currentSocket = new WebSocket(liveUrl);
    socket = currentSocket;

    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) {
        return;
      }

      setError(undefined);
    });

    currentSocket.addEventListener("message", (event) => {
      if (socket !== currentSocket) {
        return;
      }

      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!isAgentToUiMessage(parsed)) {
          throw new Error("received an invalid agent protocol message");
        }

        setLastMessageAt(new Date());
        if (parsed.type === "agent.ready") {
          setStatus(parsed.payload);
          setPhase("ready");
          setError(parsed.payload.lastError);
        } else if (parsed.type === "agent.error") {
          setPhase("error");
          setError(parsed.payload.message);
        } else if (parsed.type === "capture.stats") {
          setStats(parsed.payload);
        } else if (parsed.type === "capture.snapshot") {
          queuedEvents = [];
          cancelEventFlush();
          setEvents(parsed.payload);
        } else if (parsed.type === "capture.event") {
          enqueueEvent(parsed.payload);
        } else if (parsed.type === "topic.snapshot") {
          setTopics(parsed.payload);
        } else if (parsed.type === "topic.updated") {
          setTopics((current) => {
            const index = current.findIndex((topic) => topic.id === parsed.payload.id);
            if (index === -1) {
              return [...current, parsed.payload];
            }
            const next = current.slice();
            next[index] = parsed.payload;
            return next;
          });
        }
      } catch (caught) {
        setPhase("error");
        setError(caught instanceof Error ? caught.message : "failed to parse agent message");
      }
    });

    currentSocket.addEventListener("error", () => {
      if (socket !== currentSocket) {
        return;
      }

      setPhase("error");
      setError("agent live socket is unavailable");
    });

    currentSocket.addEventListener("close", () => {
      if (disposed || socket !== currentSocket) {
        return;
      }

      setPhase(status() ? "disconnected" : "error");
      scheduleReconnect();
    });
  }

  onMount(() => {
    void readHealth();
    connect();
  });

  onCleanup(() => {
    disposed = true;
    clearReconnectTimer();
    queuedEvents = [];
    cancelEventFlush();
    closeSocket();
  });

  return {
    status,
    stats,
    events,
    topics,
    phase,
    lastMessageAt,
    error,
    httpUrl,
    liveUrl,
    reconnect: connect,
    connectUpstream: async (request) => {
      setError(undefined);
      await postControl("/connect", request);
    },
    disconnectUpstream: async () => {
      setError(undefined);
      await postControl("/disconnect");
    },
    reconnectUpstream: async () => {
      setError(undefined);
      await postControl("/reconnect");
    },
    clearCapture: async () => {
      setError(undefined);
      await postControl("/clear");
      setEvents([]);
      setTopics([]);
    },
    exportJSONL: async () => {
      setError(undefined);
      await downloadJSONL();
    },
  };
}

export function createAgentDerivedState(
  client: Pick<AgentClientState, "phase" | "status" | "stats">,
) {
  return {
    isOnline: createMemo(() => client.phase() === "ready"),
    isUpstreamConnected: createMemo(() => client.stats()?.state === "connected"),
    statusLabel: createMemo(() => {
      const status = client.status();
      const stats = client.stats();
      if (client.phase() !== "ready") {
        return client.phase();
      }
      if (stats) {
        return stats.state;
      }
      return status?.state ?? "ready";
    }),
    targetLabel: createMemo(
      () => client.stats()?.targetUrl ?? client.status()?.targetUrl ?? "No upstream",
    ),
  };
}

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_AGENT_HTTP_URL;
  }

  return value.replace(/\/$/, "");
}

function exportFilename(): string {
  return `wiretap-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
}
