import { createFileRoute } from "@tanstack/solid-router";
import {
  Activity,
  AlertTriangle,
  Ban,
  BarChart3,
  Clock3,
  Database,
  Download,
  Eraser,
  FolderOpen,
  GitCompare,
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
  summarizeEventDiff,
  summarizeLatency,
  summarizeAgentTopics,
  summarizeTimeline,
  summarizeTopics,
  type LatencyAnalytics,
  type StreamDiffSummary,
  type TimelineSummary,
  type TopicSummary,
} from "@/lib/capture-view-model";
import type {
  AgentStatus,
  CaptureEvent,
  CaptureIssue,
  CaptureSession,
  CaptureStats,
  CaptureTransport,
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
  { id: "fuzz", label: "Fuzz" },
] as const;

type DemoScenario = (typeof demoScenarios)[number]["id"];
type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 4 | 8;
type UpstreamTransport = "websocket" | "sse";
type ReplayServerFormat = "raw" | "jsonl" | "tape";
type FaultScenario = "off" | "drop" | "duplicate" | "reorder" | "delay" | "mutate" | "chaos";

const faultScenarios: { id: FaultScenario; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "drop", label: "Drop" },
  { id: "duplicate", label: "Duplicate" },
  { id: "reorder", label: "Reorder" },
  { id: "delay", label: "Delay" },
  { id: "mutate", label: "Mutate" },
  { id: "chaos", label: "Chaos" },
];
type DiffSourceOption = {
  id: string;
  label: string;
  detail: string;
};

const defaultExtractionRules: ExtractionRules = {
  topicPath: "topic",
  typePath: "type",
  seqPath: "seq",
  timestampPath: "ts",
  payloadPath: "payload",
  keyPaths: ["key", "symbol"],
  otel: {
    traceIdPaths: [
      "traceId",
      "trace_id",
      "trace.id",
      "context.traceId",
      "context.trace_id",
      "payload.traceId",
      "payload.trace_id",
      "payload.trace.id",
    ],
    spanIdPaths: [
      "spanId",
      "span_id",
      "span.id",
      "context.spanId",
      "context.span_id",
      "payload.spanId",
      "payload.span_id",
      "payload.span.id",
    ],
    parentSpanIdPaths: [
      "parentSpanId",
      "parent_span_id",
      "parent.spanId",
      "parent.span_id",
      "payload.parentSpanId",
      "payload.parent_span_id",
    ],
    traceparentPaths: ["traceparent", "context.traceparent", "payload.traceparent"],
    traceStatePaths: [
      "tracestate",
      "traceState",
      "context.tracestate",
      "context.traceState",
      "payload.tracestate",
      "payload.traceState",
    ],
    logIdPaths: ["logId", "log_id", "log.id", "payload.logId", "payload.log_id", "payload.log.id"],
    serviceNamePaths: [
      "service.name",
      "serviceName",
      "service_name",
      "resource.service.name",
      "resource.attributes.service.name",
      "payload.service.name",
      "payload.serviceName",
      "payload.service_name",
    ],
  },
  schemaPlugins: [],
  sandboxBoundary: "declarative-json-rules-only",
};

const RECENT_TARGETS_KEY = "wiretap.recentTargets";
const MAX_RECENT_TARGETS = 8;

function App() {
  const agent = createAgentClient();
  const agentView = createAgentDerivedState(agent);
  const [demoScenario, setDemoScenario] = createSignal<DemoScenario>("normal");
  const [transport, setTransport] = createSignal<UpstreamTransport>("websocket");
  const [targetUrl, setTargetUrl] = createSignal(demoStreamUrl("normal", "websocket"));
  const [recentTargets, setRecentTargets] = createSignal(readRecentTargets());
  const [streamId, setStreamId] = createSignal("default");
  const [streamFilter, setStreamFilter] = createSignal("all");
  const [diffBaseSource, setDiffBaseSource] = createSignal("");
  const [diffCompareSource, setDiffCompareSource] = createSignal("");
  const [diffSessionEvents, setDiffSessionEvents] = createSignal<Record<string, CaptureEvent[]>>(
    {},
  );
  const [diffLoadingSources, setDiffLoadingSources] = createSignal<Record<string, boolean>>({});
  const [diffError, setDiffError] = createSignal<string>();
  const [headersText, setHeadersText] = createSignal("");
  const [bearerToken, setBearerToken] = createSignal("");
  const [apiKeyHeader, setApiKeyHeader] = createSignal("x-api-key");
  const [apiKey, setApiKey] = createSignal("");
  const [subprotocols, setSubprotocols] = createSignal("");
  const [autoReconnect, setAutoReconnect] = createSignal(false);
  const [faultScenario, setFaultScenario] = createSignal<FaultScenario>("off");
  const [faultDropEvery, setFaultDropEvery] = createSignal(5);
  const [faultDuplicateEvery, setFaultDuplicateEvery] = createSignal(4);
  const [faultReorderEvery, setFaultReorderEvery] = createSignal(5);
  const [faultDelayMs, setFaultDelayMs] = createSignal(250);
  const [faultMutateEvery, setFaultMutateEvery] = createSignal(4);
  const [selectedSeq, setSelectedSeq] = createSignal<number>();
  const [filter, setFilter] = createSignal("");
  const [controlError, setControlError] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  const [liveFollowPaused, setLiveFollowPaused] = createSignal(false);
  const [pausedAfterSeq, setPausedAfterSeq] = createSignal(0);
  const [followVersion, setFollowVersion] = createSignal(0);
  const [replayEnabled, setReplayEnabled] = createSignal(false);
  const [replayPlaying, setReplayPlaying] = createSignal(false);
  const [replaySpeed, setReplaySpeed] = createSignal<ReplaySpeed>(1);
  const [replayServerSpeed, setReplayServerSpeed] = createSignal<ReplaySpeed>(1);
  const [replayServerFormat, setReplayServerFormat] = createSignal<ReplayServerFormat>("raw");
  const [replayServerLoop, setReplayServerLoop] = createSignal(false);
  const [replayServerPaused, setReplayServerPaused] = createSignal(false);
  const [replayClockMs, setReplayClockMs] = createSignal(0);
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
  const replayTimeline = createMemo(() =>
    [...events()].sort((a, b) => a.captureSeq - b.captureSeq),
  );
  const replayCursorIndex = createMemo(() => {
    const timeline = replayTimeline();
    if (!replayEnabled() || timeline.length === 0) {
      return -1;
    }

    const clock = replayClockMs();
    let cursor = -1;
    for (let index = 0; index < timeline.length; index += 1) {
      if (eventReplayTimeMs(timeline[index], index) > clock) {
        break;
      }
      cursor = index;
    }
    return Math.max(0, cursor);
  });
  const replayCursorEvent = createMemo(() => replayTimeline()[replayCursorIndex()]);
  const replayedEvents = createMemo(() => {
    if (!replayEnabled()) {
      return events();
    }
    const cursor = replayCursorIndex();
    if (cursor < 0) {
      return [];
    }
    return replayTimeline().slice(0, cursor + 1);
  });
  const selectedEvent = createMemo(() => {
    if (replayEnabled()) {
      return replayCursorEvent();
    }
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
        event.correlation?.traceId,
        event.correlation?.spanId,
        event.correlation?.logId,
        event.correlation?.serviceName,
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
  const analyticsEvents = createMemo(() => {
    const selectedStream = streamFilter();
    const sourceEvents = replayEnabled() ? replayedEvents() : events();
    return selectedStream === "all"
      ? sourceEvents
      : sourceEvents.filter((event) => (event.streamId ?? "default") === selectedStream);
  });
  const latencyAnalytics = createMemo(() => summarizeLatency(analyticsEvents()));
  const bufferedSincePause = createMemo(() =>
    liveFollowPaused() ? events().filter((event) => event.captureSeq > pausedAfterSeq()).length : 0,
  );
  const topics = createMemo(() => {
    const selectedStream = streamFilter();
    if (replayEnabled()) {
      const replayedForStream =
        selectedStream === "all"
          ? replayedEvents()
          : replayedEvents().filter((event) => (event.streamId ?? "default") === selectedStream);
      return summarizeTopics(replayedForStream, replayClockMs());
    }
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
  const timelineSummary = createMemo(() => summarizeTimeline(analyticsEvents(), topics(), now()));
  const streams = createMemo(() => agent.stats()?.streams ?? agent.status()?.streams ?? []);
  const streamIds = createMemo(() => {
    const ids = new Set<string>();
    for (const stream of streams()) {
      ids.add(stream.id);
    }
    for (const event of events()) {
      ids.add(event.streamId ?? "default");
    }
    return [...ids].sort();
  });
  const diffSources = createMemo<DiffSourceOption[]>(() => [
    ...streamIds().map((id) => ({
      id: liveDiffSourceId(id),
      label: `Live ${id}`,
      detail: `${formatCount(events().filter((event) => (event.streamId ?? "default") === id).length)} events`,
    })),
    ...agent.sessions().map((session) => ({
      id: sessionDiffSourceId(session.id),
      label: `Capture ${shortSessionID(session.id)}`,
      detail: `${formatCount(session.eventCount)} events`,
    })),
  ]);
  createEffect(() => {
    const sources = diffSources();
    if (sources.length === 0) {
      return;
    }
    const nextBase = sources.some((source) => source.id === diffBaseSource())
      ? diffBaseSource()
      : sources[0].id;
    if (nextBase !== diffBaseSource()) {
      setDiffBaseSource(nextBase);
    }
    if (
      !diffCompareSource() ||
      diffCompareSource() === nextBase ||
      !sources.some((source) => source.id === diffCompareSource())
    ) {
      setDiffCompareSource(sources.find((source) => source.id !== nextBase)?.id ?? sources[0].id);
    }
  });
  createEffect(() => {
    void ensureDiffSourceEvents(diffBaseSource());
    void ensureDiffSourceEvents(diffCompareSource());
  });
  const streamDiff = createMemo(() => {
    const base = diffBaseSource();
    const compare = diffCompareSource();
    if (!base || !compare || base === compare) {
      return undefined;
    }
    const baseEvents = eventsForDiffSource(base);
    const compareEvents = eventsForDiffSource(compare);
    if (!baseEvents || !compareEvents) {
      return undefined;
    }
    return summarizeEventDiff(
      baseEvents,
      compareEvents,
      diffSourceLabel(base, diffSources()),
      diffSourceLabel(compare, diffSources()),
    );
  });
  const streamDiffLoading = createMemo(
    () =>
      Boolean(diffLoadingSources()[diffBaseSource()]) ||
      Boolean(diffLoadingSources()[diffCompareSource()]),
  );
  const endpoints = createMemo(() => {
    const status = agent.status();
    return status ? Object.entries(status.endpoints) : [];
  });

  async function ensureDiffSourceEvents(sourceId: string) {
    const sessionId = sessionIdFromDiffSource(sourceId);
    if (!sessionId || diffSessionEvents()[sourceId] || diffLoadingSources()[sourceId]) {
      return;
    }

    setDiffLoadingSources((current) => ({ ...current, [sourceId]: true }));
    setDiffError(undefined);
    try {
      const sessionEvents = await agent.readSessionEvents(sessionId);
      setDiffSessionEvents((current) => ({ ...current, [sourceId]: sessionEvents }));
    } catch (caught) {
      setDiffError(caught instanceof Error ? caught.message : "failed to load capture events");
    } finally {
      setDiffLoadingSources((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
    }
  }

  function eventsForDiffSource(sourceId: string): CaptureEvent[] | undefined {
    const liveStreamId = streamIdFromDiffSource(sourceId);
    if (liveStreamId) {
      return events().filter((event) => (event.streamId ?? "default") === liveStreamId);
    }
    return diffSessionEvents()[sourceId];
  }

  const runControl = async (action: () => Promise<void>) => {
    setControlError(undefined);
    try {
      await action();
    } catch (caught) {
      setControlError(caught instanceof Error ? caught.message : "agent control failed");
    }
  };

  const connect = () =>
    runControl(async () => {
      const url = targetUrl().trim();
      await agent.connectUpstream({
        streamId: streamId(),
        transport: transport(),
        url,
        headers: parseHeaders(headersText()),
        bearerToken: bearerToken(),
        apiKeyHeader: apiKeyHeader(),
        apiKey: apiKey(),
        subprotocols: subprotocols()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        autoReconnect: autoReconnect(),
        faults: {
          enabled: faultScenario() !== "off",
          scenario: faultScenario(),
          dropEvery: faultDropEvery(),
          duplicateEvery: faultDuplicateEvery(),
          reorderEvery: faultReorderEvery(),
          delayMs: faultDelayMs(),
          mutateEvery: faultMutateEvery(),
        },
      });
      rememberRecentTarget(url, setRecentTargets);
    });

  const selectDemoScenario = (scenario: DemoScenario) => {
    setDemoScenario(scenario);
    setTargetUrl(demoStreamUrl(scenario, transport()));
  };

  const selectTransport = (value: UpstreamTransport) => {
    setTransport(value);
    setTargetUrl(demoStreamUrl(demoScenario(), value));
  };

  createEffect(() => {
    if (liveFollowPaused() || replayEnabled()) {
      return;
    }
    const latest = latestFilteredEvent();
    if (latest && selectedSeq() !== latest.captureSeq) {
      setSelectedSeq(latest.captureSeq);
    }
  });

  createEffect(() => {
    const timeline = replayTimeline();
    if (!replayEnabled() || !replayPlaying() || timeline.length === 0) {
      return;
    }

    let lastTick = Date.now();
    const interval = window.setInterval(() => {
      const nowMs = Date.now();
      const elapsedMs = nowMs - lastTick;
      lastTick = nowMs;
      const endMs = eventReplayTimeMs(timeline[timeline.length - 1], timeline.length - 1);
      setReplayClockMs((clock) => {
        const nextClock = Math.min(endMs, clock + elapsedMs * replaySpeed());
        if (nextClock >= endMs) {
          setReplayPlaying(false);
        }
        return nextClock;
      });
    }, 50);

    onCleanup(() => window.clearInterval(interval));
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
    if (replayEnabled()) {
      const index = replayTimeline().findIndex((event) => event.captureSeq === captureSeq);
      if (index !== -1) {
        setReplayClockMs(eventReplayTimeMs(replayTimeline()[index], index));
      }
      return;
    }
    setSelectedSeq(captureSeq);
    const latest = latestFilteredEvent();
    if (!liveFollowPaused() && latest && captureSeq !== latest.captureSeq) {
      pauseLiveFollow();
    }
  };

  const startReplay = () => {
    const timeline = replayTimeline();
    if (timeline.length === 0) {
      return;
    }
    const selected = selectedSeq();
    const selectedIndex = timeline.findIndex((event) => event.captureSeq === selected);
    const startIndex = selectedIndex === -1 ? 0 : selectedIndex;
    setReplayEnabled(true);
    setReplayClockMs(eventReplayTimeMs(timeline[startIndex], startIndex));
    setReplayPlaying(true);
    setLiveFollowPaused(true);
    setPausedAfterSeq(latestCaptureSeq());
  };

  const stopReplay = () => {
    const current = replayCursorEvent();
    setReplayPlaying(false);
    setReplayEnabled(false);
    if (current) {
      setSelectedSeq(current.captureSeq);
    }
  };

  const seekReplay = (index: number) => {
    const timeline = replayTimeline();
    const nextIndex = Math.min(Math.max(index, 0), Math.max(0, timeline.length - 1));
    const event = timeline[nextIndex];
    if (event) {
      setReplayClockMs(eventReplayTimeMs(event, nextIndex));
    }
  };

  const clearCapture = () =>
    runControl(async () => {
      await agent.clearCapture();
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setReplayEnabled(false);
      setReplayPlaying(false);
      setFollowVersion((version) => version + 1);
    });

  const exportCapture = () => runControl(agent.exportJSONL);
  const exportTape = () => runControl(agent.exportTape);
  const importCapture = (file: File) =>
    runControl(async () => {
      await agent.importJSONL(file);
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setReplayEnabled(false);
      setReplayPlaying(false);
      setFollowVersion((version) => version + 1);
    });
  const refreshSessions = () => runControl(agent.refreshSessions);
  const openSavedSession = (sessionId: string) =>
    runControl(async () => {
      await agent.openSession(sessionId);
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setReplayEnabled(false);
      setReplayPlaying(false);
      setFollowVersion((version) => version + 1);
    });
  const deleteSavedSession = (sessionId: string) =>
    runControl(async () => {
      await agent.deleteSession(sessionId);
      setSelectedSeq(undefined);
      setPausedAfterSeq(0);
      setLiveFollowPaused(false);
      setReplayEnabled(false);
      setReplayPlaying(false);
      setFollowVersion((version) => version + 1);
    });
  const exportSavedSession = (sessionId: string) =>
    runControl(() => agent.exportSessionJSONL(sessionId));
  const exportSavedSessionTape = (sessionId: string) =>
    runControl(() => agent.exportSessionTape(sessionId));
  const replayEndpointForSession = (sessionId: string) =>
    sessionReplayUrl(agent.httpUrl, sessionId, {
      speed: replayServerSpeed(),
      loop: replayServerLoop(),
      paused: replayServerPaused(),
      format: replayServerFormat(),
    });
  const connectReplaySession = (sessionId: string) =>
    runControl(async () => {
      const replayUrl = replayEndpointForSession(sessionId);
      const replayStreamId = `replay-${sessionId.slice(-8)}`;
      setTransport("websocket");
      setTargetUrl(replayUrl);
      setStreamId(replayStreamId);
      setAutoReconnect(false);
      await agent.connectUpstream({
        streamId: replayStreamId,
        transport: "websocket",
        url: replayUrl,
        headers: {},
        bearerToken: "",
        apiKeyHeader: "",
        apiKey: "",
        subprotocols: [],
        autoReconnect: false,
      });
    });
  const saveExtractionRules = () =>
    runControl(async () => {
      const parsed = JSON.parse(extractionRulesText()) as ExtractionRules;
      const saved = await agent.saveExtractionRules(parsed);
      setExtractionRulesText(JSON.stringify(saved, null, 2));
    });

  return (
    <main class="relative h-full min-h-0 overflow-auto bg-neutral-950 pb-9 text-neutral-100 lg:overflow-hidden">
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

        <section class="grid min-h-0 grid-cols-1 grid-rows-[minmax(280px,42vh)_minmax(360px,1fr)_minmax(320px,45vh)_auto] overflow-visible lg:grid-cols-[340px_minmax(0,1fr)_360px] lg:grid-rows-[minmax(0,1fr)_260px] lg:overflow-hidden">
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
            transport={transport()}
            setTransport={selectTransport}
            targetUrl={targetUrl()}
            setTargetUrl={setTargetUrl}
            recentTargets={recentTargets()}
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
            faultScenario={faultScenario()}
            setFaultScenario={setFaultScenario}
            faultDropEvery={faultDropEvery()}
            setFaultDropEvery={setFaultDropEvery}
            faultDuplicateEvery={faultDuplicateEvery()}
            setFaultDuplicateEvery={setFaultDuplicateEvery}
            faultReorderEvery={faultReorderEvery()}
            setFaultReorderEvery={setFaultReorderEvery}
            faultDelayMs={faultDelayMs()}
            setFaultDelayMs={setFaultDelayMs}
            faultMutateEvery={faultMutateEvery()}
            setFaultMutateEvery={setFaultMutateEvery}
            connect={connect}
            reconnect={() => runControl(() => agent.reconnectUpstream(streamId()))}
            refreshSessions={refreshSessions}
            openSession={openSavedSession}
            deleteSession={deleteSavedSession}
            exportSession={exportSavedSession}
            exportSessionTape={exportSavedSessionTape}
            replayServerSpeed={replayServerSpeed()}
            setReplayServerSpeed={setReplayServerSpeed}
            replayServerFormat={replayServerFormat()}
            setReplayServerFormat={setReplayServerFormat}
            replayServerLoop={replayServerLoop()}
            setReplayServerLoop={setReplayServerLoop}
            replayServerPaused={replayServerPaused()}
            setReplayServerPaused={setReplayServerPaused}
            replayEndpoint={replayEndpointForSession}
            connectReplaySession={connectReplaySession}
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
                  aria-label="Filter captured events"
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
              <ReplayControls
                events={replayTimeline()}
                enabled={replayEnabled()}
                playing={replayPlaying()}
                speed={replaySpeed()}
                cursorIndex={replayCursorIndex()}
                clockMs={replayClockMs()}
                onStart={startReplay}
                onStop={stopReplay}
                onTogglePlaying={() => setReplayPlaying((playing) => !playing)}
                onSeek={seekReplay}
                onSpeedChange={setReplaySpeed}
              />
              <IconTextButton icon={Download} label="Export JSONL" onClick={exportCapture} />
              <IconTextButton icon={Download} label="Export Tape" onClick={exportTape} />
              <FileImportButton onImport={importCapture} />
              <IconTextButton icon={Eraser} label="Clear" onClick={clearCapture} />
            </div>
            <VirtualEventTable
              connected={agentView.isUpstreamConnected()}
              events={filteredEvents()}
              isLiveFollowPaused={liveFollowPaused()}
              followVersion={followVersion()}
              selectedSeq={selectedEvent()?.captureSeq}
              replayEnabled={replayEnabled()}
              replayCursorSeq={replayCursorEvent()?.captureSeq}
              replayedThroughSeq={replayCursorEvent()?.captureSeq}
              onSelect={selectEvent}
            />
          </section>

          <aside class="grid min-h-0 min-w-0 grid-rows-[auto_1fr] border-b border-neutral-800 bg-neutral-950 lg:col-start-3 lg:border-b-0">
            <PanelHeader
              icon={Server}
              title="Payload Inspector"
              detail={
                selectedEvent()
                  ? replayEnabled()
                    ? `Replay #${selectedEvent()?.captureSeq}`
                    : `Capture #${selectedEvent()?.captureSeq}`
                  : "No event selected"
              }
            />
            <Inspector event={selectedEvent()} />
          </aside>

          <section class="grid min-h-0 min-w-0 grid-cols-1 border-b border-neutral-800 bg-neutral-950 lg:col-start-2 lg:col-end-4 lg:row-start-2 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.35fr)] lg:border-l lg:border-t lg:border-b-0">
            <TopicPanel topics={topics()} activeFilter={filter()} onFilterTopic={setFilter} />
            <LatencyPanel analytics={latencyAnalytics()} onSelectEvent={selectEvent} />
            <StreamDiffPanel
              sources={diffSources()}
              baseSource={diffBaseSource()}
              compareSource={diffCompareSource()}
              summary={streamDiff()}
              loading={streamDiffLoading()}
              error={diffError()}
              onBaseChange={setDiffBaseSource}
              onCompareChange={setDiffCompareSource}
              onSelectEvent={selectEvent}
            />
            <TimelinePanel summary={timelineSummary()} onSelectEvent={selectEvent} />
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
  transport: UpstreamTransport;
  setTransport: (value: UpstreamTransport) => void;
  targetUrl: string;
  setTargetUrl: (value: string) => void;
  recentTargets: string[];
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
  faultScenario: FaultScenario;
  setFaultScenario: (value: FaultScenario) => void;
  faultDropEvery: number;
  setFaultDropEvery: (value: number) => void;
  faultDuplicateEvery: number;
  setFaultDuplicateEvery: (value: number) => void;
  faultReorderEvery: number;
  setFaultReorderEvery: (value: number) => void;
  faultDelayMs: number;
  setFaultDelayMs: (value: number) => void;
  faultMutateEvery: number;
  setFaultMutateEvery: (value: number) => void;
  connect: () => void;
  reconnect: () => void;
  refreshSessions: () => void;
  openSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  exportSession: (sessionId: string) => void;
  exportSessionTape: (sessionId: string) => void;
  replayServerSpeed: ReplaySpeed;
  setReplayServerSpeed: (value: ReplaySpeed) => void;
  replayServerFormat: ReplayServerFormat;
  setReplayServerFormat: (value: ReplayServerFormat) => void;
  replayServerLoop: boolean;
  setReplayServerLoop: (value: boolean) => void;
  replayServerPaused: boolean;
  setReplayServerPaused: (value: boolean) => void;
  replayEndpoint: (sessionId: string) => string;
  connectReplaySession: (sessionId: string) => void;
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
          onExportTape={props.exportSessionTape}
          replaySpeed={props.replayServerSpeed}
          onReplaySpeedChange={props.setReplayServerSpeed}
          replayFormat={props.replayServerFormat}
          onReplayFormatChange={props.setReplayServerFormat}
          replayLoop={props.replayServerLoop}
          onReplayLoopChange={props.setReplayServerLoop}
          replayPaused={props.replayServerPaused}
          onReplayPausedChange={props.setReplayServerPaused}
          replayEndpoint={props.replayEndpoint}
          onConnectReplay={props.connectReplaySession}
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
          <div class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2">
            <Field label="Stream ID" value={props.streamId} onInput={props.setStreamId} mono />
            <label class="grid min-w-0 gap-1">
              <span class="truncate text-xs text-neutral-500">Transport</span>
              <select
                class="field w-full min-w-0"
                value={props.transport}
                onInput={(event) =>
                  props.setTransport(event.currentTarget.value as UpstreamTransport)
                }
              >
                <option value="websocket">WebSocket</option>
                <option value="sse">SSE</option>
              </select>
            </label>
          </div>
          <Field
            label="Target URI"
            value={props.targetUrl}
            onInput={props.setTargetUrl}
            listId="recent-targets"
            mono
          />
          <datalist id="recent-targets">
            <For each={props.recentTargets}>{(target) => <option value={target} />}</For>
          </datalist>
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
            <div class="grid gap-2 rounded-md border border-neutral-800 bg-neutral-950/45 p-2">
              <label class="grid min-w-0 gap-1">
                <span class="truncate text-xs text-neutral-500">Fault injection</span>
                <select
                  class="field h-8 min-h-8 w-full py-1 text-xs"
                  value={props.faultScenario}
                  onInput={(event) =>
                    props.setFaultScenario(event.currentTarget.value as FaultScenario)
                  }
                >
                  <For each={faultScenarios}>
                    {(scenario) => <option value={scenario.id}>{scenario.label}</option>}
                  </For>
                </select>
              </label>
              <Show when={props.faultScenario !== "off"}>
                <div class="grid grid-cols-3 gap-2">
                  <NumericField
                    label="Drop"
                    value={props.faultDropEvery}
                    onInput={props.setFaultDropEvery}
                  />
                  <NumericField
                    label="Dup"
                    value={props.faultDuplicateEvery}
                    onInput={props.setFaultDuplicateEvery}
                  />
                  <NumericField
                    label="Reorder"
                    value={props.faultReorderEvery}
                    onInput={props.setFaultReorderEvery}
                  />
                  <NumericField
                    label="Delay ms"
                    value={props.faultDelayMs}
                    onInput={props.setFaultDelayMs}
                  />
                  <NumericField
                    label="Mutate"
                    value={props.faultMutateEvery}
                    onInput={props.setFaultMutateEvery}
                  />
                </div>
              </Show>
            </div>
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
  onExportTape: (sessionId: string) => void;
  replaySpeed: ReplaySpeed;
  onReplaySpeedChange: (speed: ReplaySpeed) => void;
  replayFormat: ReplayServerFormat;
  onReplayFormatChange: (format: ReplayServerFormat) => void;
  replayLoop: boolean;
  onReplayLoopChange: (loop: boolean) => void;
  replayPaused: boolean;
  onReplayPausedChange: (paused: boolean) => void;
  replayEndpoint: (sessionId: string) => string;
  onConnectReplay: (sessionId: string) => void;
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
          aria-label="Refresh sessions"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div class="grid gap-2 rounded-md border border-neutral-800 bg-neutral-950/45 p-2">
        <div class="grid grid-cols-2 gap-2">
          <label class="grid min-w-0 gap-1">
            <span class="truncate text-xs text-neutral-500">Replay speed</span>
            <select
              class="field h-8 w-full min-w-0"
              value={props.replaySpeed}
              onInput={(event) =>
                props.onReplaySpeedChange(Number(event.currentTarget.value) as ReplaySpeed)
              }
            >
              <For each={[0.25, 0.5, 1, 2, 4, 8] as ReplaySpeed[]}>
                {(speed) => <option value={speed}>{speed}x</option>}
              </For>
            </select>
          </label>
          <label class="grid min-w-0 gap-1">
            <span class="truncate text-xs text-neutral-500">Replay source</span>
            <select
              class="field h-8 w-full min-w-0"
              value={props.replayFormat}
              onInput={(event) =>
                props.onReplayFormatChange(event.currentTarget.value as ReplayServerFormat)
              }
            >
              <option value="raw">Raw</option>
              <option value="jsonl">JSONL</option>
              <option value="tape">Tape</option>
            </select>
          </label>
        </div>
        <div class="grid grid-cols-2 gap-2 text-sm text-neutral-300">
          <label class="flex min-w-0 items-center gap-2">
            <input
              class="shrink-0 accent-cyan-300"
              type="checkbox"
              checked={props.replayLoop}
              onInput={(event) => props.onReplayLoopChange(event.currentTarget.checked)}
            />
            <span class="truncate">Loop</span>
          </label>
          <label class="flex min-w-0 items-center gap-2">
            <input
              class="shrink-0 accent-cyan-300"
              type="checkbox"
              checked={props.replayPaused}
              onInput={(event) => props.onReplayPausedChange(event.currentTarget.checked)}
            />
            <span class="truncate">Start paused</span>
          </label>
        </div>
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
                  <div class="grid grid-cols-5 gap-1">
                    <MiniIconButton
                      icon={FolderOpen}
                      label="Open"
                      onClick={() => props.onOpen(session.id)}
                    />
                    <MiniIconButton
                      icon={Play}
                      label="Replay"
                      onClick={() => props.onConnectReplay(session.id)}
                    />
                    <MiniIconButton
                      icon={Download}
                      label="JSONL"
                      onClick={() => props.onExport(session.id)}
                    />
                    <MiniIconButton
                      icon={Download}
                      label="Tape"
                      onClick={() => props.onExportTape(session.id)}
                    />
                    <MiniIconButton
                      icon={Trash2}
                      label="Delete"
                      onClick={() => props.onDelete(session.id)}
                      danger
                    />
                  </div>
                  <div class="truncate font-mono text-[11px] text-neutral-500">
                    {props.replayEndpoint(session.id)}
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
                  <div class="flex min-w-0 items-center gap-1">
                    <span class="badge-muted shrink-0">{formatTransport(stream.transport)}</span>
                    <StatusPill
                      online={stream.state === "connected"}
                      label={stream.state}
                      compact
                    />
                  </div>
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
        aria-label="Extraction rules JSON"
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
  replayEnabled: boolean;
  replayCursorSeq: number | undefined;
  replayedThroughSeq: number | undefined;
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
        <span>Stream / transport</span>
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
          role="region"
          aria-label="Captured events"
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
                    } ${event.issues?.length ? "issue-row" : ""} ${
                      props.replayEnabled &&
                      props.replayedThroughSeq !== undefined &&
                      event.captureSeq > props.replayedThroughSeq
                        ? "future-row"
                        : ""
                    }`}
                    aria-current={props.selectedSeq === event.captureSeq ? "true" : undefined}
                    aria-label={eventRowLabel(event)}
                    style={{ transform: `translateY(${eventIndex() * rowHeight}px)` }}
                    onClick={() => props.onSelect(event.captureSeq)}
                  >
                    <span class="font-mono text-neutral-300">{event.captureSeq}</span>
                    <span class="truncate font-mono text-neutral-500">
                      {event.streamId ?? "default"} / {formatTransport(event.transport)}
                    </span>
                    <span class="font-mono text-neutral-400">
                      {formatEventTime(event.receivedAt)}
                    </span>
                    <span class="truncate font-mono font-medium text-cyan-100">
                      {event.displayTopic ?? event.topic ?? "unknown"}
                    </span>
                    <span>
                      <EventStatusBadge
                        event={event}
                        replayState={eventReplayState(
                          event,
                          props.replayEnabled,
                          props.replayCursorSeq,
                          props.replayedThroughSeq,
                        )}
                      />
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

type InspectorTab = "parsed" | "payload" | "correlation" | "raw" | "issues" | "metadata";

function Inspector(props: { event: CaptureEvent | undefined }) {
  const [tab, setTab] = createSignal<InspectorTab>("payload");
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "parsed", label: "Parsed" },
    { id: "payload", label: "Payload" },
    { id: "correlation", label: "Trace" },
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
              <dt class="text-neutral-500">Trace</dt>
              <dd class="truncate text-right font-mono text-neutral-300">
                {event().correlation?.traceId ?? "none"}
              </dd>
            </dl>
          </div>
          <div
            class="flex min-w-0 gap-1 border-b border-neutral-800 bg-neutral-900/50 p-1"
            role="tablist"
            aria-label="Payload inspector tabs"
          >
            <For each={tabs}>
              {(item) => (
                <button
                  type="button"
                  class={`inspector-tab ${tab() === item.id ? "selected" : ""}`}
                  role="tab"
                  aria-selected={tab() === item.id ? "true" : "false"}
                  aria-controls={`inspector-panel-${item.id}`}
                  id={`inspector-tab-${item.id}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
          <div
            class="min-h-0 overflow-auto p-4"
            role="tabpanel"
            id={`inspector-panel-${tab()}`}
            aria-labelledby={`inspector-tab-${tab()}`}
          >
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
            <Show when={tab() === "correlation"}>
              <CorrelationPanel event={event()} />
            </Show>
            <Show when={tab() !== "issues"}>
              <Show when={tab() !== "correlation"}>
                <pre class="min-h-[180px] overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-neutral-200">
                  {formatInspectorTab(event(), tab())}
                </pre>
              </Show>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

function CorrelationPanel(props: { event: CaptureEvent }) {
  const correlation = () => props.event.correlation;
  return (
    <Show
      when={correlation()}
      fallback={<div class="text-sm text-neutral-500">No trace or log correlation fields.</div>}
    >
      {(value) => (
        <div class="grid gap-3">
          <dl class="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt class="text-neutral-500">Trace ID</dt>
            <dd class="truncate font-mono text-neutral-100">{value().traceId ?? "--"}</dd>
            <dt class="text-neutral-500">Span ID</dt>
            <dd class="truncate font-mono text-neutral-200">{value().spanId ?? "--"}</dd>
            <dt class="text-neutral-500">Parent span</dt>
            <dd class="truncate font-mono text-neutral-300">{value().parentSpanId ?? "--"}</dd>
            <dt class="text-neutral-500">Log ID</dt>
            <dd class="truncate font-mono text-neutral-300">{value().logId ?? "--"}</dd>
            <dt class="text-neutral-500">Service</dt>
            <dd class="truncate font-mono text-neutral-300">{value().serviceName ?? "--"}</dd>
            <dt class="text-neutral-500">Source</dt>
            <dd class="truncate font-mono text-neutral-400">{value().source ?? "--"}</dd>
          </dl>
          <Show when={value().traceQueryUrl || value().logQueryUrl || value().otlpEndpoint}>
            <div class="grid gap-2 rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs">
              <Show when={value().traceQueryUrl}>
                {(href) => (
                  <a
                    class="truncate font-mono text-cyan-200 hover:text-cyan-100"
                    href={href()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    trace query: {href()}
                  </a>
                )}
              </Show>
              <Show when={value().logQueryUrl}>
                {(href) => (
                  <a
                    class="truncate font-mono text-cyan-200 hover:text-cyan-100"
                    href={href()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    log query: {href()}
                  </a>
                )}
              </Show>
              <Show when={value().otlpEndpoint}>
                {(endpoint) => (
                  <span class="truncate font-mono text-neutral-400">otlp: {endpoint()}</span>
                )}
              </Show>
            </div>
          </Show>
          <pre class="min-h-[120px] overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-neutral-300">
            {stringifyInspectorValue(value())}
          </pre>
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
                aria-pressed={props.activeFilter === topic.name ? "true" : "false"}
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

function LatencyPanel(props: {
  analytics: LatencyAnalytics;
  onSelectEvent: (captureSeq: number) => void;
}) {
  const sourceLagCoverage = createMemo(() =>
    props.analytics.eventCount === 0
      ? "No source timestamps"
      : `${formatCount(props.analytics.sourceLag.sampleCount)} / ${formatCount(
          props.analytics.eventCount,
        )} stamped`,
  );

  return (
    <div class="min-h-0 border-b border-neutral-800 lg:border-r lg:border-b-0">
      <PanelHeader icon={BarChart3} title="Latency" detail={sourceLagCoverage()} />
      <Show
        when={
          props.analytics.sourceLag.sampleCount > 0 ||
          props.analytics.receiveInterval.sampleCount > 0
        }
        fallback={
          <EmptyPanel
            icon={BarChart3}
            title="No latency samples"
            detail="Source lag needs extracted timestamps; receive intervals appear after two events."
          />
        }
      >
        <div class="grid max-h-full gap-3 overflow-auto p-3">
          <LatencyMetricBlock
            title="Source Lag"
            summary={props.analytics.sourceLag}
            buckets={props.analytics.sourceLagBuckets}
          />
          <LatencyMetricBlock
            title="Receive Interval"
            summary={props.analytics.receiveInterval}
            buckets={props.analytics.receiveIntervalBuckets}
          />
          <div class="grid gap-2">
            <LatencyHotspotButton
              label="Worst lag"
              hotspot={props.analytics.worstSourceLag}
              onSelect={props.onSelectEvent}
            />
            <LatencyHotspotButton
              label="Longest interval"
              hotspot={props.analytics.longestReceiveInterval}
              onSelect={props.onSelectEvent}
            />
          </div>
        </div>
      </Show>
    </div>
  );
}

function LatencyMetricBlock(props: {
  title: string;
  summary: LatencyAnalytics["sourceLag"];
  buckets: LatencyAnalytics["sourceLagBuckets"];
}) {
  return (
    <div class="grid gap-2 rounded-md border border-neutral-800 bg-neutral-900/55 p-3">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <span class="truncate text-xs font-medium uppercase text-neutral-500">{props.title}</span>
        <span class="font-mono text-xs text-neutral-500">
          {formatCount(props.summary.sampleCount)} samples
        </span>
      </div>
      <div class="grid grid-cols-3 gap-2 text-xs">
        <TopicMetric label="P50" value={formatLatencyValue(props.summary.p50Ms)} />
        <TopicMetric label="P95" value={formatLatencyValue(props.summary.p95Ms)} />
        <TopicMetric label="Max" value={formatLatencyValue(props.summary.maxMs)} />
      </div>
      <HistogramBars buckets={props.buckets} />
    </div>
  );
}

function HistogramBars(props: { buckets: LatencyAnalytics["sourceLagBuckets"] }) {
  const maxCount = createMemo(() => Math.max(1, ...props.buckets.map((bucket) => bucket.count)));
  return (
    <div class="grid grid-cols-9 items-end gap-1 pt-1">
      <For each={props.buckets}>
        {(bucket) => (
          <div class="grid min-w-0 gap-1">
            <div class="flex h-16 items-end rounded-sm bg-neutral-950/70 px-0.5">
              <div
                class="w-full rounded-sm bg-teal-300/70"
                style={{
                  height: `${Math.max(4, Math.round((bucket.count / maxCount()) * 64))}px`,
                  opacity: bucket.count === 0 ? 0.28 : 1,
                }}
                title={`${bucket.label}: ${formatCount(bucket.count)}`}
              />
            </div>
            <span class="truncate text-center font-mono text-[10px] text-neutral-600">
              {bucket.label}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

function LatencyHotspotButton(props: {
  label: string;
  hotspot: LatencyAnalytics["worstSourceLag"];
  onSelect: (captureSeq: number) => void;
}) {
  return (
    <Show
      when={props.hotspot}
      fallback={
        <div class="grid gap-1 rounded-md border border-neutral-800 bg-neutral-950/45 p-2 text-xs text-neutral-500">
          <span>{props.label}</span>
          <span class="font-mono">--</span>
        </div>
      }
    >
      {(hotspot) => (
        <button
          type="button"
          class="grid min-w-0 grid-cols-[1fr_auto] gap-2 rounded-md border border-neutral-800 bg-neutral-950/45 p-2 text-left text-xs hover:border-neutral-700 hover:bg-neutral-900"
          onClick={() => props.onSelect(hotspot().event.captureSeq)}
        >
          <span class="truncate text-neutral-500">{props.label}</span>
          <span class="font-mono text-neutral-200">{formatLatencyValue(hotspot().valueMs)}</span>
          <span class="truncate font-mono text-neutral-400">
            #{hotspot().event.captureSeq} {eventScopeLabel(hotspot().event)}
          </span>
          <span class="truncate text-right font-mono text-neutral-600">
            {formatEventTime(hotspot().event.receivedAt)}
          </span>
        </button>
      )}
    </Show>
  );
}

function StreamDiffPanel(props: {
  sources: DiffSourceOption[];
  baseSource: string;
  compareSource: string;
  summary: StreamDiffSummary | undefined;
  loading: boolean;
  error: string | undefined;
  onBaseChange: (sourceId: string) => void;
  onCompareChange: (sourceId: string) => void;
  onSelectEvent: (captureSeq: number) => void;
}) {
  const issueTotal = createMemo(
    () =>
      (props.summary?.missing ?? 0) + (props.summary?.extra ?? 0) + (props.summary?.divergent ?? 0),
  );

  return (
    <div class="min-h-0 border-b border-neutral-800 lg:border-r lg:border-b-0">
      <PanelHeader
        icon={GitCompare}
        title="Stream Diff"
        detail={`${formatCount(issueTotal())} differences`}
      />
      <Show
        when={props.sources.length > 1 && props.summary}
        fallback={
          <Show
            when={props.loading}
            fallback={
              <EmptyPanel
                icon={GitCompare}
                title={props.error ? "Diff unavailable" : "No comparable sources"}
                detail={
                  props.error ??
                  "Capture at least two streams or save captures to align events by scope, type, and sequence."
                }
              />
            }
          >
            <EmptyPanel
              icon={GitCompare}
              title="Loading diff source"
              detail="Saved capture events are loading."
            />
          </Show>
        }
      >
        {(summary) => (
          <div class="grid max-h-full gap-3 overflow-auto p-3">
            <div class="grid grid-cols-2 gap-2">
              <label class="grid min-w-0 gap-1">
                <span class="truncate text-xs text-neutral-500">Base</span>
                <select
                  class="field h-8 min-h-8 w-full py-1 text-xs"
                  value={props.baseSource}
                  onInput={(event) => props.onBaseChange(event.currentTarget.value)}
                >
                  <For each={props.sources}>
                    {(source) => (
                      <option value={source.id}>
                        {source.label} ({source.detail})
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="grid min-w-0 gap-1">
                <span class="truncate text-xs text-neutral-500">Compare</span>
                <select
                  class="field h-8 min-h-8 w-full py-1 text-xs"
                  value={props.compareSource}
                  onInput={(event) => props.onCompareChange(event.currentTarget.value)}
                >
                  <For each={props.sources}>
                    {(source) => (
                      <option value={source.id}>
                        {source.label} ({source.detail})
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </div>

            <div class="grid grid-cols-4 gap-2 text-xs">
              <TopicMetric label="Match" value={formatCount(summary().matched)} />
              <TopicMetric label="Missing" value={formatCount(summary().missing)} />
              <TopicMetric label="Extra" value={formatCount(summary().extra)} />
              <TopicMetric label="Diff" value={formatCount(summary().divergent)} />
            </div>

            <div class="grid gap-2">
              <For
                each={summary()
                  .rows.filter((row) => row.status !== "matched")
                  .slice(0, 12)}
                fallback={<div class="text-sm text-neutral-500">Sources are aligned.</div>}
              >
                {(row) => {
                  const event = () => row.baseEvent ?? row.compareEvent;
                  const selectableEvent = () => {
                    if (row.baseEvent && streamIdFromDiffSource(props.baseSource)) {
                      return row.baseEvent;
                    }
                    if (row.compareEvent && streamIdFromDiffSource(props.compareSource)) {
                      return row.compareEvent;
                    }
                    return undefined;
                  };
                  return (
                    <button
                      type="button"
                      class={`grid min-w-0 grid-cols-[82px_1fr] gap-2 rounded-md border border-neutral-800 bg-neutral-950/45 p-2 text-left text-xs ${
                        selectableEvent()
                          ? "hover:border-neutral-700 hover:bg-neutral-900"
                          : "cursor-default"
                      }`}
                      onClick={() => {
                        const target = selectableEvent();
                        if (target) {
                          props.onSelectEvent(target.captureSeq);
                        }
                      }}
                    >
                      <span class={row.status === "divergent" ? "badge-error" : "badge-muted"}>
                        {formatDiffStatus(row.status)}
                      </span>
                      <span class="truncate font-mono text-neutral-300">{row.key}</span>
                      <span class="font-mono text-neutral-600">#{event()?.captureSeq ?? "--"}</span>
                      <span class="truncate text-neutral-500">{row.detail}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

type ReplayEventState = "current" | "replayed" | "queued" | undefined;

function EventStatusBadge(props: { event: CaptureEvent; replayState?: ReplayEventState }) {
  const code = () => props.event.issues?.[0]?.code;
  const label = () => {
    if (props.replayState === "current") {
      return "Replay";
    }
    if (props.replayState === "queued") {
      return "Queued";
    }
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
  const className = () => {
    if (props.replayState === "current") {
      return "badge-replay";
    }
    if (props.replayState === "queued") {
      return "badge-muted";
    }
    return code() ? "badge-error" : "badge-live";
  };
  return <span class={className()}>{label()}</span>;
}

function TimelinePanel(props: {
  summary: TimelineSummary;
  onSelectEvent: (captureSeq: number) => void;
}) {
  const recentMarkers = createMemo(() => props.summary.markers.slice(0, 6));
  const chartMarkers = createMemo(() => props.summary.markers.slice(0, 36));
  return (
    <div class="grid min-h-0 grid-rows-[auto_1fr]">
      <PanelHeader
        icon={Clock3}
        title="Timeline"
        detail={`${formatCount(props.summary.eventCount)} events / ${formatCount(props.summary.issueCount)} flagged`}
      />
      <Show
        when={props.summary.startMs !== undefined}
        fallback={
          <EmptyPanel
            icon={Clock3}
            title="No timeline yet"
            detail="Density, issue markers, reconnects, stale intervals, and latency appear after capture starts."
          />
        }
      >
        <div class="grid min-h-0 grid-rows-[auto_auto_1fr] gap-3 overflow-auto p-3">
          <div class="grid grid-cols-4 gap-2 text-xs">
            <TopicMetric label="Window" value={formatTimelineDuration(props.summary.durationMs)} />
            <TopicMetric label="Peak" value={`${formatCount(props.summary.maxBucketEvents)}/bin`} />
            <TopicMetric
              label="Lag max"
              value={formatLatencyValue(props.summary.maxBucketLatencyMs)}
            />
            <TopicMetric label="Stale" value={formatCount(props.summary.staleIntervals.length)} />
          </div>

          <div class="relative h-[118px] overflow-hidden rounded-md border border-neutral-800 bg-neutral-950/70 px-3 pb-5 pt-3">
            <div class="absolute inset-x-3 top-2 h-4">
              <For each={props.summary.staleIntervals}>
                {(interval) => (
                  <div
                    class="absolute top-0 h-4 rounded-sm bg-amber-300/18"
                    style={{
                      left: `${timelinePositionPercent(interval.startMs, props.summary)}%`,
                      width: `${timelineWidthPercent(interval.startMs, interval.endMs, props.summary)}%`,
                    }}
                    title={`stale: ${interval.topic}`}
                  />
                )}
              </For>
            </div>

            <div class="absolute inset-x-3 bottom-7 top-8 grid items-end gap-0.5">
              <div
                class="grid h-full items-end gap-0.5"
                style={{
                  "grid-template-columns": `repeat(${props.summary.bucketCount}, minmax(0, 1fr))`,
                }}
              >
                <For each={props.summary.buckets}>
                  {(bucket) => (
                    <button
                      type="button"
                      class={`relative min-h-0 rounded-sm ${
                        bucket.issueCount > 0
                          ? "bg-amber-300/55 hover:bg-amber-300/70"
                          : bucket.reconnectCount > 0
                            ? "bg-sky-300/55 hover:bg-sky-300/70"
                            : "bg-cyan-300/40 hover:bg-cyan-300/60"
                      } disabled:bg-neutral-800/70`}
                      aria-label={`${formatCount(bucket.eventCount)} events, ${formatCount(
                        bucket.issueCount,
                      )} issues, ${formatLatencyValue(bucket.maxSourceLagMs)} max lag`}
                      style={{
                        height: `${timelineBucketHeight(bucket.eventCount, props.summary)}px`,
                        opacity: bucket.eventCount === 0 ? 0.35 : 1,
                      }}
                      disabled={!bucket.representativeEvent}
                      onClick={() => {
                        if (bucket.representativeEvent) {
                          props.onSelectEvent(bucket.representativeEvent.captureSeq);
                        }
                      }}
                      title={`${formatCount(bucket.eventCount)} events / ${formatCount(bucket.issueCount)} issues / ${formatLatencyValue(
                        bucket.maxSourceLagMs,
                      )} max lag`}
                    >
                      <Show when={bucket.maxSourceLagMs !== undefined}>
                        <span
                          class="absolute inset-x-0 bottom-0 rounded-sm bg-teal-100/80"
                          style={{
                            height: `${timelineLatencyHeight(bucket.maxSourceLagMs, props.summary)}px`,
                          }}
                        />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="absolute inset-x-3 top-7 h-[70px]">
              <For each={chartMarkers()}>
                {(marker) => (
                  <button
                    type="button"
                    class={`timeline-marker absolute top-0 h-[70px] w-2 rounded-full ${
                      marker.kind === "reconnect" ? "bg-sky-300" : "bg-amber-300"
                    }`}
                    aria-label={`${marker.label}: ${marker.detail}`}
                    style={{ left: `${timelinePositionPercent(marker.atMs, props.summary)}%` }}
                    title={`${marker.label}: ${marker.detail}`}
                    onClick={() => props.onSelectEvent(marker.event.captureSeq)}
                  />
                )}
              </For>
            </div>

            <div class="absolute inset-x-3 bottom-2 flex items-center justify-between gap-3 text-[10px] text-neutral-600">
              <span class="font-mono">{formatTimelineTime(props.summary.startMs)}</span>
              <div class="flex items-center gap-2">
                <TimelineLegend colorClass="bg-cyan-300/60" label="density" />
                <TimelineLegend colorClass="bg-teal-100/80" label="lag" />
                <TimelineLegend colorClass="bg-amber-300/60" label="issue/stale" />
                <TimelineLegend colorClass="bg-sky-300/70" label="reconnect" />
              </div>
              <span class="font-mono">{formatTimelineTime(props.summary.endMs)}</span>
            </div>
          </div>

          <div class="min-h-0 overflow-auto">
            <Show
              when={recentMarkers().length > 0}
              fallback={<div class="text-sm text-neutral-500">No issue or reconnect markers.</div>}
            >
              <div class="grid gap-2">
                <For each={recentMarkers()}>
                  {(marker) => (
                    <button
                      type="button"
                      class="grid min-w-0 grid-cols-[82px_94px_1fr] items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-left text-xs hover:border-neutral-700 hover:bg-neutral-900"
                      onClick={() => props.onSelectEvent(marker.event.captureSeq)}
                    >
                      <span class="font-mono text-neutral-500">
                        {formatEventTime(marker.event.receivedAt)}
                      </span>
                      <span class={marker.kind === "reconnect" ? "badge-replay" : "badge-error"}>
                        {marker.label}
                      </span>
                      <span class="min-w-0 truncate text-neutral-300">{marker.detail}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function TimelineLegend(props: { colorClass: string; label: string }) {
  return (
    <span class="inline-flex min-w-0 items-center gap-1">
      <span class={`h-1.5 w-3 rounded-sm ${props.colorClass}`} />
      <span class="truncate">{props.label}</span>
    </span>
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
  listId?: string;
  mono?: boolean;
}) {
  return (
    <label class="grid min-w-0 gap-1">
      <span class="truncate text-xs text-neutral-500">{props.label}</span>
      <input
        class={`field w-full min-w-0 ${props.mono ? "font-mono" : ""}`}
        type={props.type ?? "text"}
        list={props.listId}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function NumericField(props: { label: string; value: number; onInput: (value: number) => void }) {
  return (
    <label class="grid min-w-0 gap-1">
      <span class="truncate text-xs text-neutral-500">{props.label}</span>
      <input
        class="field h-8 min-h-8 w-full min-w-0 py-1 font-mono text-xs"
        type="number"
        min="0"
        value={props.value}
        onInput={(event) => props.onInput(Math.max(0, Number(event.currentTarget.value) || 0))}
      />
    </label>
  );
}

function IconTextButton(props: {
  icon: Component<{ size?: number; class?: string }>;
  label: string;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  const disabled = () => props.disabled ?? !props.onClick;
  return (
    <button
      type="button"
      class={`inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md border px-3 text-sm transition-colors active:scale-[0.98] ${
        props.primary
          ? "border-cyan-300/40 bg-cyan-300/15 text-cyan-100 hover:bg-cyan-300/20"
          : "border-neutral-700 bg-neutral-900 text-neutral-100 hover:border-neutral-500 hover:bg-neutral-800"
      } disabled:opacity-45 disabled:active:scale-100`}
      disabled={disabled()}
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

function ReplayControls(props: {
  events: CaptureEvent[];
  enabled: boolean;
  playing: boolean;
  speed: ReplaySpeed;
  cursorIndex: number;
  clockMs: number;
  onStart: () => void;
  onStop: () => void;
  onTogglePlaying: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
}) {
  const cursor = () => (props.enabled ? Math.max(0, props.cursorIndex) : 0);
  const disabled = () => props.events.length === 0;
  return (
    <div class="grid min-w-[280px] flex-1 grid-cols-[auto_auto_minmax(96px,1fr)_76px] items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/55 px-2 py-1">
      <IconTextButton
        icon={props.enabled && props.playing ? Pause : Play}
        label={props.enabled ? (props.playing ? "Pause replay" : "Play replay") : "Replay"}
        onClick={props.enabled ? props.onTogglePlaying : props.onStart}
        disabled={disabled()}
        primary={props.enabled}
      />
      <button
        type="button"
        class="inline-flex h-8 min-w-0 items-center justify-center rounded-md border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45"
        disabled={!props.enabled}
        onClick={props.onStop}
      >
        Stop
      </button>
      <label class="grid min-w-0 grid-cols-[1fr_auto] items-center gap-2">
        <input
          class="min-w-0 accent-cyan-300"
          type="range"
          min="0"
          max={Math.max(0, props.events.length - 1)}
          value={cursor()}
          disabled={!props.enabled || props.events.length < 2}
          onInput={(event) => props.onSeek(Number(event.currentTarget.value))}
        />
        <span class="w-[72px] truncate text-right font-mono text-xs text-neutral-400">
          {props.enabled
            ? formatReplayClock(props.clockMs)
            : formatReplayClock(props.events[0]?.receivedAt)}
        </span>
      </label>
      <select
        class="field h-8 min-h-8 w-full py-1 text-xs"
        value={props.speed}
        disabled={!props.enabled}
        onInput={(event) => props.onSpeedChange(Number(event.currentTarget.value) as ReplaySpeed)}
      >
        <option value={0.25}>0.25x</option>
        <option value={0.5}>0.5x</option>
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
        <option value={8}>8x</option>
      </select>
    </div>
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
      aria-label={props.label}
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
          ? "Captured upstream messages will render here in capture order."
          : "Connect an upstream WebSocket or SSE stream to start capturing events."
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

function demoStreamUrl(scenario: DemoScenario, transport: UpstreamTransport): string {
  const base =
    runtimeQueryValue(transport === "sse" ? "demoHttpUrl" : "demoWsUrl") ??
    (transport === "sse" ? "http://localhost:8791" : "ws://localhost:8791");
  const params = new URLSearchParams({ scenario });
  if (scenario === "fuzz") {
    params.set("mode", "mixed");
    params.set("seed", "28");
    params.set("count", "24");
  }
  return `${base}/stream?${params.toString()}`;
}

function runtimeQueryValue(name: string): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const value = new URLSearchParams(window.location.search).get(name)?.trim();
  return value || undefined;
}

function readRecentTargets(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_TARGETS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === "string")
      .slice(0, MAX_RECENT_TARGETS);
  } catch {
    return [];
  }
}

function rememberRecentTarget(target: string, setRecentTargets: (value: string[]) => void): void {
  if (!target) {
    return;
  }

  const next = [target, ...readRecentTargets().filter((value) => value !== target)].slice(
    0,
    MAX_RECENT_TARGETS,
  );
  setRecentTargets(next);
  window.localStorage.setItem(RECENT_TARGETS_KEY, JSON.stringify(next));
}

function sessionReplayUrl(
  httpUrl: string,
  sessionId: string,
  options: { speed: ReplaySpeed; loop: boolean; paused: boolean; format: ReplayServerFormat },
): string {
  const params = new URLSearchParams({
    speed: String(options.speed),
    loop: String(options.loop),
    paused: String(options.paused),
    format: options.format,
  });
  return `${httpUrl.replace(/^http/, "ws")}/sessions/${encodeURIComponent(
    sessionId,
  )}/replay?${params.toString()}`;
}

function formatTransport(value: CaptureTransport | undefined): string {
  if (value === "sse") {
    return "SSE";
  }
  return "WS";
}

function liveDiffSourceId(streamId: string): string {
  return `live:${streamId}`;
}

function sessionDiffSourceId(sessionId: string): string {
  return `session:${sessionId}`;
}

function streamIdFromDiffSource(sourceId: string): string | undefined {
  return sourceId.startsWith("live:") ? sourceId.slice("live:".length) : undefined;
}

function sessionIdFromDiffSource(sourceId: string): string | undefined {
  return sourceId.startsWith("session:") ? sourceId.slice("session:".length) : undefined;
}

function diffSourceLabel(sourceId: string, sources: DiffSourceOption[]): string {
  return sources.find((source) => source.id === sourceId)?.label ?? sourceId;
}

function shortSessionID(sessionId: string): string {
  if (sessionId.length <= 16) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-5)}`;
}

function formatDiffStatus(value: string): string {
  if (value === "divergent") {
    return "Diff";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function timelineBucketHeight(eventCount: number, summary: TimelineSummary): number {
  if (eventCount === 0) {
    return 4;
  }
  return Math.max(8, Math.round((eventCount / summary.maxBucketEvents) * 58));
}

function timelineLatencyHeight(value: number | undefined, summary: TimelineSummary): number {
  if (value === undefined || summary.maxBucketLatencyMs <= 0) {
    return 0;
  }
  return Math.max(3, Math.round((value / summary.maxBucketLatencyMs) * 30));
}

function timelinePositionPercent(valueMs: number | undefined, summary: TimelineSummary): number {
  if (valueMs === undefined || summary.startMs === undefined || summary.durationMs <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, ((valueMs - summary.startMs) / summary.durationMs) * 100));
}

function timelineWidthPercent(startMs: number, endMs: number, summary: TimelineSummary): number {
  return Math.max(
    0.8,
    timelinePositionPercent(endMs, summary) - timelinePositionPercent(startMs, summary),
  );
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

function eventRowLabel(event: CaptureEvent): string {
  const issueCount = event.issues?.length ?? 0;
  const status =
    issueCount > 0 ? `${formatCount(issueCount)} issue${issueCount === 1 ? "" : "s"}` : "OK";
  const scope = eventScopeLabel(event);
  const eventType = event.displayType ?? event.eventType ?? event.opcode;
  return `Capture ${event.captureSeq}, ${scope}, ${eventType}, ${status}`;
}

function eventReplayTimeMs(event: CaptureEvent, index: number): number {
  const parsed = Date.parse(event.receivedAt);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  return index * 100;
}

function eventReplayState(
  event: CaptureEvent,
  replayEnabled: boolean,
  replayCursorSeq: number | undefined,
  replayedThroughSeq: number | undefined,
): ReplayEventState {
  if (!replayEnabled || replayedThroughSeq === undefined) {
    return undefined;
  }
  if (event.captureSeq === replayCursorSeq) {
    return "current";
  }
  if (event.captureSeq > replayedThroughSeq) {
    return "queued";
  }
  return "replayed";
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
  if (tab === "correlation") {
    return stringifyInspectorValue(event.correlation ?? null);
  }
  return stringifyInspectorValue({
    id: event.id,
    streamId: event.streamId,
    connectionId: event.connectionId,
    transport: event.transport,
    transportMeta: event.transportMeta,
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
    correlation: event.correlation,
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

function formatReplayClock(value: string | number | undefined): string {
  if (value === undefined) {
    return "--:--:--";
  }
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function formatTimelineTime(value: number | undefined): string {
  if (value === undefined) {
    return "--";
  }
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimelineDuration(value: number): string {
  if (value >= 60_000) {
    return `${Math.round(value / 60_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}s`;
  }
  return `${Math.round(value)}ms`;
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

function formatLatencyValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1_000) {
    return `${sign}${Math.round(absolute)}ms`;
  }
  if (absolute < 10_000) {
    return `${sign}${(absolute / 1_000).toFixed(1)}s`;
  }
  return `${sign}${Math.round(absolute / 1_000)}s`;
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
