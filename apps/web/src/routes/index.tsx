import { createFileRoute } from "@tanstack/solid-router";
import {
  Activity,
  AlertTriangle,
  Ban,
  Clock3,
  Database,
  Eraser,
  Link,
  PlugZap,
  Radio,
  RefreshCw,
  Search,
  Server,
  Wifi,
  WifiOff,
} from "lucide-solid";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Component } from "solid-js";

import { createAgentClient, createAgentDerivedState } from "@/lib/agent-client";
import type { AgentStatus, CaptureEvent, CaptureIssue, CaptureStats } from "@/lib/agent-protocol";

export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  const agent = createAgentClient();
  const agentView = createAgentDerivedState(agent);
  const [targetUrl, setTargetUrl] = createSignal("ws://localhost:8791/stream");
  const [headersText, setHeadersText] = createSignal("");
  const [bearerToken, setBearerToken] = createSignal("");
  const [apiKeyHeader, setApiKeyHeader] = createSignal("x-api-key");
  const [apiKey, setApiKey] = createSignal("");
  const [subprotocols, setSubprotocols] = createSignal("");
  const [autoReconnect, setAutoReconnect] = createSignal(false);
  const [selectedSeq, setSelectedSeq] = createSignal<number>();
  const [filter, setFilter] = createSignal("");
  const [controlError, setControlError] = createSignal<string>();

  const events = createMemo(() => agent.events());
  const selectedEvent = createMemo(() => {
    const selected = selectedSeq();
    return events().find((event) => event.captureSeq === selected) ?? events().at(-1);
  });
  const filteredEvents = createMemo(() => {
    const query = filter().trim().toLowerCase();
    const captureOrdered = [...events()].sort((a, b) => a.captureSeq - b.captureSeq);
    if (query === "") {
      return captureOrdered;
    }
    return captureOrdered.filter((event) =>
      [
        event.captureSeq,
        event.displayTopic,
        event.topic,
        event.displayType,
        event.eventType,
        event.effectiveKey,
        event.raw,
        event.rawBase64,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  });
  const topics = createMemo(() => summarizeTopics(events()));
  const endpoints = createMemo(() => {
    const status = agent.status();
    return status ? Object.entries(status.endpoints) : [];
  });

  const runControl = async (action: () => Promise<void>) => {
    setControlError(undefined);
    try {
      await action();
    } catch (caught) {
      setControlError(caught instanceof Error ? caught.message : "agent control failed");
    }
  };

  const connect = () =>
    runControl(() =>
      agent.connectUpstream({
        url: targetUrl(),
        headers: parseHeaders(headersText()),
        bearerToken: bearerToken(),
        apiKeyHeader: apiKeyHeader(),
        apiKey: apiKey(),
        subprotocols: subprotocols()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        autoReconnect: autoReconnect(),
      }),
    );

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
                <p class="truncate text-xs text-neutral-400">{agentView.targetLabel()}</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <StatusPill online={agentView.isOnline()} label={agentView.statusLabel()} />
              <IconTextButton icon={Ban} label="Disconnect" onClick={() => runControl(agent.disconnectUpstream)} />
              <IconTextButton icon={Link} label="Reconnect UI" onClick={agent.reconnect} />
            </div>
          </div>
        </section>

        <section class="grid min-h-0 grid-cols-1 grid-rows-[auto_minmax(340px,1fr)_minmax(300px,40vh)_auto] lg:grid-cols-[300px_minmax(0,1fr)_360px] lg:grid-rows-[minmax(0,1fr)_260px]">
          <AgentPanel
            phase={agent.phase()}
            error={controlError() ?? agent.error()}
            status={agent.status()}
            stats={agent.stats()}
            lastMessageAt={agent.lastMessageAt()}
            httpUrl={agent.httpUrl}
            liveUrl={agent.liveUrl}
            endpoints={endpoints()}
            targetUrl={targetUrl()}
            setTargetUrl={setTargetUrl}
            headersText={headersText()}
            setHeadersText={setHeadersText}
            bearerToken={bearerToken()}
            setBearerToken={setBearerToken}
            apiKeyHeader={apiKeyHeader()}
            setApiKeyHeader={setApiKeyHeader}
            apiKey={apiKey()}
            setApiKey={setApiKey}
            subprotocols={subprotocols()}
            setSubprotocols={setSubprotocols}
            autoReconnect={autoReconnect()}
            setAutoReconnect={setAutoReconnect}
            connect={connect}
            reconnect={() => runControl(agent.reconnectUpstream)}
          />

          <section class="grid min-h-0 grid-rows-[auto_auto_1fr] border-b border-neutral-800 bg-neutral-950 lg:col-start-2 lg:border-x lg:border-b-0">
            <PanelHeader
              icon={Database}
              title="Captured Events"
              detail={`${formatCount(filteredEvents().length)} shown / ${formatCount(events().length)} retained`}
            />
            <div class="flex min-w-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
              <div class="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/70 px-3 text-neutral-500">
                <Search size={15} />
                <input
                  class="min-w-0 flex-1 bg-transparent font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
                  placeholder="Filter seq, topic, key, raw..."
                  value={filter()}
                  onInput={(event) => setFilter(event.currentTarget.value)}
                />
              </div>
              <IconTextButton icon={Eraser} label="Clear" onClick={() => runControl(agent.clearCapture)} />
            </div>
            <VirtualEventTable
              connected={agentView.isUpstreamConnected()}
              events={filteredEvents()}
              selectedSeq={selectedEvent()?.captureSeq}
              onSelect={setSelectedSeq}
            />
          </section>

          <aside class="grid min-h-0 grid-rows-[auto_1fr] border-b border-neutral-800 bg-neutral-950 lg:col-start-3 lg:border-b-0">
            <PanelHeader
              icon={Server}
              title="Payload Inspector"
              detail={selectedEvent() ? `Capture #${selectedEvent()?.captureSeq}` : "No event selected"}
            />
            <Inspector event={selectedEvent()} />
          </aside>

          <section class="grid min-h-0 grid-cols-1 border-b border-neutral-800 bg-neutral-950 lg:col-start-2 lg:col-end-4 lg:row-start-2 lg:grid-cols-[300px_minmax(0,1fr)] lg:border-b-0">
            <TopicPanel topics={topics()} />
            <CapturePanel stats={agent.stats()} events={events()} />
          </section>
        </section>

        <footer class="border-t border-neutral-800 bg-neutral-950 px-4 py-2">
          <div class="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
            <div class="flex items-center gap-2 text-emerald-300">
              <Activity size={14} />
              <span>Agent {agent.phase()}</span>
            </div>
            <span class="text-neutral-700">/</span>
            <span>{agent.httpUrl}</span>
            <span class="ml-auto">Last message {formatTime(agent.lastMessageAt())}</span>
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
  stats: CaptureStats | undefined;
  lastMessageAt: Date | undefined;
  httpUrl: string;
  liveUrl: string;
  endpoints: [string, string][];
  targetUrl: string;
  setTargetUrl: (value: string) => void;
  headersText: string;
  setHeadersText: (value: string) => void;
  bearerToken: string;
  setBearerToken: (value: string) => void;
  apiKeyHeader: string;
  setApiKeyHeader: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  subprotocols: string;
  setSubprotocols: (value: string) => void;
  autoReconnect: boolean;
  setAutoReconnect: (value: boolean) => void;
  connect: () => void;
  reconnect: () => void;
};

function AgentPanel(props: AgentPanelProps) {
  return (
    <aside class="min-h-0 overflow-auto border-b border-neutral-800 bg-neutral-950 lg:row-span-2 lg:border-b-0">
      <PanelHeader icon={Wifi} title="Agent Connection" detail={props.stats?.state ?? props.status?.state ?? props.phase} />
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
          {(message) => <InlineIssue message={message()} />}
        </Show>

        <div class="space-y-3 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
          <div class="flex items-center gap-2 text-xs font-medium uppercase text-neutral-500">
            <PlugZap size={13} />
            Upstream
          </div>
          <Field label="Target URI" value={props.targetUrl} onInput={props.setTargetUrl} mono />
          <div class="grid grid-cols-2 gap-2">
            <Field label="Bearer token" value={props.bearerToken} onInput={props.setBearerToken} type="password" />
            <Field label="Subprotocols" value={props.subprotocols} onInput={props.setSubprotocols} placeholder="json, v2" mono />
          </div>
          <div class="grid grid-cols-[0.9fr_1.1fr] gap-2">
            <Field label="API key header" value={props.apiKeyHeader} onInput={props.setApiKeyHeader} mono />
            <Field label="API key" value={props.apiKey} onInput={props.setApiKey} type="password" />
          </div>
          <label class="grid gap-1">
            <span class="text-xs text-neutral-500">Custom headers</span>
            <textarea
              class="field min-h-[64px] resize-none font-mono"
              placeholder={"x-stream-id: demo\nx-client: wiretap"}
              value={props.headersText}
              onInput={(event) => props.setHeadersText(event.currentTarget.value)}
            />
          </label>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <label class="flex items-center gap-2 text-sm text-neutral-300">
              <input
                class="accent-cyan-300"
                type="checkbox"
                checked={props.autoReconnect}
                onInput={(event) => props.setAutoReconnect(event.currentTarget.checked)}
              />
              Auto reconnect
            </label>
            <div class="flex gap-2">
              <IconTextButton icon={PlugZap} label="Connect" onClick={props.connect} primary />
              <IconTextButton icon={RefreshCw} label="Reconnect" onClick={props.reconnect} />
            </div>
          </div>
        </div>

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

function VirtualEventTable(props: {
  connected: boolean;
  events: CaptureEvent[];
  selectedSeq: number | undefined;
  onSelect: (captureSeq: number) => void;
}) {
  const rowHeight = 34;
  const overscan = 8;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [viewport, setViewport] = createSignal<HTMLDivElement>();

  onMount(() => {
    const element = viewport();
    if (!element) {
      return;
    }
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  const totalHeight = createMemo(() => props.events.length * rowHeight);
  const visibleRange = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / rowHeight) - overscan);
    const visibleCount = Math.ceil(viewportHeight() / rowHeight) + overscan * 2;
    const end = Math.min(props.events.length, start + visibleCount);
    return { start, end };
  });
  const visibleEvents = createMemo(() => props.events.slice(visibleRange().start, visibleRange().end));

  return (
    <div class="grid min-h-0 grid-rows-[34px_1fr]">
      <div class="event-grid border-b border-neutral-800 bg-neutral-900/70 text-xs font-medium uppercase text-neutral-500">
        <span>Seq</span>
        <span>Received</span>
        <span>Topic</span>
        <span>Type</span>
        <span>Payload preview</span>
      </div>
      <Show when={props.events.length > 0} fallback={<EmptyState connected={props.connected} />}>
        <div
          ref={setViewport}
          class="event-table-scroll min-h-0 overflow-auto"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div class="relative min-w-[860px]" style={{ height: `${totalHeight()}px` }}>
            <For each={visibleEvents()}>
              {(event, index) => {
                const eventIndex = () => visibleRange().start + index();
                return (
                  <button
                    type="button"
                    class={`event-grid row-button ${eventIndex() % 2 === 1 ? "odd-row" : ""} ${
                      props.selectedSeq === event.captureSeq ? "selected" : ""
                    } ${event.issues?.length ? "issue-row" : ""}`}
                    style={{ transform: `translateY(${eventIndex() * rowHeight}px)` }}
                    onClick={() => props.onSelect(event.captureSeq)}
                  >
                    <span class="font-mono text-neutral-300">{event.captureSeq}</span>
                    <span class="font-mono text-neutral-400">{formatEventTime(event.receivedAt)}</span>
                    <span class="truncate font-mono font-medium text-cyan-100">
                      {event.displayTopic ?? event.topic ?? "unknown"}
                    </span>
                    <span class={event.issues?.length ? "truncate font-mono text-amber-200" : "truncate font-mono text-neutral-300"}>
                      {event.displayType ?? event.eventType ?? event.opcode}
                    </span>
                    <span class="truncate text-left font-mono text-neutral-400">{previewPayload(event)}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

type InspectorTab = "parsed" | "payload" | "raw" | "issues" | "metadata";

function Inspector(props: { event: CaptureEvent | undefined }) {
  const [tab, setTab] = createSignal<InspectorTab>("payload");
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "parsed", label: "Parsed" },
    { id: "payload", label: "Payload" },
    { id: "raw", label: "Raw" },
    { id: "issues", label: "Issues" },
    { id: "metadata", label: "Metadata" },
  ];

  return (
    <Show
      when={props.event}
      fallback={
        <EmptyPanel icon={Server} title="Select an event" detail="Payload, parsed envelope, issues, and raw frame details render here." />
      }
    >
      {(event) => (
        <div class="grid min-h-0 grid-rows-[auto_auto_1fr]">
          <div class="border-b border-neutral-800 p-4">
            <dl class="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
              <dt class="text-neutral-500">Sequence</dt>
              <dd class="truncate text-right font-mono text-neutral-100">{event().seq ?? event().captureSeq}</dd>
              <dt class="text-neutral-500">Topic</dt>
              <dd class="truncate text-right font-mono text-cyan-100">
                {event().displayTopic ?? event().topic ?? "unknown"}
              </dd>
              <dt class="text-neutral-500">Type</dt>
              <dd class="truncate text-right font-mono text-neutral-200">
                {event().displayType ?? event().eventType ?? event().opcode}
              </dd>
              <dt class="text-neutral-500">Bytes</dt>
              <dd class="text-right font-mono text-neutral-300">
                {event().sizeBytes}
                <Show when={event().rawTruncated}> / {event().originalSizeBytes}</Show>
              </dd>
            </dl>
          </div>
          <div class="flex min-w-0 gap-1 border-b border-neutral-800 bg-neutral-900/50 p-1">
            <For each={tabs}>
              {(item) => (
                <button
                  type="button"
                  class={`inspector-tab ${tab() === item.id ? "selected" : ""}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
          <div class="min-h-0 overflow-auto p-4">
            <Show when={tab() === "issues"}>
              <Show
                when={(event().issues?.length ?? 0) > 0}
                fallback={<div class="text-sm text-neutral-500">No issues for this event.</div>}
              >
                <div class="grid gap-2">
                  <For each={event().issues}>{(issue) => <IssueBadge issue={issue} />}</For>
                </div>
              </Show>
            </Show>
            <Show when={tab() !== "issues"}>
              <pre class="min-h-[180px] overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-neutral-200">
                {formatInspectorTab(event(), tab())}
              </pre>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

function TopicPanel(props: { topics: Array<{ name: string; count: number; issues: number }> }) {
  return (
    <div class="min-h-0 border-b border-neutral-800 lg:border-r lg:border-b-0">
      <PanelHeader icon={Activity} title="Topics" detail={`${props.topics.length} scopes`} />
      <Show
        when={props.topics.length > 0}
        fallback={<EmptyPanel icon={Activity} title="No topics active" detail="Topic freshness and issue counts appear after capture starts." />}
      >
        <div class="grid gap-2 p-3">
          <For each={props.topics}>
            {(topic) => (
              <div class="rounded-md border border-neutral-800 bg-neutral-900/60 p-3">
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate font-mono text-sm text-neutral-200">{topic.name}</span>
                  <span class={topic.issues > 0 ? "badge-error" : "badge-live"}>
                    {topic.issues > 0 ? `${topic.issues} issue` : "Live"}
                  </span>
                </div>
                <div class="mt-3 h-1.5 rounded-full bg-neutral-800">
                  <div class="h-full rounded-full bg-cyan-300" style={{ width: `${Math.min(100, topic.count * 12)}%` }} />
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function CapturePanel(props: { stats: CaptureStats | undefined; events: CaptureEvent[] }) {
  const issueCount = createMemo(() => props.events.filter((event) => event.issues?.length).length);
  return (
    <div class="grid min-h-0 grid-rows-[auto_1fr]">
      <PanelHeader icon={Wifi} title="Capture Status" detail={`${issueCount()} flagged`} />
      <div class="grid grid-cols-2 gap-px bg-neutral-800 p-px text-sm md:grid-cols-4">
        <MetricCard label="Connections" value={props.stats?.connections ?? 0} />
        <MetricCard label="Events" value={props.stats?.events ?? props.events.length} />
        <MetricCard label="Issues" value={props.stats?.issues ?? issueCount()} />
        <MetricCard label="Clients" value={props.stats?.liveClients ?? 0} />
      </div>
    </div>
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

function PanelHeader(props: { icon: Component<{ size?: number; class?: string }>; title: string; detail: string }) {
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

function Field(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label class="grid gap-1">
      <span class="text-xs text-neutral-500">{props.label}</span>
      <input
        class={`field ${props.mono ? "font-mono" : ""}`}
        type={props.type ?? "text"}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function IconTextButton(props: {
  icon: Component<{ size?: number; class?: string }>;
  label: string;
  onClick?: () => void;
  primary?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      class={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors ${
        props.primary
          ? "border-cyan-300/40 bg-cyan-300/15 text-cyan-100 hover:bg-cyan-300/20"
          : "border-neutral-700 bg-neutral-900 text-neutral-100 hover:border-neutral-500 hover:bg-neutral-800"
      }`}
      onClick={props.onClick}
    >
      <Icon size={15} />
      {props.label}
    </button>
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

function MetricCard(props: { label: string; value: string | number }) {
  return (
    <div class="bg-neutral-950 p-4">
      <div class="text-xs font-medium uppercase text-neutral-500">{props.label}</div>
      <div class="mt-2 font-mono text-xl font-semibold text-cyan-100">{props.value}</div>
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

function InlineIssue(props: { message: string }) {
  return (
    <div class="flex gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
      <AlertTriangle class="mt-0.5 shrink-0" size={16} />
      <span>{props.message}</span>
    </div>
  );
}

function IssueBadge(props: { issue: CaptureIssue }) {
  return (
    <div class="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
      <span class="font-medium uppercase">{props.issue.code}</span>
      <span class="ml-2 text-amber-50/80">{props.issue.message}</span>
    </div>
  );
}

function EmptyState(props: { connected: boolean }) {
  return (
    <EmptyPanel
      icon={Database}
      title={props.connected ? "Awaiting upstream frames" : "No captured events yet"}
      detail={props.connected ? "Captured WebSocket messages will render here in capture order." : "Connect an upstream WebSocket to start capturing events."}
    />
  );
}

function EmptyPanel(props: { icon: Component<{ size?: number; class?: string }>; title: string; detail: string }) {
  const Icon = props.icon;
  return (
    <div class="flex min-h-[180px] flex-col items-center justify-center gap-2 p-6 text-center">
      <div class="flex size-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-neutral-500">
        <Icon size={17} />
      </div>
      <h3 class="text-sm font-medium text-neutral-200">{props.title}</h3>
      <p class="max-w-[300px] text-sm leading-5 text-neutral-500">{props.detail}</p>
    </div>
  );
}

function parseHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const headerValue = line.slice(index + 1).trim();
    if (key) {
      headers[key] = headerValue;
    }
  }
  return headers;
}

function summarizeTopics(events: CaptureEvent[]) {
  const map = new Map<string, { name: string; count: number; issues: number }>();
  for (const event of events) {
    const name = event.displayTopic ?? event.topic ?? "(raw)";
    const current = map.get(name) ?? { name, count: 0, issues: 0 };
    current.count += 1;
    current.issues += event.issues?.length ?? 0;
    map.set(name, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}

function previewPayload(event: CaptureEvent): string {
  if (event.oversized) {
    return "OVERSIZED " + (event.raw ?? event.rawBase64 ?? "");
  }
  if (event.envelope?.payload !== undefined) {
    return JSON.stringify(event.envelope.payload);
  }
  return event.raw ?? event.rawBase64 ?? "";
}

function formatInspectorTab(event: CaptureEvent, tab: InspectorTab): string {
  if (tab === "parsed") {
    return stringifyInspectorValue(event.envelope ?? { parseError: event.parseError ?? "No parsed envelope" });
  }
  if (tab === "payload") {
    return stringifyInspectorValue(event.envelope?.payload ?? null);
  }
  if (tab === "raw") {
    return event.raw ?? event.rawBase64 ?? "";
  }
  return stringifyInspectorValue({
    id: event.id,
    connectionId: event.connectionId,
    captureSeq: event.captureSeq,
    receivedAt: event.receivedAt,
    direction: event.direction,
    opcode: event.opcode,
    originalSizeBytes: event.originalSizeBytes,
    sizeBytes: event.sizeBytes,
    rawTruncated: event.rawTruncated,
    truncated: event.truncated,
    oversized: event.oversized,
    effectiveKey: event.effectiveKey,
    sourceTs: event.sourceTs,
    statuses: event.statuses,
  });
}

function stringifyInspectorValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 });
}

function formatTime(value: Date | undefined): string {
  return value?.toLocaleTimeString() ?? "Never";
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

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
