import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  type AgentStatus,
  type CaptureEventPage,
  type CaptureEvent,
  type CaptureSession,
  type CaptureStats,
  type ConnectRequest,
  type ExtractionRules,
  type TopicState,
  isAgentStatus,
  isAgentToUiMessage,
  isCaptureSession,
} from "@/lib/agent-protocol";

const DEFAULT_AGENT_HTTP_URL = "http://localhost:8790";
const RECONNECT_DELAY_MS = 1_500;
const MAX_UI_EVENTS = 10_000;
const EVENT_FLUSH_INTERVAL_MS = 50;

export type AgentClientPhase = "connecting" | "ready" | "disconnected" | "error";

export type AgentClientState = {
  status: () => AgentStatus | undefined;
  stats: () => CaptureStats | undefined;
  currentSession: () => CaptureSession | undefined;
  sessions: () => CaptureSession[];
  events: () => CaptureEvent[];
  topics: () => TopicState[];
  phase: () => AgentClientPhase;
  lastMessageAt: () => Date | undefined;
  error: () => string | undefined;
  httpUrl: string;
  liveUrl: string;
  reconnect: () => void;
  connectUpstream: (request: ConnectRequest) => Promise<void>;
  disconnectUpstream: (streamId?: string) => Promise<void>;
  reconnectUpstream: (streamId?: string) => Promise<void>;
  clearCapture: () => Promise<void>;
  exportJSONL: () => Promise<void>;
  exportTape: () => Promise<void>;
  importJSONL: (file: File) => Promise<void>;
  refreshSessions: () => Promise<void>;
  openSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  exportSessionJSONL: (sessionId: string) => Promise<void>;
  exportSessionTape: (sessionId: string) => Promise<void>;
  readSessionEvents: (sessionId: string) => Promise<CaptureEvent[]>;
  readExtractionRules: () => Promise<ExtractionRules>;
  saveExtractionRules: (rules: ExtractionRules) => Promise<ExtractionRules>;
};

export function createAgentClient(): AgentClientState {
  const httpUrl = normalizeHttpUrl(configuredAgentHttpUrl());
  const liveUrl = `${httpUrl.replace(/^http/, "ws")}/live`;

  const [status, setStatus] = createSignal<AgentStatus>();
  const [stats, setStats] = createSignal<CaptureStats>();
  const [currentSession, setCurrentSession] = createSignal<CaptureSession>();
  const [sessions, setSessions] = createSignal<CaptureSession[]>([]);
  const [events, setEvents] = createSignal<CaptureEvent[]>([]);
  const [topics, setTopics] = createSignal<TopicState[]>([]);
  const [phase, setPhase] = createSignal<AgentClientPhase>("connecting");
  const [lastMessageAt, setLastMessageAt] = createSignal<Date>();
  const [error, setError] = createSignal<string>();

  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (eventFlushTimer !== undefined) {
      clearTimeout(eventFlushTimer);
      eventFlushTimer = undefined;
    }
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
    if (eventFlushTimer === undefined && eventFlushFrame === undefined) {
      eventFlushTimer = setTimeout(() => {
        eventFlushTimer = undefined;
        eventFlushFrame = window.requestAnimationFrame(flushQueuedEvents);
      }, EVENT_FLUSH_INTERVAL_MS);
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

  const readSessions = async () => {
    const [sessionsResponse, currentResponse] = await Promise.all([
      fetch(`${httpUrl}/sessions`),
      fetch(`${httpUrl}/sessions/current`),
    ]);

    if (!sessionsResponse.ok) {
      throw new Error(`sessions returned ${sessionsResponse.status}`);
    }
    if (!currentResponse.ok) {
      throw new Error(`current session returned ${currentResponse.status}`);
    }

    const sessionPayload: unknown = await sessionsResponse.json();
    const currentPayload: unknown = await currentResponse.json();
    if (!Array.isArray(sessionPayload) || !sessionPayload.every(isCaptureSession)) {
      throw new Error("sessions returned invalid capture sessions");
    }
    if (!isCaptureSession(currentPayload)) {
      throw new Error("current session returned an invalid capture session");
    }
    setSessions(sessionPayload);
    setCurrentSession(currentPayload);
  };

  const downloadFile = async (path: string, filename: string) => {
    const response = await fetch(`${httpUrl}${path}`);
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
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const uploadJSONL = async (file: File) => {
    const formData = new FormData();
    formData.set("capture", file);
    const response = await fetch(`${httpUrl}/import/jsonl`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `import returned ${response.status}`;
      throw new Error(message);
    }
  };

  const readSessionEvents = async (sessionId: string) => {
    const limit = 1_000;
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    const events: CaptureEvent[] = [];

    while (offset < total) {
      const response = await fetch(
        `${httpUrl}/sessions/${encodeURIComponent(sessionId)}/events?offset=${offset}&limit=${limit}`,
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message =
          payload && typeof payload === "object" && "message" in payload
            ? String((payload as { message: unknown }).message)
            : `session events returned ${response.status}`;
        throw new Error(message);
      }

      const page = (await response.json()) as CaptureEventPage;
      if (!Array.isArray(page.events) || typeof page.total !== "number") {
        throw new Error("session events returned an invalid event page");
      }
      events.push(...page.events);
      total = page.total;
      offset += page.events.length;
      if (page.events.length === 0) {
        break;
      }
    }

    return events;
  };

  const readExtractionRules = async () => {
    const response = await fetch(`${httpUrl}/extraction-rules`);
    if (!response.ok) {
      throw new Error(`extraction rules returned ${response.status}`);
    }
    return (await response.json()) as ExtractionRules;
  };

  const saveExtractionRules = async (rules: ExtractionRules) => {
    const response = await fetch(`${httpUrl}/extraction-rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rules),
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `extraction rules returned ${response.status}`;
      throw new Error(message);
    }
    return (await response.json()) as ExtractionRules;
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
    void readSessions().catch((caught) =>
      setError(caught instanceof Error ? caught.message : "session request failed"),
    );
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
    currentSession,
    sessions,
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
    disconnectUpstream: async (streamId) => {
      setError(undefined);
      await postControl(streamControlPath("/disconnect", streamId));
    },
    reconnectUpstream: async (streamId) => {
      setError(undefined);
      await postControl(streamControlPath("/reconnect", streamId));
    },
    clearCapture: async () => {
      setError(undefined);
      await postControl("/clear");
      await readSessions();
      setEvents([]);
      setTopics([]);
    },
    exportJSONL: async () => {
      setError(undefined);
      await downloadFile("/export/jsonl", exportFilename("capture", "jsonl"));
    },
    exportTape: async () => {
      setError(undefined);
      await downloadFile("/export/tape", exportFilename("capture", "tape"));
    },
    importJSONL: async (file) => {
      setError(undefined);
      await uploadJSONL(file);
      await readSessions();
    },
    refreshSessions: async () => {
      setError(undefined);
      await readSessions();
    },
    openSession: async (sessionId) => {
      setError(undefined);
      await postControl(`/sessions/${encodeURIComponent(sessionId)}/open`);
      await readSessions();
    },
    deleteSession: async (sessionId) => {
      setError(undefined);
      const response = await fetch(`${httpUrl}/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message =
          payload && typeof payload === "object" && "message" in payload
            ? String((payload as { message: unknown }).message)
            : `delete session returned ${response.status}`;
        throw new Error(message);
      }
      await readSessions();
    },
    exportSessionJSONL: async (sessionId) => {
      setError(undefined);
      await downloadFile(
        `/sessions/${encodeURIComponent(sessionId)}/export/jsonl`,
        exportFilename(sessionId, "jsonl"),
      );
    },
    exportSessionTape: async (sessionId) => {
      setError(undefined);
      await downloadFile(
        `/sessions/${encodeURIComponent(sessionId)}/export/tape`,
        exportFilename(sessionId, "tape"),
      );
    },
    readSessionEvents,
    readExtractionRules,
    saveExtractionRules,
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

function configuredAgentHttpUrl(): string | undefined {
  const queryValue = runtimeQueryValue("agentUrl");
  if (queryValue) {
    return queryValue;
  }

  return import.meta.env.VITE_WIRETAP_AGENT_URL;
}

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_AGENT_HTTP_URL;
  }

  return value.replace(/\/$/, "");
}

function runtimeQueryValue(name: string): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const value = new URLSearchParams(window.location.search).get(name)?.trim();
  return value || undefined;
}

function exportFilename(label: string, extension: "jsonl" | "tape"): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `wiretap-${safeLabel}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

function streamControlPath(path: string, streamId: string | undefined): string {
  if (!streamId) {
    return path;
  }
  return `${path}?streamId=${encodeURIComponent(streamId)}`;
}
