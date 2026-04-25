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

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
