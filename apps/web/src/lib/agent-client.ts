import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { type AgentStatus, isAgentStatus, isAgentToUiMessage } from "@/lib/agent-protocol";

const DEFAULT_AGENT_HTTP_URL = "http://localhost:8790";
const RECONNECT_DELAY_MS = 1_500;

export type AgentClientPhase = "connecting" | "ready" | "disconnected" | "error";

export type AgentClientState = {
  status: () => AgentStatus | undefined;
  phase: () => AgentClientPhase;
  lastMessageAt: () => Date | undefined;
  error: () => string | undefined;
  httpUrl: string;
  liveUrl: string;
  reconnect: () => void;
};

export function createAgentClient(): AgentClientState {
  const httpUrl = normalizeHttpUrl(import.meta.env.VITE_WIRETAP_AGENT_URL);
  const liveUrl = `${httpUrl.replace(/^http/, "ws")}/live`;

  const [status, setStatus] = createSignal<AgentStatus>();
  const [phase, setPhase] = createSignal<AgentClientPhase>("connecting");
  const [lastMessageAt, setLastMessageAt] = createSignal<Date>();
  const [error, setError] = createSignal<string>();

  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
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
          setError(undefined);
        } else if (parsed.type === "agent.error") {
          setPhase("error");
          setError(parsed.payload.message);
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
    closeSocket();
  });

  return {
    status,
    phase,
    lastMessageAt,
    error,
    httpUrl,
    liveUrl,
    reconnect: connect,
  };
}

export function createAgentDerivedState(client: Pick<AgentClientState, "phase" | "status">) {
  return {
    isOnline: createMemo(() => client.phase() === "ready"),
    statusLabel: createMemo(() => {
      const currentStatus = client.status();
      if (client.phase() === "ready" && currentStatus) {
        return `${currentStatus.state} / ${currentStatus.liveClients} live client${currentStatus.liveClients === 1 ? "" : "s"}`;
      }

      return client.phase();
    }),
  };
}

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_AGENT_HTTP_URL;
  }

  return value.replace(/\/$/, "");
}
