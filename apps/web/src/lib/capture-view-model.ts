import type {
  CaptureEvent,
  CaptureIssue,
  TopicState as AgentTopicState,
} from "@/lib/agent-protocol";

export type TopicHealthState = "live" | "warming" | "quiet" | "stale";

export type TopicSummary = {
  name: string;
  count: number;
  issueCount: number;
  keyCount: number;
  lastSeq: number | undefined;
  gapCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  ratePerSecond: number;
  lastSeenAt: number;
  freshnessMs: number;
  stale: boolean;
  staleCount: number;
  staleThresholdMs: number | undefined;
  state: TopicHealthState;
};

export type IssueSummary = {
  event: CaptureEvent;
  issue: CaptureIssue;
};

export type LatencyMetricSummary = {
  sampleCount: number;
  minMs: number | undefined;
  p50Ms: number | undefined;
  p95Ms: number | undefined;
  maxMs: number | undefined;
  averageMs: number | undefined;
};

export type LatencyHistogramBucket = {
  label: string;
  minMs: number;
  maxMs: number | undefined;
  count: number;
};

export type LatencyHotspot = {
  event: CaptureEvent;
  valueMs: number;
};

export type LatencyAnalytics = {
  eventCount: number;
  sourceLag: LatencyMetricSummary;
  receiveInterval: LatencyMetricSummary;
  sourceLagBuckets: LatencyHistogramBucket[];
  receiveIntervalBuckets: LatencyHistogramBucket[];
  worstSourceLag: LatencyHotspot | undefined;
  longestReceiveInterval: LatencyHotspot | undefined;
};

export type TimelineBucket = {
  index: number;
  startMs: number;
  endMs: number;
  eventCount: number;
  issueCount: number;
  reconnectCount: number;
  averageSourceLagMs: number | undefined;
  maxSourceLagMs: number | undefined;
  representativeEvent: CaptureEvent | undefined;
};

export type TimelineMarkerKind = "issue" | "reconnect";

export type TimelineMarker = {
  kind: TimelineMarkerKind;
  atMs: number;
  label: string;
  detail: string;
  event: CaptureEvent;
};

export type TimelineStaleInterval = {
  topic: string;
  startMs: number;
  endMs: number;
};

export type TimelineSummary = {
  startMs: number | undefined;
  endMs: number | undefined;
  durationMs: number;
  eventCount: number;
  issueCount: number;
  bucketCount: number;
  maxBucketEvents: number;
  maxBucketLatencyMs: number;
  buckets: TimelineBucket[];
  markers: TimelineMarker[];
  staleIntervals: TimelineStaleInterval[];
};

export type StreamDiffStatus = "matched" | "missing" | "extra" | "divergent";

export type StreamDiffRow = {
  key: string;
  status: StreamDiffStatus;
  baseEvent: CaptureEvent | undefined;
  compareEvent: CaptureEvent | undefined;
  detail: string;
};

export type StreamDiffSummary = {
  baseStreamId: string;
  compareStreamId: string;
  baseLabel: string;
  compareLabel: string;
  matched: number;
  missing: number;
  extra: number;
  divergent: number;
  rows: StreamDiffRow[];
};

const latencyBucketBounds = [0, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

export function maxCaptureSeq(events: CaptureEvent[]): number {
  let max = 0;
  for (const event of events) {
    max = Math.max(max, event.captureSeq);
  }
  return max;
}

export function summarizeAgentTopics(topics: AgentTopicState[], now: number): TopicSummary[] {
  return [...topics]
    .map((topic) => {
      const lastSeenAt = Date.parse(topic.lastSeenAt);
      const freshnessMs = Number.isNaN(lastSeenAt)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, now - lastSeenAt);
      return {
        name: topic.name,
        count: topic.count,
        issueCount: topic.issueCount,
        keyCount: topic.key ? 1 : 0,
        lastSeq: topic.lastSeq,
        gapCount: topic.gapCount,
        duplicateCount: topic.duplicateCount,
        outOfOrderCount: topic.outOfOrderCount,
        ratePerSecond: topic.eventsPerSec,
        lastSeenAt: Number.isNaN(lastSeenAt) ? 0 : lastSeenAt,
        freshnessMs,
        stale: topic.stale,
        staleCount: topic.staleCount,
        staleThresholdMs: topic.staleThresholdMs ?? undefined,
        state: topic.stale ? "stale" : topicState(freshnessMs),
      };
    })
    .sort((a, b) => {
      if (Number(a.stale) !== Number(b.stale)) {
        return Number(b.stale) - Number(a.stale);
      }
      if (a.issueCount !== b.issueCount) {
        return b.issueCount - a.issueCount;
      }
      if (a.lastSeenAt !== b.lastSeenAt) {
        return b.lastSeenAt - a.lastSeenAt;
      }
      return b.count - a.count;
    })
    .slice(0, 8);
}

export function summarizeTopics(events: CaptureEvent[], now: number): TopicSummary[] {
  const windowMs = 10_000;
  const map = new Map<
    string,
    {
      name: string;
      count: number;
      issueCount: number;
      gapCount: number;
      duplicateCount: number;
      outOfOrderCount: number;
      recentCount: number;
      lastSeenAt: number;
      lastSeq: number | undefined;
      keys: Set<string>;
    }
  >();
  for (const event of events) {
    const name = eventScopeLabel(event);
    const receivedAt = Date.parse(event.receivedAt);
    const current = map.get(name) ?? {
      name,
      count: 0,
      issueCount: 0,
      gapCount: 0,
      duplicateCount: 0,
      outOfOrderCount: 0,
      recentCount: 0,
      lastSeenAt: 0,
      lastSeq: undefined,
      keys: new Set<string>(),
    };
    current.count += 1;
    current.issueCount += event.issues?.length ?? 0;
    current.gapCount += countEventIssueCode(event, "gap");
    current.duplicateCount += countEventIssueCode(event, "duplicate");
    current.outOfOrderCount += countEventIssueCode(event, "out_of_order");
    if (!Number.isNaN(receivedAt)) {
      current.lastSeenAt = Math.max(current.lastSeenAt, receivedAt);
      if (now - receivedAt <= windowMs) {
        current.recentCount += 1;
      }
    }
    if (event.seq !== undefined) {
      current.lastSeq = event.seq;
    }
    const key = event.effectiveKey ?? event.key;
    if (key) {
      current.keys.add(key);
    }
    map.set(name, current);
  }
  return [...map.values()]
    .map((topic) => {
      const freshnessMs =
        topic.lastSeenAt > 0 ? Math.max(0, now - topic.lastSeenAt) : Number.POSITIVE_INFINITY;
      return {
        name: topic.name,
        count: topic.count,
        issueCount: topic.issueCount,
        keyCount: topic.keys.size,
        lastSeq: topic.lastSeq,
        gapCount: topic.gapCount,
        duplicateCount: topic.duplicateCount,
        outOfOrderCount: topic.outOfOrderCount,
        ratePerSecond: topic.recentCount / (windowMs / 1_000),
        lastSeenAt: topic.lastSeenAt,
        freshnessMs,
        stale: false,
        staleCount: 0,
        staleThresholdMs: undefined,
        state: topicState(freshnessMs),
      };
    })
    .sort((a, b) => {
      if (a.issueCount !== b.issueCount) {
        return b.issueCount - a.issueCount;
      }
      if (a.lastSeenAt !== b.lastSeenAt) {
        return b.lastSeenAt - a.lastSeenAt;
      }
      return b.count - a.count;
    })
    .slice(0, 8);
}

export function eventScopeLabel(event: CaptureEvent): string {
  const topic = event.displayTopic ?? event.topic ?? "(raw)";
  const key = event.effectiveKey ?? event.key;
  return key ? `${topic} / ${key}` : topic;
}

export function recentIssueSummaries(events: CaptureEvent[]): IssueSummary[] {
  return events
    .flatMap((event) => (event.issues ?? []).map((issue) => ({ event, issue })))
    .slice(-8)
    .reverse();
}

export function summarizeLatency(events: CaptureEvent[]): LatencyAnalytics {
  const orderedEvents = [...events].sort((a, b) => a.captureSeq - b.captureSeq);
  const sourceLagSamples: LatencyHotspot[] = [];
  const receiveIntervalSamples: LatencyHotspot[] = [];

  let previousReceivedAt: number | undefined;
  for (const event of orderedEvents) {
    const receivedAt = parseTimestampMs(event.receivedAt);
    const sourceTs = parseTimestampMs(event.sourceTs);
    if (receivedAt !== undefined && sourceTs !== undefined) {
      sourceLagSamples.push({ event, valueMs: receivedAt - sourceTs });
    }
    if (receivedAt !== undefined && previousReceivedAt !== undefined) {
      receiveIntervalSamples.push({
        event,
        valueMs: Math.max(0, receivedAt - previousReceivedAt),
      });
    }
    if (receivedAt !== undefined) {
      previousReceivedAt = receivedAt;
    }
  }

  return {
    eventCount: orderedEvents.length,
    sourceLag: summarizeMetric(sourceLagSamples.map((sample) => sample.valueMs)),
    receiveInterval: summarizeMetric(receiveIntervalSamples.map((sample) => sample.valueMs)),
    sourceLagBuckets: buildLatencyHistogram(sourceLagSamples.map((sample) => sample.valueMs)),
    receiveIntervalBuckets: buildLatencyHistogram(
      receiveIntervalSamples.map((sample) => sample.valueMs),
    ),
    worstSourceLag: maxHotspot(sourceLagSamples),
    longestReceiveInterval: maxHotspot(receiveIntervalSamples),
  };
}

export function summarizeTimeline(
  events: CaptureEvent[],
  topics: TopicSummary[],
  now: number,
  bucketCount = 48,
): TimelineSummary {
  const orderedEvents = [...events].sort((a, b) => a.captureSeq - b.captureSeq);
  const timedEvents = orderedEvents
    .map((event) => ({ event, receivedAt: parseTimestampMs(event.receivedAt) }))
    .filter(
      (item): item is { event: CaptureEvent; receivedAt: number } => item.receivedAt !== undefined,
    );
  const issueCount = orderedEvents.reduce((count, event) => count + (event.issues?.length ?? 0), 0);

  if (timedEvents.length === 0) {
    return {
      startMs: undefined,
      endMs: undefined,
      durationMs: 0,
      eventCount: orderedEvents.length,
      issueCount,
      bucketCount,
      maxBucketEvents: 0,
      maxBucketLatencyMs: 0,
      buckets: emptyTimelineBuckets(bucketCount),
      markers: [],
      staleIntervals: [],
    };
  }

  const firstMs = timedEvents[0].receivedAt;
  const lastMs = timedEvents[timedEvents.length - 1].receivedAt;
  const startMs = Math.min(firstMs, ...activeStaleStartTimes(topics, now));
  const endMs = Math.max(lastMs, now);
  const durationMs = Math.max(1, endMs - startMs);
  const buckets = emptyTimelineBuckets(bucketCount).map((bucket) => ({
    ...bucket,
    startMs: startMs + (durationMs / bucketCount) * bucket.index,
    endMs: startMs + (durationMs / bucketCount) * (bucket.index + 1),
  }));
  const latencyTotals = new Array<number>(bucketCount).fill(0);
  const latencyCounts = new Array<number>(bucketCount).fill(0);
  const markers: TimelineMarker[] = [];
  const previousConnectionByStream = new Map<string, string>();

  for (const { event, receivedAt } of timedEvents) {
    const index = timelineBucketIndex(receivedAt, startMs, durationMs, bucketCount);
    const bucket = buckets[index];
    bucket.eventCount += 1;
    bucket.issueCount += event.issues?.length ?? 0;
    bucket.representativeEvent = event;

    const sourceTs = parseTimestampMs(event.sourceTs);
    if (sourceTs !== undefined) {
      const sourceLagMs = receivedAt - sourceTs;
      latencyTotals[index] += sourceLagMs;
      latencyCounts[index] += 1;
      bucket.maxSourceLagMs =
        bucket.maxSourceLagMs === undefined
          ? sourceLagMs
          : Math.max(bucket.maxSourceLagMs, sourceLagMs);
    }

    for (const issue of event.issues ?? []) {
      markers.push({
        kind: "issue",
        atMs: receivedAt,
        label: formatIssueCode(issue.code),
        detail: issue.message,
        event,
      });
    }

    const streamId = streamIdForEvent(event);
    const connectionId = event.connectionId;
    const previousConnection = previousConnectionByStream.get(streamId);
    if (connectionId && previousConnection && previousConnection !== connectionId) {
      bucket.reconnectCount += 1;
      markers.push({
        kind: "reconnect",
        atMs: receivedAt,
        label: "Reconnect",
        detail: `${streamId}: ${previousConnection} -> ${connectionId}`,
        event,
      });
    }
    if (connectionId) {
      previousConnectionByStream.set(streamId, connectionId);
    }
  }

  for (const [index, bucket] of buckets.entries()) {
    if (latencyCounts[index] > 0) {
      bucket.averageSourceLagMs = latencyTotals[index] / latencyCounts[index];
    }
  }

  return {
    startMs,
    endMs,
    durationMs,
    eventCount: orderedEvents.length,
    issueCount,
    bucketCount,
    maxBucketEvents: Math.max(1, ...buckets.map((bucket) => bucket.eventCount)),
    maxBucketLatencyMs: Math.max(0, ...buckets.map((bucket) => bucket.maxSourceLagMs ?? 0)),
    buckets,
    markers: markers.sort((a, b) => b.atMs - a.atMs).slice(0, 80),
    staleIntervals: topics
      .filter((topic) => topic.stale)
      .map((topic) => ({
        topic: topic.name,
        startMs: Math.max(
          startMs,
          topic.lastSeenAt + (topic.staleThresholdMs ?? Math.min(10_000, durationMs)),
        ),
        endMs,
      }))
      .filter((interval) => interval.endMs >= interval.startMs),
  };
}

export function summarizeStreamDiff(
  events: CaptureEvent[],
  baseStreamId: string,
  compareStreamId: string,
): StreamDiffSummary {
  return summarizeEventDiff(
    events.filter((event) => streamIdForEvent(event) === baseStreamId),
    events.filter((event) => streamIdForEvent(event) === compareStreamId),
    baseStreamId,
    compareStreamId,
  );
}

export function summarizeEventDiff(
  baseSourceEvents: CaptureEvent[],
  compareSourceEvents: CaptureEvent[],
  baseLabel: string,
  compareLabel: string,
): StreamDiffSummary {
  const baseEvents = [...baseSourceEvents].sort((a, b) => a.captureSeq - b.captureSeq);
  const compareEvents = [...compareSourceEvents].sort((a, b) => a.captureSeq - b.captureSeq);
  const compareByKey = groupEventsByDiffKey(compareEvents);
  const rows: StreamDiffRow[] = [];

  for (const baseEvent of baseEvents) {
    const key = diffEventKey(baseEvent);
    const compareEvent = shiftEventForKey(compareByKey, key);
    if (!compareEvent) {
      rows.push({
        key,
        status: "missing",
        baseEvent,
        compareEvent: undefined,
        detail: "Missing from compare source",
      });
      continue;
    }

    const baseFingerprint = diffPayloadFingerprint(baseEvent);
    const compareFingerprint = diffPayloadFingerprint(compareEvent);
    const divergent = baseFingerprint !== compareFingerprint;
    rows.push({
      key,
      status: divergent ? "divergent" : "matched",
      baseEvent,
      compareEvent,
      detail: divergent ? "Payload differs" : "Aligned",
    });
  }

  for (const [key, remaining] of compareByKey) {
    for (const compareEvent of remaining) {
      rows.push({
        key,
        status: "extra",
        baseEvent: undefined,
        compareEvent,
        detail: "Extra in compare source",
      });
    }
  }

  return {
    baseStreamId: baseLabel,
    compareStreamId: compareLabel,
    baseLabel,
    compareLabel,
    matched: rows.filter((row) => row.status === "matched").length,
    missing: rows.filter((row) => row.status === "missing").length,
    extra: rows.filter((row) => row.status === "extra").length,
    divergent: rows.filter((row) => row.status === "divergent").length,
    rows: rows
      .sort((a, b) => {
        const aSeq = a.baseEvent?.captureSeq ?? a.compareEvent?.captureSeq ?? 0;
        const bSeq = b.baseEvent?.captureSeq ?? b.compareEvent?.captureSeq ?? 0;
        return aSeq - bSeq;
      })
      .slice(0, 40),
  };
}

export function formatIssueBreakdown(topic: TopicSummary): string {
  const parts = [
    topic.staleCount > 0 ? `${formatCount(topic.staleCount)} stale` : "",
    topic.gapCount > 0 ? `${formatCount(topic.gapCount)} gap` : "",
    topic.duplicateCount > 0 ? `${formatCount(topic.duplicateCount)} dup` : "",
    topic.outOfOrderCount > 0 ? `${formatCount(topic.outOfOrderCount)} order` : "",
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" / ");
  }
  if (topic.issueCount > 0) {
    return `${formatCount(topic.issueCount)} issues`;
  }
  return "No issues";
}

export function formatIssueCode(code: string): string {
  if (code === "out_of_order") {
    return "order";
  }
  if (code === "parse_error") {
    return "parse";
  }
  if (code === "schema_error") {
    return "schema";
  }
  return code;
}

function topicState(freshnessMs: number): TopicHealthState {
  if (freshnessMs <= 2_000) {
    return "live";
  }
  if (freshnessMs <= 10_000) {
    return "warming";
  }
  return "quiet";
}

function countEventIssueCode(event: CaptureEvent, code: string): number {
  return event.issues?.filter((issue) => issue.code === code).length ?? 0;
}

function streamIdForEvent(event: CaptureEvent): string {
  return event.streamId ?? "default";
}

function groupEventsByDiffKey(events: CaptureEvent[]): Map<string, CaptureEvent[]> {
  const grouped = new Map<string, CaptureEvent[]>();
  for (const event of events) {
    const key = diffEventKey(event);
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }
  return grouped;
}

function shiftEventForKey(
  grouped: Map<string, CaptureEvent[]>,
  key: string,
): CaptureEvent | undefined {
  const bucket = grouped.get(key);
  if (!bucket || bucket.length === 0) {
    return undefined;
  }
  return bucket.shift();
}

function diffEventKey(event: CaptureEvent): string {
  const scope = eventScopeLabel(event);
  const type = event.displayType ?? event.eventType ?? event.opcode;
  if (event.seq !== undefined) {
    return `${scope} / ${type} / seq:${event.seq}`;
  }
  return `${scope} / ${type} / capture:${event.captureSeq}`;
}

function diffPayloadFingerprint(event: CaptureEvent): string {
  if (event.envelope?.payload !== undefined) {
    return stableStringify(event.envelope.payload);
  }
  return event.raw ?? event.rawBase64 ?? "";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const parsedDate = Date.parse(value);
  if (!Number.isNaN(parsedDate)) {
    return parsedDate;
  }

  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber)) {
    return parsedNumber < 10_000_000_000 ? parsedNumber * 1_000 : parsedNumber;
  }
  return undefined;
}

function summarizeMetric(values: number[]): LatencyMetricSummary {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      minMs: undefined,
      p50Ms: undefined,
      p95Ms: undefined,
      maxMs: undefined,
      averageMs: undefined,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    sampleCount: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
    averageMs: total / sorted.length,
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1),
  );
  return sortedValues[index];
}

function buildLatencyHistogram(values: number[]): LatencyHistogramBucket[] {
  const buckets = latencyBucketBounds.map((minMs, index) => ({
    label:
      index === latencyBucketBounds.length - 1
        ? `${formatDurationLabel(minMs)}+`
        : `${formatDurationLabel(minMs)}-${formatDurationLabel(latencyBucketBounds[index + 1])}`,
    minMs,
    maxMs: latencyBucketBounds[index + 1],
    count: 0,
  }));

  for (const value of values) {
    const bucket = buckets.find(
      (candidate) => candidate.maxMs === undefined || value < candidate.maxMs,
    );
    if (bucket) {
      bucket.count += 1;
    }
  }

  return buckets;
}

function maxHotspot(samples: LatencyHotspot[]): LatencyHotspot | undefined {
  return samples.reduce<LatencyHotspot | undefined>((max, sample) => {
    if (!max || sample.valueMs > max.valueMs) {
      return sample;
    }
    return max;
  }, undefined);
}

function emptyTimelineBuckets(bucketCount: number): TimelineBucket[] {
  return Array.from({ length: bucketCount }, (_, index) => ({
    index,
    startMs: 0,
    endMs: 0,
    eventCount: 0,
    issueCount: 0,
    reconnectCount: 0,
    averageSourceLagMs: undefined,
    maxSourceLagMs: undefined,
    representativeEvent: undefined,
  }));
}

function activeStaleStartTimes(topics: TopicSummary[], now: number): number[] {
  return topics
    .filter((topic) => topic.stale)
    .map((topic) => topic.lastSeenAt + (topic.staleThresholdMs ?? 0))
    .filter((value) => Number.isFinite(value) && value <= now);
}

function timelineBucketIndex(
  valueMs: number,
  startMs: number,
  durationMs: number,
  bucketCount: number,
): number {
  const ratio = (valueMs - startMs) / durationMs;
  return Math.min(bucketCount - 1, Math.max(0, Math.floor(ratio * bucketCount)));
}

function formatDurationLabel(value: number): string {
  if (value >= 1_000) {
    return `${value / 1_000}s`;
  }
  return `${value}ms`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
