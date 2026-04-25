import { createFileRoute } from "@tanstack/solid-router";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  Radio,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
} from "lucide-solid";
import { For, Show, createMemo } from "solid-js";

import { createAgentClient, createAgentDerivedState } from "@/lib/agent-client";
import type { AgentStatus } from "@/lib/agent-protocol";

export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  const agent = createAgentClient();
  const agentView = createAgentDerivedState(agent);

  const endpoints = createMemo(() => {
    const status = agent.status();
    return status ? Object.entries(status.endpoints) : [];
  });

  return (
    <main class="min-h-0 bg-neutral-950 text-neutral-100">
      <div class="grid h-full min-h-0 grid-rows-[auto_1fr_auto]">
        <section class="border-b border-neutral-800 bg-neutral-950/95 px-4 py-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-3">
              <div class="flex size-9 shrink-0 items-center justify-center rounded-md border border-cyan-400/35 bg-cyan-400/10 text-cyan-200">
                <Radio size={18} />
              </div>
              <div class="min-w-0">
                <h1 class="truncate text-base font-semibold tracking-normal">Wiretap</h1>
                <p class="truncate text-xs text-neutral-400">Local agent protocol shell</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <StatusPill online={agentView.isOnline()} label={agentView.statusLabel()} />
              <button
                type="button"
                class="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 hover:border-neutral-500 hover:bg-neutral-800"
                onClick={agent.reconnect}
                title="Reconnect to local agent"
              >
                <RefreshCw size={15} />
                Reconnect
              </button>
            </div>
          </div>
        </section>

        <section class="grid min-h-0 grid-cols-1 grid-rows-[auto_auto_1fr_auto] lg:grid-cols-[280px_minmax(0,1fr)_340px] lg:grid-rows-[auto_1fr]">
          <AgentPanel
            phase={agent.phase()}
            error={agent.error()}
            status={agent.status()}
            lastMessageAt={agent.lastMessageAt()}
            httpUrl={agent.httpUrl}
            liveUrl={agent.liveUrl}
            endpoints={endpoints()}
          />

          <div class="min-h-0 border-b border-neutral-800 bg-neutral-950 lg:col-start-2 lg:border-x lg:border-b-0">
            <PanelHeader
              icon={Database}
              title="Captured Events"
              detail="Waiting for upstream capture"
            />
            <div class="grid h-[320px] min-h-0 grid-rows-[auto_1fr] lg:h-full">
              <div class="grid grid-cols-[88px_1fr_120px_120px] border-b border-neutral-800 px-3 py-2 text-xs font-medium uppercase text-neutral-500">
                <span>Seq</span>
                <span>Topic</span>
                <span>Status</span>
                <span>Received</span>
              </div>
              <EmptyState
                icon={Activity}
                title="No captured events yet"
                detail="This slice confirms agent readiness. Upstream capture lands next."
              />
            </div>
          </div>

          <div class="min-h-0 border-b border-neutral-800 bg-neutral-950 lg:col-start-3 lg:border-b-0">
            <PanelHeader icon={Server} title="Payload Inspector" detail="No event selected" />
            <EmptyState
              icon={Server}
              title="Select an event"
              detail="Payload, parsed envelope, and raw frame details will render here."
            />
          </div>

          <div class="border-b border-neutral-800 bg-neutral-950 lg:col-start-1 lg:row-start-2 lg:border-b-0">
            <PanelHeader icon={Activity} title="Topics" detail="Placeholder" />
            <EmptyState
              icon={Activity}
              title="No topics active"
              detail="Topic freshness and issue counts will appear after capture starts."
            />
          </div>
        </section>

        <footer class="border-t border-neutral-800 bg-neutral-950 px-4 py-2">
          <div class="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
            <div class="flex items-center gap-2 text-emerald-300">
              <Activity size={14} />
              <span>Agent status protocol active</span>
            </div>
            <span class="text-neutral-700">/</span>
            <span>Issue strip ready for stream diagnostics</span>
          </div>
        </footer>
      </div>
    </main>
  );
}

type AgentPanelProps = {
  phase: string;
  error: string | undefined;
  status: AgentStatus | undefined;
  lastMessageAt: Date | undefined;
  httpUrl: string;
  liveUrl: string;
  endpoints: [string, string][];
};

function AgentPanel(props: AgentPanelProps) {
  return (
    <aside class="border-b border-neutral-800 bg-neutral-950 lg:row-span-2 lg:border-b-0">
      <PanelHeader icon={Wifi} title="Agent Connection" detail={props.phase} />
      <div class="space-y-4 p-4">
        <div class="rounded-md border border-neutral-800 bg-neutral-900/70 p-3">
          <div class="mb-3 flex items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase text-neutral-500">Current Status</span>
            <StatusPill online={props.phase === "ready"} label={props.phase} compact />
          </div>
          <dl class="grid gap-3 text-sm">
            <Metric label="Agent ID" value={props.status?.agentId ?? "Unavailable"} />
            <Metric label="Version" value={props.status?.version ?? "Unknown"} />
            <Metric label="Uptime" value={formatUptime(props.status?.uptimeMs)} />
            <Metric label="Last message" value={formatTime(props.lastMessageAt)} />
          </dl>
        </div>

        <Show when={props.error}>
          {(message) => (
            <div class="flex gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
              <AlertTriangle class="mt-0.5 shrink-0" size={16} />
              <span>{message()}</span>
            </div>
          )}
        </Show>

        <div class="space-y-2">
          <div class="flex items-center gap-2 text-xs font-medium uppercase text-neutral-500">
            <Clock3 size={13} />
            Endpoints
          </div>
          <EndpointRow label="health" value={`${props.httpUrl}/health`} />
          <EndpointRow label="live" value={props.liveUrl} />
          <For each={props.endpoints.filter(([label]) => label !== "health" && label !== "live")}>
            {([label, value]) => <EndpointRow label={label} value={value} />}
          </For>
        </div>
      </div>
    </aside>
  );
}

function StatusPill(props: { online: boolean; label: string; compact?: boolean }) {
  const Icon = props.online ? Wifi : WifiOff;
  return (
    <div
      class={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm ${
        props.online
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
          : "border-neutral-700 bg-neutral-900 text-neutral-300"
      } ${props.compact ? "h-7 text-xs" : ""}`}
    >
      <Icon size={props.compact ? 13 : 15} />
      <span class="max-w-[220px] truncate">{props.label}</span>
    </div>
  );
}

function PanelHeader(props: { icon: typeof Activity; title: string; detail: string }) {
  const Icon = props.icon;
  return (
    <div class="flex h-12 items-center justify-between gap-3 border-b border-neutral-800 px-4">
      <div class="flex min-w-0 items-center gap-2">
        <Icon class="shrink-0 text-neutral-400" size={16} />
        <h2 class="truncate text-sm font-medium">{props.title}</h2>
      </div>
      <span class="truncate text-xs text-neutral-500">{props.detail}</span>
    </div>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="grid gap-1">
      <dt class="text-xs text-neutral-500">{props.label}</dt>
      <dd class="truncate font-mono text-xs text-neutral-200">{props.value}</dd>
    </div>
  );
}

function EndpointRow(props: { label: string; value: string }) {
  return (
    <div class="grid gap-1 rounded-md border border-neutral-800 bg-neutral-900/50 p-2">
      <span class="text-xs text-neutral-500">{props.label}</span>
      <span class="truncate font-mono text-xs text-neutral-300">{props.value}</span>
    </div>
  );
}

function EmptyState(props: { icon: typeof Activity; title: string; detail: string }) {
  const Icon = props.icon;
  return (
    <div class="flex min-h-[180px] flex-col items-center justify-center gap-2 p-6 text-center">
      <div class="flex size-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-500">
        <Icon size={17} />
      </div>
      <h3 class="text-sm font-medium text-neutral-200">{props.title}</h3>
      <p class="max-w-[280px] text-sm leading-5 text-neutral-500">{props.detail}</p>
    </div>
  );
}

function formatUptime(value: number | undefined): string {
  if (value === undefined) {
    return "Unavailable";
  }

  const totalSeconds = Math.floor(value / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatTime(value: Date | undefined): string {
  return value?.toLocaleTimeString() ?? "Never";
}
