import { createFileRoute } from "@tanstack/solid-router";
import {
  Activity,
  AlertTriangle,
  Ban,
  Clock3,
  Database,
  Download,
  Eraser,
  FolderOpen,
  Link,
  Pause,
  Play,
  PlugZap,
  Radio,
  RefreshCw,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
} from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Component } from "solid-js";

import { createAgentClient, createAgentDerivedState } from "@/lib/agent-client";
import {
  eventScopeLabel,
  formatIssueBreakdown,
  formatIssueCode,
  maxCaptureSeq,
  recentIssueSummaries,
  summarizeAgentTopics,
  summarizeTopics,
  type TopicSummary,
} from "@/lib/capture-view-model";
import type {
  AgentStatus,
  CaptureEvent,
  CaptureIssue,
  CaptureSession,
  CaptureStats,
  ExtractionRules,
  StreamStatus,
} from "@/lib/agent-protocol";

export const Route = createFileRoute("/")({
  component: App,
});

const demoScenarios = [
  { id: "normal", label: "Normal" },
  { id: "gap", label: "Gap" },
  { id: "duplicate", label: "Duplicate" },
  { id: "out_of_order", label: "Out of order" },
  { id: "stale", label: "Stale" },
  { id: "malformed", label: "Malformed" },
  { id: "oversized", label: "Oversized" },
] as const;

type DemoScenario = (typeof demoScenarios)[number]["id"];

const defaultExtractionRules: ExtractionRules = {
  topicPath: "topic",
  typePath: "type",
  seqPath: "seq",
  timestampPath: "ts",
  payloadPath: "payload",
  keyPaths: ["key", "symbol"],
  schemaPlugins: [],
  sandboxBoundary: "declarative-json-rules-only",
};

function App() {
  const agent = createAgentClient();
  const agentView = createAgentDerivedState(agent);
  const [demoScenario, setDemoScenario] = createSignal<DemoScenario>("normal");
  const [targetUrl, setTargetUrl] = createSignal(demoStreamUrl("normal"));
  const [streamId, setStreamId] = createSignal("default");
  const [streamFilter, setStreamFilter] = createSignal("all");
  const [headersText, setHeadersText] = createSignal("");
  const [bearerToken, setBearerToken] = createSignal("");
  const [apiKeyHeader, setApiKeyHeader] = createSignal("x-api-key");
  const [apiKey, setApiKey] = createSignal("");
  const [subprotocols, setSubprotocols] = createSignal("");
  const [autoReconnect, setAutoReconnect] = createSignal(false);
  const [selectedSeq, setSelectedSeq] = createSignal<number>();
  const [filter, setFilter] = createSignal("");
  const [controlError, setControlError] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  const [liveFollowPaused, setLiveFollowPaused] = createSignal(false);
  const [pausedAfterSeq, setPausedAfterSeq] = createSignal(0);
  const [followVersion, setFollowVersion] = createSignal(0);
  const [extractionRulesText, setExtractionRulesText] = createSignal(
    JSON.stringify(defaultExtractionRules, null, 2),
  );

  onMount(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    void agent
      .readExtractionRules()
      .then((rules) => setExtractionRulesText(JSON.stringify(rules, null, 2)))
      .catch((caught) =>
        setControlError(caught instanceof Error ? caught.message : "failed to load rules"),
      );
    onCleanup(() => window.clearInterval(interval));
  });

  const events = createMemo(() => agent.events());
  const selectedEvent = createMemo(() => {
    const selected = selectedSeq();
    return events().find((event) => event.captureSeq === selected) ?? events().at(-1);
  });
  const filteredEvents = createMemo(() => {
    const query = filter().trim().toLowerCase();
    const selectedStream = streamFilter();
    const captureOrdered = [...events()]
      .filter(
        (event) => selectedStream === "all" || (event.streamId ?? "default") === selectedStream,
      )
      .sort((a, b) => a.captureSeq - b.captureSeq);
    if (query === "") {
      return captureOrdered;
    }
    return captureOrdered.filter((event) =>
      [
        event.captureSeq,
        event.streamId,
        event.displayTopic,
        event.topic,
        event.displayType,
        event.eventType,
        event.effectiveKey,
        eventScopeLabel(event),
        event.raw,
        event.rawBase64,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  });
  const latestFilteredEvent = createMemo(() => filteredEvents().at(-1));
  const latestCaptureSeq = createMemo(() => maxCaptureSeq(events()));
  const bufferedSincePause = createMemo(() =>
    liveFollowPaused() ? events().filter((event) => event.captureSeq > pausedAfterSeq()).length : 0,
  );
  const topics = createMemo(() => {
    const selectedStream = streamFilter();
    const agentTopics = agent.topics();
    const visibleAgentTopics =
      selectedStream === "all"
        ? agentTopics
        : agentTopics.filter((topic) => (topic.streamId ?? "default") === selectedStream);
    if (visibleAgentTopics.length > 0) {
      return summarizeAgentTopics(visibleAgentTopics, now());
    }
    return summarizeTopics(filteredEvents(), now());
  });
  const streams = createMemo(() => agent.stats()?.streams ?? agent.status()?.streams ?? []);
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
        streamId: streamId(),
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

  const selectDemoScenario = (scenario: DemoScenario) => {
    setDemoScenario(scenario);
    setTargetUrl(demoStreamUrl(scenario));
  };

  createEffect(() => {
    if (liveFollowPaused()) {
      return;
    }
    const latest = latestFilteredEvent();
    if (latest && selectedSeq() !== latest.captureSeq) {
      setSelectedSeq(latest.captureSeq);
    }
  });

  const pauseLiveFollow = () => {
    setPausedAfterSeq(latestCaptureSeq());
    setLiveFollowPaused(true);
  };

  const resumeLiveFollow = () => {
    setLiveFollowPaused(false);
    const latest = latestFilteredEvent();
    if (latest) {
      setSelectedSeq(latest.captureSeq);
    }
    setFollowVersion((version) => version + 1);
  };

  const selectEvent = (captureSeq: number) => {
    setSelectedSeq(captureSeq);
    const latest = latestFilteredEvent();
    if (!liveFollowPaused() && latest && captureSeq !== latest.captureSeq) {
      pauseLiveFollow();
    }
  };

  const clearCapture = () =>
    runControl(async () => {
      await agent.clearCapture();
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setFollowVersion((version) => version + 1);
    });

  const exportCapture = () => runControl(agent.exportJSONL);
  const importCapture = (file: File) =>
    runControl(async () => {
      await agent.importJSONL(file);
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setFollowVersion((version) => version + 1);
    });
  const refreshSessions = () => runControl(agent.refreshSessions);
  const openSavedSession = (sessionId: string) =>
    runControl(async () => {
      await agent.openSession(sessionId);
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setFollowVersion((version) => version + 1);
    });
  const deleteSavedSession = (sessionId: string) =>
    runControl(async () => {
      await agent.deleteSession(sessionId);
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setFollowVersion((version) => version + 1);
    });
  const exportSavedSession = (sessionId: string) =>
    runControl(() => agent.exportSessionJSONL(sessionId));
  const saveExtractionRules = () =>
    runControl(async () => {
      const parsed = JSON.parse(extractionRulesText()) as ExtractionRules;
      const saved = await agent.saveExtractionRules(parsed);
      setExtractionRulesText(JSON.stringify(saved, null, 2));
    });

  return (
    <main class="relative h-full min-h-0 overflow-hidden bg-neutral-950 pb-9 text-neutral-100">
      <div class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
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
              <IconTextButton
                icon={Ban}
                label="Disconnect"
                onClick={() =>
                  runControl(() =>
                    agent.disconnectUpstream(
                      streamFilter() === "all" ? streamId() : streamFilter(),
                    ),
                  )
                }
              />
              <IconTextButton icon={Link} label="Reconnect UI" onClick={agent.reconnect} />
            </div>
          </div>
        </section>

        <section class="grid min-h-0 overflow-hidden grid-cols-1 grid-rows-[auto_minmax(340px,1fr)_minmax(300px,40vh)_auto] lg:grid-cols-[340px_minmax(0,1fr)_360px] lg:grid-rows-[minmax(0,1fr)_260px]">
          <AgentPanel
            phase={agent.phase()}
            controlError={controlError()}
            status={agent.status()}
            stats={agent.stats()}
            currentSession={agent.currentSession()}
            sessions={agent.sessions()}
            lastMessageAt={agent.lastMessageAt()}
            httpUrl={agent.httpUrl}
            liveUrl={agent.liveUrl}
            endpoints={endpoints()}
            streams={streams()}
            streamId={streamId()}
            setStreamId={setStreamId}
            targetUrl={targetUrl()}
            setTargetUrl={setTargetUrl}
            demoScenario={demoScenario()}
            setDemoScenario={selectDemoScenario}
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
            reconnect={() => runControl(() => agent.reconnectUpstream(streamId()))}
            refreshSessions={refreshSessions}
            openSession={openSavedSession}
            deleteSession={deleteSavedSession}
            exportSession={exportSavedSession}
            extractionRulesText={extractionRulesText()}
            setExtractionRulesText={setExtractionRulesText}
            saveExtractionRules={saveExtractionRules}
          />

          <section class="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_1fr] border-b border-neutral-800 bg-neutral-950 lg:col-start-2 lg:border-x lg:border-b-0">
            <PanelHeader
              icon={Database}
              title="Captured Events"
              detail={`${formatCount(filteredEvents().length)} shown / ${formatCount(events().length)} retained`}
            />
            <div class="flex min-w-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
              <select
                class="field h-9 w-[170px] min-w-0"
                value={streamFilter()}
                onInput={(event) => setStreamFilter(event.currentTarget.value)}
              >
                <option value="all">All streams</option>
                <For each={streams()}>
                  {(stream) => <option value={stream.id}>{stream.id}</option>}
                </For>
              </select>
              <div class="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/70 px-3 text-neutral-500">
                <Search size={15} />
                <input
                  class="min-w-0 flex-1 bg-transparent font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
                  placeholder="Filter seq, topic, key, raw..."
                  value={filter()}
                  onInput={(event) => setFilter(event.currentTarget.value)}
                />
              </div>
              <IconTextButton
                icon={liveFollowPaused() ? Play : Pause}
                label={
                  liveFollowPaused()
                    ? `Resume ${formatCount(bufferedSincePause())}`
                    : "Pause follow"
                }
                onClick={liveFollowPaused() ? resumeLiveFollow : pauseLiveFollow}
                primary={liveFollowPaused()}
              />
              <IconTextButton icon={Download} label="Export JSONL" onClick={exportCapture} />
              <FileImportButton onImport={importCapture} />
              <IconTextButton icon={Eraser} label="Clear" onClick={clearCapture} />
            </div>
            <VirtualEventTable
              connected={agentView.isUpstreamConnected()}
              events={filteredEvents()}
              isLiveFollowPaused={liveFollowPaused()}
              followVersion={followVersion()}
              selectedSeq={selectedEvent()?.captureSeq}
              onSelect={selectEvent}
            />
          </section>

          <aside class="grid min-h-0 min-w-0 grid-rows-[auto_1fr] border-b border-neutral-800 bg-neutral-950 lg:col-start-3 lg:border-b-0">
            <PanelHeader
              icon={Server}
              title="Payload Inspector"
              detail={
                selectedEvent() ? `Capture #${selectedEvent()?.captureSeq}` : "No event selected"
              }
            />
            <Inspector event={selectedEvent()} />
          </aside>

          <section class="grid min-h-0 min-w-0 grid-cols-1 border-b border-neutral-800 bg-neutral-950 lg:col-start-2 lg:col-end-4 lg:row-start-2 lg:grid-cols-[300px_minmax(0,1fr)] lg:border-l lg:border-t lg:border-b-0">
            <TopicPanel topics={topics()} activeFilter={filter()} onFilterTopic={setFilter} />
            <CapturePanel stats={agent.stats()} events={events()} onSelectEvent={selectEvent} />
          </section>
        </section>

        <footer class="absolute inset-x-0 bottom-0 h-9 overflow-hidden border-t border-neutral-800 bg-neutral-950 px-4">
          <div class="flex h-full min-w-0 items-center gap-3 text-xs text-neutral-400">
            <div class="flex shrink-0 items-center gap-2 text-emerald-300">
              <Activity size={14} />
              <span>Agent {agent.phase()}</span>
            </div>
            <span class="shrink-0 text-neutral-700">/</span>
            <span class="min-w-0 truncate">{agent.httpUrl}</span>
            <span class="ml-auto shrink-0">Last message {formatTime(agent.lastMessageAt())}</span>
          </div>
        </footer>
      </div>
    </main>
  );
}

type AgentPanelProps = {
  phase: string;
  controlError: string | undefined;
  status: AgentStatus | undefined;
  stats: CaptureStats | undefined;
  currentSession: CaptureSession | undefined;
  sessions: CaptureSession[];
  lastMessageAt: Date | undefined;
  httpUrl: string;
  liveUrl: string;
  endpoints: [string, string][];
  streams: StreamStatus[];
  streamId: string;
  setStreamId: (value: string) => void;
  targetUrl: string;
  setTargetUrl: (value: string) => void;
  demoScenario: DemoScenario;
  setDemoScenario: (value: DemoScenario) => void;
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
  refreshSessions: () => void;
  openSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  exportSession: (sessionId: string) => void;
  extractionRulesText: string;
  setExtractionRulesText: (value: string) => void;
  saveExtractionRules: () => void;
};

function AgentPanel(props: AgentPanelProps) {
  return (
    <aside class="min-h-0 overflow-y-auto overflow-x-hidden border-b border-neutral-800 bg-neutral-950 lg:row-span-2 lg:border-b-0">
      <PanelHeader
        icon={Wifi}
        title="Agent Connection"
        detail={props.stats?.state ?? props.status?.state ?? props.phase}
      />
      <div class="space-y-3 p-3">
        <div class="rounded-md border border-neutral-800 bg-neutral-900/70 p-3">
          <div class="mb-3 flex min-w-0 items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase text-neutral-500">Current Status</span>
            <StatusPill online={props.phase === "ready"} label={props.phase} compact />
          </div>
          <dl class="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Agent ID" value={props.status?.agentId ?? "Unavailable"} />
            <Metric label="Version" value={props.status?.version ?? "Unknown"} />
            <Metric label="Uptime" value={formatUptime(props.status?.uptimeMs)} />
            <Metric label="Last message" value={formatTime(props.lastMessageAt)} />
          </dl>
        </div>

        <Show when={props.controlError}>{(message) => <InlineIssue message={message()} />}</Show>

        <SessionLibrary
          sessions={props.sessions}
          currentSession={props.currentSession}
          onRefresh={props.refreshSessions}
          onOpen={props.openSession}
          onDelete={props.deleteSession}
          onExport={props.exportSession}
        />

        <StreamList streams={props.streams} />

        <ExtractionRuleEditor
          value={props.extractionRulesText}
          onInput={props.setExtractionRulesText}
          onSave={props.saveExtractionRules}
        />

        <div class="space-y-3 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
          <div class="flex min-w-0 items-center gap-2 text-xs font-medium uppercase text-neutral-500">
            <PlugZap size={13} />
            Upstream
          </div>
          <label class="grid min-w-0 gap-1">
            <span class="truncate text-xs text-neutral-500">Demo scenario</span>
            <select
              class="field w-full min-w-0"
              value={props.demoScenario}
              onInput={(event) => props.setDemoScenario(event.currentTarget.value as DemoScenario)}
            >
              <For each={demoScenarios}>
                {(scenario) => <option value={scenario.id}>{scenario.label}</option>}
              </For>
            </select>
          </label>
          <Field label="Stream ID" value={props.streamId} onInput={props.setStreamId} mono />
          <Field label="Target URI" value={props.targetUrl} onInput={props.setTargetUrl} mono />
          <div class="grid grid-cols-2 gap-2">
            <Field
              label="Bearer token"
              value={props.bearerToken}
              onInput={props.setBearerToken}
              type="password"
            />
            <Field
              label="Subprotocols"
              value={props.subprotocols}
              onInput={props.setSubprotocols}
              placeholder="json, v2"
              mono
            />
          </div>
          <div class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2">
            <Field
              label="API key header"
              value={props.apiKeyHeader}
              onInput={props.setApiKeyHeader}
              mono
            />
            <Field label="API key" value={props.apiKey} onInput={props.setApiKey} type="password" />
          </div>
          <label class="grid min-w-0 gap-1">
            <span class="text-xs text-neutral-500">Custom headers</span>
            <textarea
              class="field min-h-[58px] w-full min-w-0 resize-none font-mono"
              placeholder={"x-stream-id: demo\nx-client: wiretap"}
              value={props.headersText}
              onInput={(event) => props.setHeadersText(event.currentTarget.value)}
            />
          </label>
          <div class="grid gap-2">
            <label class="flex min-w-0 items-center gap-2 text-sm text-neutral-300">
              <input
                class="shrink-0 accent-cyan-300"
                type="checkbox"
                checked={props.autoReconnect}
                onInput={(event) => props.setAutoReconnect(event.currentTarget.checked)}
              />
              <span class="truncate">Auto reconnect</span>
            </label>
            <div class="grid grid-cols-2 gap-2">
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

function SessionLibrary(props: {
  sessions: CaptureSession[];
  currentSession: CaptureSession | undefined;
  onRefresh: () => void;
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onExport: (sessionId: string) => void;
}) {
  return (
    <div class="space-y-2 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2 text-xs font-medium uppercase text-neutral-500">
          <Database size={13} />
          <span>Capture Library</span>
        </div>
        <button
          type="button"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800"
          onClick={props.onRefresh}
          title="Refresh sessions"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <Show
        when={props.sessions.length > 0}
        fallback={
          <div class="text-sm text-neutral-500">Saved captures appear after recording.</div>
        }
      >
        <div class="grid max-h-[230px] gap-2 overflow-auto pr-1">
          <For each={props.sessions}>
            {(session) => {
              const active = () => props.currentSession?.id === session.id;
              return (
                <div
                  class={`grid gap-2 rounded-md border p-2 ${
                    active()
                      ? "border-cyan-300/40 bg-cyan-300/10"
                      : "border-neutral-800 bg-neutral-950/45"
                  }`}
                >
                  <button
                    type="button"
                    class="grid min-w-0 gap-1 text-left"
                    onClick={() => props.onOpen(session.id)}
                  >
                    <div class="flex min-w-0 items-center justify-between gap-2">
                      <span class="truncate font-mono text-xs text-neutral-200">{session.id}</span>
                      <span class={active() ? "badge-live" : "badge-muted"}>
                        {active() ? "Open" : `${formatCount(session.eventCount)} events`}
                      </span>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-xs text-neutral-500">
                      <span class="truncate">{formatSessionDate(session.updatedAt)}</span>
                      <span class="truncate text-right">
                        {formatCount(session.issueCount)} flagged
                      </span>
                    </div>
                  </button>
                  <div class="grid grid-cols-3 gap-1">
                    <MiniIconButton
                      icon={FolderOpen}
                      label="Open"
                      onClick={() => props.onOpen(session.id)}
                    />
                    <MiniIconButton
                      icon={Download}
                      label="Export"
                      onClick={() => props.onExport(session.id)}
                    />
                    <MiniIconButton
                      icon={Trash2}
                      label="Delete"
                      onClick={() => props.onDelete(session.id)}
                      danger
                    />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

function StreamList(props: { streams: StreamStatus[] }) {
  return (
    <div class="space-y-2 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
      <div class="flex min-w-0 items-center gap-2 text-xs font-medium uppercase text-neutral-500">
        <Radio size={13} />
        <span>Streams</span>
      </div>
      <Show
        when={props.streams.length > 0}
        fallback={<div class="text-sm text-neutral-500">No upstream streams configured.</div>}
      >
        <div class="grid max-h-[170px] gap-2 overflow-auto pr-1">
          <For each={props.streams}>
            {(stream) => (
              <div class="grid gap-1 rounded-md border border-neutral-800 bg-neutral-950/45 p-2">
                <div class="flex min-w-0 items-center justify-between gap-2">
                  <span class="truncate font-mono text-xs text-neutral-200">{stream.id}</span>
                  <StatusPill online={stream.state === "connected"} label={stream.state} compact />
                </div>
                <div class="truncate font-mono text-xs text-neutral-500">
                  {stream.url ?? "No URL"}
                </div>
                <div class="grid grid-cols-3 gap-2 text-xs text-neutral-500">
                  <span>{formatCount(stream.events)} events</span>
                  <span>{formatCount(stream.issues)} flagged</span>
                  <span class="truncate text-right">{stream.connectionId ?? "idle"}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function ExtractionRuleEditor(props: {
  value: string;
  onInput: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div class="space-y-2 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2 text-xs font-medium uppercase text-neutral-500">
          <SlidersHorizontal size={13} />
          <span>Extraction Rules</span>
        </div>
        <IconTextButton icon={Save} label="Apply" onClick={props.onSave} />
      </div>
      <textarea
        class="field min-h-[180px] w-full min-w-0 resize-y font-mono text-xs leading-5"
        spellcheck={false}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <div class="grid grid-cols-2 gap-2 text-xs text-neutral-500">
        <span class="truncate">Paths use dot notation.</span>
        <span class="truncate text-right">Plugins run as declarative checks.</span>
      </div>
    </div>
  );
}

function VirtualEventTable(props: {
  connected: boolean;
  events: CaptureEvent[];
  isLiveFollowPaused: boolean;
  followVersion: number;
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
  const visibleEvents = createMemo(() =>
    props.events.slice(visibleRange().start, visibleRange().end),
  );

  createEffect(() => {
    if (props.isLiveFollowPaused) {
      return;
    }
    const eventCount = props.events.length;
    const followVersion = props.followVersion;
    const element = viewport();
    if (!element) {
      return;
    }
    void eventCount;
    void followVersion;
    const nextScrollTop = Math.max(0, totalHeight() - element.clientHeight);
    element.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  });

  return (
    <div class="grid min-h-0 grid-rows-[34px_1fr]">
      <div class="event-grid border-b border-neutral-800 bg-neutral-900/70 text-xs font-medium uppercase text-neutral-500">
        <span>Seq</span>
        <span>Stream</span>
        <span>Received</span>
        <span>Topic</span>
        <span>Status</span>
        <span>Type</span>
        <span>Payload preview</span>
      </div>
      <Show when={props.events.length > 0} fallback={<EmptyState connected={props.connected} />}>
        <div
          ref={setViewport}
          class="event-table-scroll min-h-0 overflow-auto"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div class="relative min-w-[1080px]" style={{ height: `${totalHeight()}px` }}>
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
                    <span class="truncate font-mono text-neutral-500">
                      {event.streamId ?? "default"}
                    </span>
                    <span class="font-mono text-neutral-400">
                      {formatEventTime(event.receivedAt)}
                    </span>
                    <span class="truncate font-mono font-medium text-cyan-100">
                      {event.displayTopic ?? event.topic ?? "unknown"}
                    </span>
                    <span>
                      <EventStatusBadge event={event} />
                    </span>
                    <span
                      class={
                        event.issues?.length
                          ? "truncate font-mono text-amber-200"
                          : "truncate font-mono text-neutral-300"
                      }
                    >
                      {event.displayType ?? event.eventType ?? event.opcode}
                    </span>
                    <span class="truncate text-left font-mono text-neutral-400">
                      {previewPayload(event)}
                    </span>
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
        <EmptyPanel
          icon={Server}
          title="Select an event"
          detail="Payload, parsed envelope, issues, and raw frame details render here."
        />
      }
    >
      {(event) => (
        <div class="grid min-h-0 grid-rows-[auto_auto_1fr]">
          <div class="border-b border-neutral-800 p-4">
            <dl class="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
              <dt class="text-neutral-500">Sequence</dt>
              <dd class="truncate text-right font-mono text-neutral-100">
                {event().seq ?? event().captureSeq}
              </dd>
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

function TopicPanel(props: {
  topics: TopicSummary[];
  activeFilter: string;
  onFilterTopic: (value: string) => void;
}) {
  return (
    <div class="min-h-0 border-b border-neutral-800 lg:border-r lg:border-b-0">
      <PanelHeader icon={Activity} title="Topics" detail={`${props.topics.length} scopes`} />
      <Show
        when={props.topics.length > 0}
        fallback={
          <EmptyPanel
            icon={Activity}
            title="No topics active"
            detail="Topic freshness and issue counts appear after capture starts."
          />
        }
      >
        <div class="grid max-h-full gap-2 overflow-auto p-3">
          <For each={props.topics}>
            {(topic) => (
              <button
                type="button"
                class={`grid gap-2 rounded-md border p-3 text-left transition-colors ${
                  props.activeFilter === topic.name
                    ? "border-cyan-300/45 bg-cyan-300/10"
                    : "border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-900"
                }`}
                onClick={() =>
                  props.onFilterTopic(props.activeFilter === topic.name ? "" : topic.name)
                }
              >
                <div class="flex min-w-0 items-center justify-between gap-2">
                  <span class="truncate font-mono text-sm text-neutral-200">{topic.name}</span>
                  <TopicStateBadge topic={topic} />
                </div>
                <div class="grid grid-cols-3 gap-2 text-xs">
                  <TopicMetric label="Rate" value={`${formatRate(topic.ratePerSecond)}/s`} />
                  <TopicMetric label="Fresh" value={formatFreshness(topic.freshnessMs)} />
                  <TopicMetric
                    label="Last seq"
                    value={topic.lastSeq === undefined ? "--" : String(topic.lastSeq)}
                  />
                </div>
                <div class="flex min-w-0 items-center justify-between gap-3 text-xs text-neutral-500">
                  <span>
                    {formatCount(topic.count)} events / {formatCount(topic.keyCount)} keys
                  </span>
                  <span class={topic.issueCount > 0 ? "text-amber-200" : "text-neutral-500"}>
                    {formatIssueBreakdown(topic)}
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function TopicStateBadge(props: { topic: TopicSummary }) {
  const className = () => {
    if (props.topic.stale || props.topic.issueCount > 0) {
      return "badge-error";
    }
    if (props.topic.state === "live") {
      return "badge-live";
    }
    return "badge-muted";
  };
  const label = () => {
    if (props.topic.stale) {
      return "Stale";
    }
    if (props.topic.issueCount > 0) {
      return `${formatCount(props.topic.issueCount)} issue${props.topic.issueCount === 1 ? "" : "s"}`;
    }
    if (props.topic.state === "live") {
      return "Live";
    }
    if (props.topic.state === "warming") {
      return "Warm";
    }
    return "Quiet";
  };
  return <span class={className()}>{label()}</span>;
}

function TopicMetric(props: { label: string; value: string }) {
  return (
    <span class="grid min-w-0 gap-1 rounded-md border border-neutral-800 bg-neutral-950/55 px-2 py-1.5">
      <span class="truncate text-[10px] font-medium uppercase text-neutral-600">{props.label}</span>
      <span class="truncate font-mono text-neutral-200">{props.value}</span>
    </span>
  );
}

function EventStatusBadge(props: { event: CaptureEvent }) {
  const code = () => props.event.issues?.[0]?.code;
  const label = () => {
    if (code() === "out_of_order") {
      return "Order";
    }
    if (code() === "parse_error") {
      return "Parse";
    }
    if (code() === "schema_error") {
      return "Schema";
    }
    return code() ? formatIssueCode(code() ?? "") : "OK";
  };
  return <span class={code() ? "badge-error" : "badge-live"}>{label()}</span>;
}

function CapturePanel(props: {
  stats: CaptureStats | undefined;
  events: CaptureEvent[];
  onSelectEvent: (captureSeq: number) => void;
}) {
  const issueCount = createMemo(() =>
    props.events.reduce((count, event) => count + (event.issues?.length ?? 0), 0),
  );
  const issueSummaries = createMemo(() => recentIssueSummaries(props.events));
  return (
    <div class="grid min-h-0 grid-rows-[auto_1fr]">
      <PanelHeader
        icon={Wifi}
        title="Capture Status"
        detail={`${props.stats?.issues ?? issueCount()} flagged`}
      />
      <div class="grid min-h-0 grid-rows-[auto_1fr]">
        <div class="grid grid-cols-2 gap-px bg-neutral-800 p-px text-sm md:grid-cols-4 xl:grid-cols-7">
          <MetricCard label="Connections" value={props.stats?.connections ?? 0} />
          <MetricCard label="Events" value={props.stats?.events ?? props.events.length} />
          <MetricCard label="Retained" value={props.stats?.retainedEvents ?? props.events.length} />
          <MetricCard label="Dropped" value={props.stats?.droppedEvents ?? 0} />
          <MetricCard label="Capacity" value={props.stats?.bufferCapacity ?? 10_000} />
          <MetricCard label="Issues" value={props.stats?.issues ?? issueCount()} />
          <MetricCard label="Clients" value={props.stats?.liveClients ?? 0} />
        </div>
        <div class="min-h-0 overflow-auto border-t border-neutral-800 p-3">
          <Show
            when={issueSummaries().length > 0}
            fallback={<div class="text-sm text-neutral-500">Recent stream issues appear here.</div>}
          >
            <div class="grid gap-2">
              <For each={issueSummaries()}>
                {({ event, issue }) => (
                  <button
                    type="button"
                    class="grid min-w-0 grid-cols-[80px_112px_1fr] items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-left text-xs hover:border-neutral-700 hover:bg-neutral-900"
                    onClick={() => props.onSelectEvent(event.captureSeq)}
                  >
                    <span class="font-mono text-neutral-400">#{event.captureSeq}</span>
                    <span class="badge-error justify-self-start">
                      {formatIssueCode(issue.code)}
                    </span>
                    <span class="min-w-0 truncate text-neutral-300">{issue.message}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
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

function PanelHeader(props: {
  icon: Component<{ size?: number; class?: string }>;
  title: string;
  detail: string;
}) {
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
    <label class="grid min-w-0 gap-1">
      <span class="truncate text-xs text-neutral-500">{props.label}</span>
      <input
        class={`field w-full min-w-0 ${props.mono ? "font-mono" : ""}`}
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
  return (
    <button
      type="button"
      class={`inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md border px-3 text-sm transition-colors active:scale-[0.98] ${
        props.primary
          ? "border-cyan-300/40 bg-cyan-300/15 text-cyan-100 hover:bg-cyan-300/20"
          : "border-neutral-700 bg-neutral-900 text-neutral-100 hover:border-neutral-500 hover:bg-neutral-800"
      }`}
      onClick={() => props.onClick?.()}
    >
      <Dynamic component={props.icon} class="shrink-0" size={15} />
      <span class="truncate">{props.label}</span>
    </button>
  );
}

function FileImportButton(props: { onImport: (file: File) => void }) {
  return (
    <label class="inline-flex h-9 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 transition-colors hover:border-neutral-500 hover:bg-neutral-800 active:scale-[0.98]">
      <Upload class="shrink-0" size={15} />
      <span class="truncate">Import JSONL</span>
      <input
        class="sr-only"
        type="file"
        accept=".jsonl,application/x-ndjson,application/json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            props.onImport(file);
          }
        }}
      />
    </label>
  );
}

function MiniIconButton(props: {
  icon: Component<{ size?: number; class?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      class={`inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-xs transition-colors active:scale-[0.98] ${
        props.danger
          ? "border-amber-500/30 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15"
          : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800"
      }`}
      onClick={props.onClick}
      title={props.label}
    >
      <Dynamic component={props.icon} class="shrink-0" size={13} />
      <span class="truncate">{props.label}</span>
    </button>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="grid min-w-0 gap-1">
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
    <div class="grid gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
      <div>
        <span class="font-medium uppercase">{props.issue.code}</span>
        <span class="ml-2 text-amber-50/80">{props.issue.message}</span>
      </div>
      <Show when={props.issue.details}>
        <pre class="overflow-auto rounded border border-amber-400/20 bg-neutral-950/50 p-2 font-mono text-xs leading-5 text-amber-50/80">
          {stringifyInspectorValue(props.issue.details)}
        </pre>
      </Show>
    </div>
  );
}

function EmptyState(props: { connected: boolean }) {
  return (
    <EmptyPanel
      icon={Database}
      title={props.connected ? "Awaiting upstream frames" : "No captured events yet"}
      detail={
        props.connected
          ? "Captured WebSocket messages will render here in capture order."
          : "Connect an upstream WebSocket to start capturing events."
      }
    />
  );
}

function EmptyPanel(props: {
  icon: Component<{ size?: number; class?: string }>;
  title: string;
  detail: string;
}) {
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

function demoStreamUrl(scenario: DemoScenario): string {
  return `ws://localhost:8791/stream?scenario=${encodeURIComponent(scenario)}`;
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
    return stringifyInspectorValue(
      event.envelope ?? { parseError: event.parseError ?? "No parsed envelope" },
    );
  }
  if (tab === "payload") {
    return stringifyInspectorValue(event.envelope?.payload ?? null);
  }
  if (tab === "raw") {
    return event.raw ?? event.rawBase64 ?? "";
  }
  return stringifyInspectorValue({
    id: event.id,
    streamId: event.streamId,
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

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFreshness(value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (value < 1_000) {
    return `${Math.max(0, Math.round(value))}ms`;
  }
  return `${Math.round(value / 1_000)}s`;
}

function formatRate(value: number): string {
  if (value >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
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
