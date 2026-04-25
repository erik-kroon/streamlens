import { createFileRoute } from "@tanstack/solid-router";
import {
  AlertTriangle,
  Ban,
  Database,
  Download,
  Eraser,
  Link,
  Pause,
  PlugZap,
  Radio,
  RefreshCw,
  Search,
  ServerCog,
  Settings,
  TerminalSquare,
  Wifi,
  WifiOff,
} from "lucide-solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Component } from "solid-js";

import { createAgentClient, createAgentDerivedState } from "@/lib/agent-client";
import type { CaptureEvent, CaptureIssue, CaptureStats } from "@/lib/agent-protocol";

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
    if (query === "") {
      return events();
    }
    return events().filter((event) =>
      [event.captureSeq, event.displayTopic, event.topic, event.displayType, event.eventType, event.raw, event.rawBase64]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  });
  const topics = createMemo(() => summarizeTopics(events()));

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
    <main class="wiretap-shell grid h-full min-h-0 grid-rows-[40px_1fr_26px] bg-[#0a0a0a] text-[#e5e2e1]">
      <header class="flex items-center justify-between border-b border-[#2a2a2a] bg-[#121212] px-2">
        <div class="flex min-w-0 items-center gap-4">
          <span class="shrink-0 text-sm font-black tracking-normal text-[#00ff41]">WIRETAP</span>
          <div class="hidden min-w-0 items-center gap-3 text-[11px] font-bold uppercase text-[#a0a0a0] sm:flex">
            <span class="truncate text-[#00ff41]">{agentView.targetLabel()}</span>
            <span class="h-3 w-px bg-[#353534]" />
            <span>{formatCount(agent.stats()?.events ?? events().length)} EVT</span>
            <span class="h-3 w-px bg-[#353534]" />
            <span class={agentView.isUpstreamConnected() ? "text-[#00ff41]" : "text-[#a0a0a0]"}>
              {agentView.statusLabel()}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <IconButton icon={Pause} label="Pause" disabled />
          <IconButton icon={Ban} label="Disconnect" onClick={() => runControl(agent.disconnectUpstream)} />
          <IconButton icon={Download} label="Export" disabled />
          <IconButton icon={Link} label="Reconnect live UI" onClick={agent.reconnect} />
        </div>
      </header>

      <section class="grid min-h-0 grid-cols-[64px_minmax(260px,320px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_minmax(260px,34vh)] overflow-hidden max-lg:grid-cols-[56px_minmax(0,1fr)] max-lg:grid-rows-[auto_minmax(0,1fr)_minmax(260px,34vh)]">
        <SideNav />

        <aside class="min-h-0 border-r border-[#2a2a2a] bg-[#121212] max-lg:col-start-2 max-lg:h-[256px] max-lg:border-b">
          <PanelTitle icon={ServerCog} title="CONNECTION" detail={agent.stats()?.state ?? agent.status()?.state ?? agent.phase()} />
          <div class="grid gap-2 p-2">
            <label class="grid gap-1">
              <span class="label">TARGET URI</span>
              <input
                class="field font-mono"
                value={targetUrl()}
                onInput={(event) => setTargetUrl(event.currentTarget.value)}
              />
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label class="grid gap-1">
                <span class="label">BEARER TOKEN</span>
                <input
                  class="field"
                  type="password"
                  value={bearerToken()}
                  onInput={(event) => setBearerToken(event.currentTarget.value)}
                />
              </label>
              <label class="grid gap-1">
                <span class="label">SUBPROTOCOLS</span>
                <input
                  class="field font-mono"
                  placeholder="json, v2"
                  value={subprotocols()}
                  onInput={(event) => setSubprotocols(event.currentTarget.value)}
                />
              </label>
            </div>
            <div class="grid grid-cols-[1fr_1.2fr] gap-2">
              <label class="grid gap-1">
                <span class="label">API KEY HEADER</span>
                <input
                  class="field font-mono"
                  value={apiKeyHeader()}
                  onInput={(event) => setApiKeyHeader(event.currentTarget.value)}
                />
              </label>
              <label class="grid gap-1">
                <span class="label">API KEY</span>
                <input
                  class="field"
                  type="password"
                  value={apiKey()}
                  onInput={(event) => setApiKey(event.currentTarget.value)}
                />
              </label>
            </div>
            <label class="grid gap-1">
              <span class="label">CUSTOM HEADERS</span>
              <textarea
                class="field min-h-[54px] resize-none font-mono"
                placeholder={"x-stream-id: demo\nx-client: wiretap"}
                value={headersText()}
                onInput={(event) => setHeadersText(event.currentTarget.value)}
              />
            </label>
            <div class="flex items-center justify-between gap-2">
              <label class="flex items-center gap-2 text-[11px] font-bold uppercase text-[#b9ccb2]">
                <input
                  class="accent-[#00ff41]"
                  type="checkbox"
                  checked={autoReconnect()}
                  onInput={(event) => setAutoReconnect(event.currentTarget.checked)}
                />
                Auto reconnect
              </label>
              <div class="flex gap-1">
                <ActionButton icon={PlugZap} label="Connect" onClick={connect} primary />
                <ActionButton icon={RefreshCw} label="Reconnect" onClick={() => runControl(agent.reconnectUpstream)} />
              </div>
            </div>
            <Show when={controlError() ?? agent.error()}>
              {(message) => <InlineIssue message={message()} />}
            </Show>
          </div>
        </aside>

        <section class="grid min-h-0 grid-rows-[auto_1fr] border-r border-[#2a2a2a] bg-[#0a0a0a] max-lg:col-span-2 max-lg:col-start-1 max-lg:row-start-2">
          <div class="flex h-8 items-center gap-2 border-b border-[#2a2a2a] bg-[#1e1e1e] px-2">
            <span class="text-[11px] font-bold uppercase">EVENT TAPE</span>
            <span class="status-badge ml-2">{agent.stats()?.state ?? "ready"}</span>
            <div class="ml-auto flex h-6 min-w-[260px] items-center gap-2 border border-[#2a2a2a] bg-[#0f0f0f] px-2 text-[#555]">
              <Search size={14} />
              <input
                class="min-w-0 flex-1 bg-transparent font-mono text-xs text-[#d7f5d0] outline-none"
                placeholder="Filter seq, topic, raw..."
                value={filter()}
                onInput={(event) => setFilter(event.currentTarget.value)}
              />
            </div>
            <IconButton icon={Eraser} label="Clear capture" onClick={() => runControl(agent.clearCapture)} />
          </div>
          <div class="min-h-0 overflow-auto">
            <div class="event-grid sticky top-0 z-10 border-b border-[#2a2a2a] bg-[#101010] text-[10px] font-semibold uppercase text-[#555]">
              <span>SEQ</span>
              <span>RECEIVED</span>
              <span>TOPIC</span>
              <span>TYPE</span>
              <span>PAYLOAD_PREVIEW</span>
            </div>
            <Show
              when={filteredEvents().length > 0}
              fallback={<EmptyTape connected={agentView.isUpstreamConnected()} />}
            >
              <For each={filteredEvents()}>
                {(event) => (
                  <button
                    type="button"
                    class={`event-grid row-button ${selectedEvent()?.captureSeq === event.captureSeq ? "selected" : ""} ${
                      event.issues?.length ? "issue-row" : ""
                    }`}
                    onClick={() => setSelectedSeq(event.captureSeq)}
                  >
                    <span class="font-mono text-[#b9ccb2]">{event.captureSeq}</span>
                    <span class="font-mono">{formatEventTime(event.receivedAt)}</span>
                    <span class="truncate font-mono font-semibold text-[#00ff41]">
                      {event.displayTopic ?? event.topic ?? "unknown"}
                    </span>
                    <span class={event.issues?.length ? "font-mono text-[#ffb4ab]" : "font-mono text-[#ffd5ae]"}>
                      {event.displayType ?? event.eventType ?? event.opcode}
                    </span>
                    <span class="truncate font-mono text-left text-[#b9ccb2]">{previewPayload(event)}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </section>

        <aside class="grid min-h-0 grid-rows-[auto_1fr] bg-[#121212] max-lg:col-span-2 max-lg:row-start-3">
          <PanelTitle icon={TerminalSquare} title="PAYLOAD INSPECTOR" detail={selectedEvent() ? `#${selectedEvent()?.captureSeq}` : "NO EVENT"} />
          <Inspector event={selectedEvent()} />
        </aside>

        <section class="col-start-2 col-end-4 grid min-h-0 grid-cols-[minmax(240px,320px)_1fr] border-t border-[#2a2a2a] bg-[#0a0a0a] max-lg:hidden">
          <div class="min-h-0 border-r border-[#2a2a2a]">
            <PanelTitle icon={Database} title="TOPIC_HEALTH" detail={`${topics().length} scopes`} />
            <div class="grid gap-1 p-1">
              <For each={topics()}>
                {(topic) => (
                  <div class="border border-[#2a2a2a] bg-[#1a1a1a] p-2">
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate font-mono text-xs font-semibold">{topic.name}</span>
                      <span class={topic.issues > 0 ? "badge-error" : "badge-live"}>
                        {topic.issues > 0 ? `${topic.issues} ISSUE` : "LIVE"}
                      </span>
                    </div>
                    <div class="mt-2 h-1 bg-[#2a2a2a]">
                      <div class="h-full bg-[#00ff41]" style={{ width: `${Math.min(100, topic.count * 12)}%` }} />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
          <Timeline stats={agent.stats()} events={events()} />
        </section>
      </section>

      <footer class="flex items-center gap-3 border-t border-[#2a2a2a] bg-[#121212] px-3 text-[11px] uppercase text-[#777]">
        <span class={agent.phase() === "ready" ? "text-[#00ff41]" : "text-[#ffb000]"}>
          Agent {agent.phase()}
        </span>
        <span>/</span>
        <span>{agent.httpUrl}</span>
        <span class="ml-auto">{formatTime(agent.lastMessageAt())}</span>
      </footer>
    </main>
  );
}

function SideNav() {
  const items = [
    { icon: Radio, label: "Streams", active: true },
    { icon: Database, label: "Topics" },
    { icon: AlertTriangle, label: "Alerts" },
    { icon: Settings, label: "Settings" },
  ];
  return (
    <nav class="row-span-2 flex flex-col items-center gap-4 border-r border-[#2a2a2a] bg-[#121212] py-4 max-lg:row-span-3">
      <For each={items}>
        {(item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              class={`grid w-full gap-1 border-l-2 py-2 text-center ${
                item.active
                  ? "border-[#00ff41] bg-[#1e1e1e] text-[#00ff41]"
                  : "border-transparent text-[#666] hover:bg-[#161616] hover:text-white"
              }`}
            >
              <Icon class="mx-auto" size={19} />
              <span class="text-[10px] font-medium uppercase">{item.label}</span>
            </button>
          );
        }}
      </For>
    </nav>
  );
}

function PanelTitle(props: { icon: Component<{ size?: number; class?: string }>; title: string; detail: string }) {
  const Icon = props.icon;
  return (
    <div class="flex h-8 items-center gap-2 border-b border-[#2a2a2a] bg-[#1e1e1e] px-2">
      <Icon class="text-[#00ff41]" size={14} />
      <span class="truncate text-[11px] font-bold uppercase">{props.title}</span>
      <span class="ml-auto truncate text-[10px] font-bold uppercase text-[#00ff41]">{props.detail}</span>
    </div>
  );
}

function Inspector(props: { event: CaptureEvent | undefined }) {
  return (
    <Show
      when={props.event}
      fallback={
        <div class="grid place-items-center p-6 text-center text-xs uppercase text-[#555]">
          <div>
            <WifiOff class="mx-auto mb-2" size={20} />
            No event selected
          </div>
        </div>
      }
    >
      {(event) => (
        <div class="min-h-0 overflow-auto p-3">
          <dl class="grid grid-cols-[88px_1fr] gap-y-2 text-xs uppercase">
            <dt class="text-[#555]">Sequence</dt>
            <dd class="text-right font-mono font-bold">{event().seq ?? event().captureSeq}</dd>
            <dt class="text-[#555]">Topic</dt>
            <dd class="truncate text-right font-mono font-bold text-[#00ff41]">
              {event().displayTopic ?? event().topic ?? "unknown"}
            </dd>
            <dt class="text-[#555]">Type</dt>
            <dd class="truncate text-right font-mono font-bold text-[#00e5ff]">
              {event().displayType ?? event().eventType ?? event().opcode}
            </dd>
            <dt class="text-[#555]">Bytes</dt>
            <dd class="text-right font-mono">{event().sizeBytes}</dd>
          </dl>
          <Show when={event().issues?.length}>
            <div class="mt-3 grid gap-1">
              <For each={event().issues}>{(issue) => <IssueBadge issue={issue} />}</For>
            </div>
          </Show>
          <pre class="mt-3 min-h-[180px] overflow-auto whitespace-pre-wrap border-t border-[#2a2a2a] pt-3 font-mono text-xs leading-5 text-[#d7f5d0]">
            {formatInspectorPayload(event())}
          </pre>
        </div>
      )}
    </Show>
  );
}

function Timeline(props: { stats: CaptureStats | undefined; events: CaptureEvent[] }) {
  const issueCount = createMemo(() => props.events.filter((event) => event.issues?.length).length);
  return (
    <div class="grid min-h-0 grid-rows-[auto_1fr]">
      <PanelTitle icon={Wifi} title="CAPTURE STATUS" detail={`${issueCount()} flagged`} />
      <div class="grid grid-cols-4 gap-px bg-[#2a2a2a] p-px text-xs">
        <Metric label="Connections" value={props.stats?.connections ?? 0} />
        <Metric label="Events" value={props.stats?.events ?? props.events.length} />
        <Metric label="Issues" value={props.stats?.issues ?? issueCount()} />
        <Metric label="Clients" value={props.stats?.liveClients ?? 0} />
      </div>
    </div>
  );
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div class="bg-[#121212] p-3">
      <div class="label">{props.label}</div>
      <div class="mt-2 font-mono text-lg font-semibold text-[#00ff41]">{props.value}</div>
    </div>
  );
}

function IconButton(props: {
  icon: Component<{ size?: number; class?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      class="grid size-6 place-items-center text-[#a0a0a0] transition-[background-color,transform] duration-150 ease-out hover:bg-[#1e1e1e] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35"
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon size={15} />
    </button>
  );
}

function ActionButton(props: {
  icon: Component<{ size?: number; class?: string }>;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      class={`flex h-7 items-center gap-1 border px-2 text-[11px] font-bold uppercase transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] ${
        props.primary
          ? "border-[#00ff41] bg-[#00ff41] text-[#003907]"
          : "border-[#2a2a2a] bg-[#1e1e1e] text-[#e5e2e1] hover:border-[#555]"
      }`}
      onClick={props.onClick}
    >
      <Icon size={13} />
      {props.label}
    </button>
  );
}

function InlineIssue(props: { message: string }) {
  return (
    <div class="flex gap-2 border border-[#ffb000] bg-[#2a2111] p-2 text-xs text-[#ffdcbd]">
      <AlertTriangle class="shrink-0" size={14} />
      <span>{props.message}</span>
    </div>
  );
}

function IssueBadge(props: { issue: CaptureIssue }) {
  return (
    <div class="border border-[#ff3131] bg-[#3a1111] px-2 py-1 text-xs text-[#ffdad6]">
      <span class="font-bold uppercase">{props.issue.code}</span>
      <span class="ml-2">{props.issue.message}</span>
    </div>
  );
}

function EmptyTape(props: { connected: boolean }) {
  return (
    <div class="grid min-h-[220px] place-items-center text-center text-xs uppercase text-[#555]">
      <div>
        <TerminalSquare class="mx-auto mb-2" size={22} />
        {props.connected ? "Awaiting upstream frames" : "Connect an upstream websocket"}
      </div>
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

function formatInspectorPayload(event: CaptureEvent): string {
  const payload = {
    envelope: event.envelope,
    parseError: event.parseError,
    raw: event.raw,
    rawBase64: event.rawBase64,
    metadata: {
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
    },
  };
  return JSON.stringify(payload, null, 2);
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 });
}

function formatTime(value: Date | undefined): string {
  return value?.toLocaleTimeString() ?? "never";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
