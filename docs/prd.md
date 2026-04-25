# PRD: StreamLens

## Product Name

**StreamLens**

## One-Liner

StreamLens is a local real-time event-stream debugger for WebSocket-based applications. A Go agent captures and normalizes live streams, while a SolidJS inspector makes sequence gaps, stale topics, malformed payloads, reconnect behavior, and exportable captures visible.

## Core Thesis

Real-time applications fail in subtle ways: missed events, duplicate messages, sequence gaps, stale topics, reconnect bugs, malformed payloads, source lag, and UI state drifting away from stream state.

StreamLens makes those failures visible.

It should feel like:

```text
Chrome DevTools Network tab
+ Wireshark-lite
+ trading-terminal stream inspector
+ local capture/export tool
```

StreamLens focuses on application-level event streams, not raw packets.

## Product Goals

### Primary Goal

Build a polished local developer tool for inspecting real-time WebSocket streams with strong frontend UX and strong systems credibility.

The product should let a developer answer:

- What events are arriving?
- In what observed order did they arrive?
- Which topics or topic/key scopes are live, quiet, or stale?
- Did sequence numbers gap, duplicate, or arrive out of order?
- What payload caused the UI or downstream system to behave incorrectly?
- What happened before and after a reconnect, malformed message, pause, burst, or stale period?
- Can I export the captured stream for later analysis or replay tooling?

### Ecosystem Goal

StreamLens integrates naturally with the existing local event-stream tooling ecosystem:

```text
Tape     = deterministic market-event replay engine
Flamel   = real-time trading terminal
StreamLens  = real-time stream debugger
```

The primary demo path is:

```text
Tape -> StreamLens
```

The later ecosystem demo path is:

```text
Tape -> Flamel -> StreamLens
```

### Portfolio Goal

StreamLens should signal:

- real-time systems thinking
- Go infrastructure capability
- frontend product taste
- event-stream observability
- sequence and staleness reasoning
- professional developer-tool architecture
- local-first capture/export design
- familiarity with SolidJS fine-grained reactive UI architecture

## Product Positioning

### What StreamLens Is

StreamLens is a local developer tool for inspecting live real-time streams.

It has three layers:

```text
StreamLens Agent
  - Go local capture/proxy service

StreamLens Web UI
  - SolidJS inspector interface

StreamLens Desktop
  - Electrobun shell bundling UI + agent
```

### What StreamLens Is Not

StreamLens is not:

- a general-purpose logging SaaS
- an OpenTelemetry clone
- a packet sniffer
- a cloud observability platform
- a backend analytics warehouse
- a full protocol proxy for every transport
- a generic JSON viewer
- a trading terminal itself

It should stay focused:

> Make real-time event stream behavior visible, inspectable, and exportable.

## Architecture Overview

StreamLens is agent-first. The Go agent is the capture truth. The SolidJS UI is the presentation truth.

```text
Target WebSocket Stream
        ↓
StreamLens Agent — Go local capture/proxy service
        ↓
StreamLens Web UI — SolidJS inspector
        ↓
StreamLens Desktop — Electrobun wrapper
```

The agent owns upstream WebSocket connections, custom headers, auth, reconnect behavior, message receipt timestamps, capture sequence, normalization, stream issue detection, buffering, status APIs, and export.

The UI owns layout, filtering, selection, visualization, payload inspection, and interaction ergonomics. It connects to the local agent, not directly to arbitrary upstream streams.

The desktop shell packages the agent and UI into a polished local tool after the agent/UI loop is excellent.

## MVP Scope

MVP is:

```text
Go agent + SolidJS web UI
```

MVP does not include Electrobun desktop packaging. The web UI can run in a browser during development, but it talks to the local agent as the canonical backend.

MVP supports one upstream WebSocket stream at a time.

## MVP Completion Criteria

MVP is complete when:

1. The Go agent connects to one upstream WebSocket URL.
2. The agent supports custom headers, bearer/API-key style auth, and optional WebSocket subprotocols.
3. The agent captures raw messages with receipt timestamps and monotonic capture sequence numbers.
4. The agent parses and normalizes the default StreamLens envelope.
5. The agent captures malformed messages as raw events whenever possible.
6. The agent detects schema errors, parse errors, oversized messages, sequence gaps, duplicate events, out-of-order events, and stale topic/key scopes.
7. The agent keeps a bounded in-memory ring buffer of 10,000 events.
8. The agent exposes local APIs for connection control, health, stats, buffered events, issues, and JSONL export.
9. The SolidJS UI connects to the local agent and renders live capture state.
10. The event table displays live events using capture order and fixed-height virtualization.
11. The payload inspector shows parsed envelope, payload, raw message, issues, and metadata.
12. Topic health uses flat rows by effective scope and tracks rate, bytes, last sequence, last message age, state, and issue counts.
13. Sequence issues attach to the event that reveals them.
14. Stale detection updates on a 500ms agent tick even when no new events arrive.
15. Pause View freezes UI auto-follow only while agent capture continues.
16. JSONL export writes the retained capture format.
17. A local demo stream can generate normal, gap, duplicate, out-of-order, stale, malformed, oversized, and burst scenarios.
18. A synthetic 1,000 events/sec for 10 seconds scenario does not lock the UI.
19. StreamLens can inspect a Tape WebSocket stream that emits the default StreamLens envelope.

## MVP Exclusions

MVP does not include:

- Electrobun desktop shell
- persistent capture database
- import/replay of exported JSONL
- `.tape` export
- multiple simultaneous upstream streams
- SSE support
- WebTransport support
- Chrome DevTools extension
- schema plugin system
- OpenTelemetry correlation
- stream diffing
- latency histogram
- replay server
- protocol fuzzing
- fault-injection proxy
- native packet inspection

## Default Stream Contract

The canonical MVP stream contract is the StreamLens envelope:

```ts
type StreamLensEnvelope = {
  topic: string;
  type: string;
  seq?: number;
  ts?: number | string;
  key?: string;
  symbol?: string;
  payload?: unknown;
};
```

Tape should emit this envelope for the primary demo path.

Flamel-compatible streams are supported when they emit the same envelope. Flamel-specific adapters are deferred.

## Agent Responsibilities

The Go agent owns:

- upstream WebSocket connection lifecycle
- custom headers, bearer/API-key auth, and optional subprotocols
- manual connect/disconnect/reconnect
- configurable auto-reconnect
- raw message capture
- receive timestamp assignment
- local capture sequence assignment
- raw size measurement and oversized handling
- envelope parsing and normalization
- schema validation
- effective key calculation
- sequence issue detection
- stale evaluation
- topic health aggregation
- rolling rate counters
- bounded ring buffer
- issue log
- JSONL export
- health/status API
- local WebSocket feed to the UI

The agent should stay narrow. It is capture and normalization infrastructure, not a cloud observability backend.

## Agent API

Default local port:

```text
8790
```

Endpoints:

```text
GET  http://localhost:8790/health
GET  http://localhost:8790/stats
GET  http://localhost:8790/events
GET  http://localhost:8790/issues
GET  http://localhost:8790/topics
POST http://localhost:8790/connect
POST http://localhost:8790/disconnect
POST http://localhost:8790/reconnect
POST http://localhost:8790/clear
GET  http://localhost:8790/export/jsonl
WS   ws://localhost:8790/live
```

### Connect Request

```ts
type ConnectRequest = {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
  reconnect?: {
    enabled: boolean;
    initialDelayMs: number;
    maxDelayMs: number;
  };
};
```

### Agent-to-UI Live Messages

```ts
type AgentToUiMessage =
  | { type: "agent.ready"; payload: AgentStatus }
  | { type: "agent.error"; payload: AgentError }
  | { type: "upstream.connecting"; payload: ConnectionInfo }
  | { type: "upstream.connected"; payload: ConnectionInfo }
  | { type: "upstream.disconnected"; payload: ConnectionInfo }
  | { type: "upstream.reconnecting"; payload: ConnectionInfo }
  | { type: "event.captured"; payload: CapturedEvent }
  | { type: "issue.detected"; payload: StreamIssue }
  | { type: "topic.updated"; payload: TopicState }
  | { type: "capture.stats"; payload: CaptureStats };
```

## Event Model

StreamLens keeps both the raw message and the parsed event.

### Captured Event

```ts
type CapturedEvent = {
  id: string;
  connectionId: string;
  captureSeq: number;
  receivedAt: number;
  raw: string;
  rawTruncated: boolean;
  originalSizeBytes: number;
  sizeBytes: number;

  parsed: StreamLensEnvelope | null;
  parseError?: string;

  topic?: string;
  displayTopic: string;
  type?: string;
  displayType: string;
  key?: string;
  effectiveKey?: string;
  seq?: number;
  sourceTs?: number | string;

  statuses: EventStatus[];
  issues: StreamIssue[];
};
```

Row identity is:

```ts
id = `${connectionId}:${captureSeq}`;
```

Numeric `captureSeq` remains part of the event and export model.

### Event Status

```ts
type EventStatus =
  | "ok"
  | "gap"
  | "duplicate"
  | "out_of_order"
  | "stale_after"
  | "schema_error"
  | "parse_error"
  | "unparsed"
  | "oversized"
  | "buffered"
  | "replayed";
```

### Topic State

Topic health rows are flat rows by effective stream scope, not nested groups.

For `market.*` with `topicKey` scope, rows look like:

```text
market.AAPL / AAPL
market.MSFT / MSFT
market.NVDA / NVDA
```

```ts
type TopicState = {
  id: string;
  topic: string;
  key?: string;
  scope: "topic" | "topicKey";

  count: number;
  bytes: number;

  firstSeenAt: number;
  lastSeenAt: number;
  lastEventId?: string;
  lastSeq?: number;

  eventsPerSec: number;
  bytesPerSec: number;

  stale: boolean;
  staleSince?: number;
  staleThresholdMs?: number | null;

  gapCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  parseErrorCount: number;
  schemaErrorCount: number;
};
```

### Stream Issue

```ts
type StreamIssue = {
  id: string;
  eventId?: string;
  topic?: string;
  key?: string;

  type:
    | "gap"
    | "duplicate"
    | "out_of_order"
    | "stale"
    | "schema_error"
    | "parse_error"
    | "oversized"
    | "reconnect"
    | "disconnect";

  severity: "info" | "warning" | "error";
  message: string;
  createdAt: number;
  details?: unknown;
};
```

Sequence issues attach to the event that reveals them.

If sequence jumps from `1022` to `1025`, event `1025` owns the issue:

```ts
{
  type: "gap",
  eventId: event.id,
  expected: 1023,
  actual: 1025,
  missing: [1023, 1024]
}
```

Stale issues caused by time passing are topic-level issues without `eventId`. They may include `lastEventId` in `details`.

## Envelope Normalization Rules

### Missing Topic

Missing `topic`:

- captures the event
- displays topic as `unknown`
- marks `schema_error`
- blocks normal topic-scoped logic
- may update a special unknown/error bucket

### Missing Type

Missing `type`:

- captures the event
- displays type as `message`
- marks `schema_error`
- updates topic health if topic exists
- allows sequence detection if topic and sequence exist

### Missing Sequence

Missing `seq`:

- captures the event
- creates no sequence issue
- updates topic last seen, rate, bytes, and stale freshness if topic exists

### Effective Key

The effective key is:

```ts
effectiveKey = envelope.key ?? envelope.symbol ?? undefined;
```

If a rule wants `topicKey` but no key or symbol exists, fall back to topic-level tracking.

Missing key/symbol is not a schema error in MVP.

## Sequence Detection

MVP detects sequence issues per configured sequence scope.

Default sequence scope:

```text
topic + effectiveKey
```

If effective key is absent, fall back to:

```text
topic
```

Rules:

```ts
if seq === lastSeq:
  duplicate

if seq < lastSeq:
  out_of_order

if seq > lastSeq + 1:
  gap
```

Issue types:

```ts
type SequenceIssue =
  | { type: "gap"; expected: number; actual: number; missing: [number, number] }
  | { type: "duplicate"; seq: number }
  | { type: "out_of_order"; previous: number; actual: number };
```

UI must show:

- issue badge on event row
- issue count on topic health row
- issue in compact issue list/strip
- issue details in payload inspector

## Stale Detection

Each topic rule can define a freshness threshold and stale scope.

Default rules:

```ts
const defaultTopicRules = [
  {
    pattern: "market.*",
    seqScope: "topicKey",
    staleScope: "topicKey",
    staleMs: 1000,
  },
  {
    pattern: "orders",
    seqScope: "topic",
    staleScope: "none",
    staleMs: null,
  },
  {
    pattern: "portfolio",
    seqScope: "topic",
    staleScope: "topic",
    staleMs: 5000,
  },
  {
    pattern: "system",
    seqScope: "topic",
    staleScope: "topic",
    staleMs: 10000,
  },
  {
    pattern: "*",
    seqScope: "topicKey",
    staleScope: "none",
    staleMs: null,
  },
];
```

Rules:

- `staleMs = null` means the topic can be quiet without being stale.
- `staleScope = "none"` disables stale detection for that rule.
- stale is computed from receive time by default.
- if an event source timestamp exists, show source lag separately.
- stale transitions update on a 500ms agent tick even when no new events arrive.
- stale state must be visible in the topic panel, header metrics, issue list/strip, and payload metadata where relevant.

Important distinction:

```text
No events arriving          = receive staleness
Events arriving late        = source lag
Topic naturally quiet       = not stale if staleMs is null
```

## Rate Calculations

Use a 1-second rolling window for MVP.

Track:

- global events/sec
- global bytes/sec
- events/sec per topic scope
- bytes/sec per topic scope

## Buffering and Size Limits

MVP buffer:

```text
10,000 events in memory
```

Default message limits:

```ts
maxMessageBytes = 1_000_000;
maxBufferEvents = 10_000;
maxRawPreviewBytes = 100_000;
```

Malformed messages are captured as raw whenever possible.

Oversized messages:

- do not keep full huge raw payloads in memory
- keep a truncated raw preview
- preserve `rawTruncated = true`
- preserve `originalSizeBytes`
- mark the event as `oversized`
- export exactly what was retained

StreamLens should not silently drop a message unless it cannot be safely represented.

## JSONL Export

MVP exports a stable retained capture format, not the full internal mutable model.

JSONL event shape:

```ts
type StreamLensExportEvent = {
  captureSeq: number;
  connectionId: string;
  receivedAt: number;
  raw: string;
  rawTruncated: boolean;
  originalSizeBytes: number;
  parsed: StreamLensEnvelope | null;
  parseError?: string;
  sizeBytes: number;
};
```

MVP export excludes:

- derived statuses
- derived issues
- topic state
- UI-only fields

Issues can be recomputed later with newer rules.

## Demo Stream

MVP includes a local demo WebSocket stream that emits the same default StreamLens envelope as Tape.

Scenarios:

- normal stream
- sequence gap
- duplicate
- out-of-order
- stale topic
- malformed message
- oversized message
- 1,000 events/sec burst for 10 seconds

The demo stream is for local development and deterministic demonstrations. Tape remains the canonical realistic source.

## SolidJS Web UI

Use:

- SolidJS
- TypeScript
- TanStack Solid Router
- TailwindCSS
- shadcn-style components adapted for Solid
- lucide-solid icons
- fixed-height virtualized event table/list rendering
- local fine-grained stores/signals for UI projections

Do not use React.

### UI State Rules

The UI must not put every incoming event into deeply reactive component state.

The UI receives agent updates and publishes minimal fine-grained projections:

- connection state
- selected event ID
- selected topic/key/status/type filters
- visible event window
- topic health projection
- stream summary metrics
- paused/live-follow state
- buffered count since pause

Incoming events should not trigger full app rerenders.

## Connection UI

User can:

- enter target WebSocket URL
- enter optional custom headers
- enter optional bearer/API key value
- enter optional comma-separated WebSocket subprotocols
- connect
- disconnect
- manually reconnect
- enable/disable auto-reconnect
- see connection state
- see connected duration
- see reconnect count
- see last connected time
- see last disconnected time
- see last message time
- see total messages
- see total bytes

Connection states:

```text
idle
connecting
connected
disconnected
reconnecting
error
```

## Stream Health Summary

Top strip example:

```text
STREAMLENS · CONNECTED · ws://localhost:8787/stream · 12,430 events · 184 msg/s · 2 gaps · 1 stale · 0 parse errors
```

Metrics:

- connection state
- target URL
- total events
- total bytes
- event rate
- byte rate
- topic scope count
- stale topic count
- gap count
- duplicate count
- out-of-order count
- parse/schema error count
- buffer size
- pause/live-follow state

## Event Table

The event table is the main center surface.

Columns:

```text
TIME
ΔMS
TOPIC
TYPE
SEQ
KEY/SYMBOL
SIZE
STATUS
```

Example:

```text
12:01:02.120  +14ms  market.AAPL  trade_print   1021  AAPL  184B  OK
12:01:02.128  +08ms  market.AAPL  quote_update  1022  AAPL  221B  OK
12:01:03.044  +916ms market.AAPL  quote_update  1025  AAPL  220B  GAP +2
```

Required behavior:

- fixed-height virtualized rows
- stable row identity using `connectionId:captureSeq`
- capture order is the canonical order
- source timestamp is diagnostic metadata only
- newest/live-follow mode
- pause view mode
- click row to inspect payload
- filter by topic, type, status/issue, and key/symbol
- issue badges on rows

Full payload search is deferred.

## Topic Health Panel

Left rail tracks stream health scopes.

Columns:

```text
TOPIC
KEY
RATE
LAST SEQ
LAST MSG AGE
STATE
GAPS
ERRORS
```

Example:

```text
market.AAPL     AAPL    184/s    10241    82ms     LIVE     0
market.MSFT     MSFT     96/s     8812    1.4s     STALE    2
orders          -         0/s       42     12s     QUIET    0
portfolio       -         1/s      108    4.2s     STALE    0
```

Topic health should support:

- event count
- events/sec
- bytes/sec
- last sequence
- last event receive time
- stale state
- gap count
- duplicate count
- out-of-order count
- schema/parse errors
- click row to filter

## Payload Inspector

Right rail.

Click event to show:

- parsed envelope
- formatted JSON payload
- raw message
- receive timestamp
- source timestamp if present
- source lag
- payload size
- raw truncation metadata
- connection ID
- topic/key
- sequence state
- validation/parsing errors
- related issue details

Views:

```text
Parsed
Payload
Raw
Issues
Metadata
```

## Pause View

User can pause live-follow while agent capture continues.

States:

```text
live
paused_view
```

Pause means:

```text
freeze auto-follow / auto-scroll
```

Pause does not mean:

```text
stop agent capture, aggregation, filters, or stale evaluation
```

When paused:

- event table stops auto-following latest events
- incoming events still enter the agent buffer
- topic health continues updating
- stale detection continues ticking
- filters operate over the current captured buffer
- header shows event count captured since pause
- user can inspect historical events

When resumed:

- event table jumps back to latest
- buffered count resets

## Issue List / Strip

MVP surfaces issues through:

- header metrics
- event-row badges
- topic health counts
- payload inspector issue details
- compact issue list/strip

The issue list/strip shows:

- recent gaps
- duplicates
- out-of-order events
- stale transitions
- parse errors
- schema errors
- oversized messages
- reconnect/disconnect events

Full event density timeline, stale intervals, reconnect regions, and click-to-jump timeline behavior are deferred.

## UI Information Architecture

### Top Bar

Contains:

- app name
- connection state
- target URL
- total events
- msg/sec
- gap count
- stale topics
- parse errors
- pause/live-follow state
- export button

### Left Rail

Topic health.

Main interactions:

- click topic scope to filter
- show live/stale/quiet state
- show rates and issues

### Center

Event table.

Main interactions:

- filter
- select event
- pause/resume live-follow
- jump to latest
- jump to issue from issue list/strip

### Right Rail

Payload inspector.

Tabs:

- Parsed
- Payload
- Raw
- Issues
- Metadata

### Bottom

Compact issue list/strip.

Shows:

- recent issue events
- topic-level stale transitions
- reconnect/disconnect events
- click-to-select issue/event where applicable

## UI Design Direction

StreamLens should feel like a serious developer tool.

Good references:

- Chrome DevTools Network tab
- observability tools
- packet/event analyzers
- trading terminal debug panels
- dense operator workspaces

Visual principles:

- dense but calm
- low ceremony
- clear states
- minimal decorative chrome
- strong table ergonomics
- fast keyboard/mouse workflows
- terse labels
- inspectability over decoration

Avoid:

- generic dashboard look
- big cards everywhere
- marketing copy in the UI
- colorful but shallow charts
- overexplaining the product on every panel

## Non-Functional Requirements

### Performance

StreamLens MVP must handle:

```text
1,000 events/sec for 10 seconds
10,000 event in-memory buffer
virtualized table rendering
500ms stale evaluation tick
1-second rolling rate windows
```

Acceptance:

- no browser tab freeze
- event buffer caps correctly
- summary metrics update
- topic aggregation remains current
- event table remains usable
- payload inspector remains usable after burst
- pause/resume still works

Stretch target:

```text
5,000 events/sec burst for 5 seconds
```

### Reliability

StreamLens should not lose capture continuity just because the user pauses the view or reloads the UI. The agent remains the capture owner.

### Inspectability

Every issue should be explainable:

- where it happened
- which topic/key scope it belongs to
- which event triggered it, if any
- what expected sequence was
- what actual sequence was
- what range was missing
- whether the issue is parse, schema, sequence, stale, reconnect, disconnect, or size-related

### Local-First

MVP works locally without cloud services.

### Security

Do not send captured stream data to any external service.

Secrets supplied for upstream connection should stay local to the agent and should not be persisted unless the user explicitly chooses a saved profile in a later version.

## User Stories

1. As a developer, I want to connect StreamLens to a local WebSocket stream, so that I can inspect live application events.
2. As a developer, I want to provide custom headers or bearer/API-key auth, so that I can inspect streams that require authenticated connections.
3. As a developer, I want the agent to keep capturing while I reload the UI, so that I do not lose stream continuity.
4. As a developer, I want events ordered by capture sequence, so that I can understand observed stream order.
5. As a developer, I want malformed messages captured as raw events, so that bad payloads are visible instead of disappearing.
6. As a developer, I want oversized messages represented with truncation metadata, so that huge payloads do not crash the tool.
7. As a developer, I want topic/key health rows, so that I can see which stream scopes are live, quiet, or stale.
8. As a developer, I want sequence gaps flagged on the event that reveals them, so that I can debug missing events quickly.
9. As a developer, I want duplicate and out-of-order events flagged, so that I can detect replay or ordering bugs.
10. As a developer, I want stale topics to update without new messages arriving, so that silence becomes visible.
11. As a developer, I want to click an event and inspect parsed, raw, issue, and metadata views, so that I can understand the exact payload and context.
12. As a developer, I want to pause live-follow while capture continues, so that I can inspect historical events without losing new data.
13. As a developer, I want filters for topic, type, status, and key, so that I can narrow a noisy stream.
14. As a developer, I want a compact issue list, so that I can jump to recent stream problems.
15. As a developer, I want JSONL export of the retained capture, so that I can share or analyze captured events later.
16. As a developer, I want a deterministic demo stream, so that I can reproduce gaps, stale periods, malformed messages, and bursts without depending on another service.
17. As a developer, I want StreamLens to handle 1,000 events/sec bursts, so that the debugger does not fail under the stream behavior it is built to inspect.
18. As a developer, I want StreamLens to inspect Tape streams, so that I can demonstrate deterministic real-time behavior and debugging.

## Milestone Plan

### Milestone 1: Agent Protocol + Web UI Shell

Build:

- Go agent package
- local health endpoint
- local live WebSocket endpoint
- typed Agent-to-UI protocol
- SolidJS app shell
- top bar
- connection panel
- left topic panel placeholder
- center event table placeholder
- right payload inspector placeholder
- bottom issue strip placeholder

Acceptance:

- UI connects to local agent
- agent publishes readiness/status messages
- UI renders connection state from agent protocol

### Milestone 2: Agent Upstream Capture

Build:

- upstream WebSocket client
- connect/disconnect/reconnect commands
- custom headers
- bearer/API-key auth support
- optional subprotocols
- receive timestamps
- capture sequence
- ring buffer

Acceptance:

- agent connects to Tape stream
- agent captures raw messages
- UI receives live captured events
- agent survives UI reload

### Milestone 3: Agent Normalization + Export

Build:

- default envelope parser
- schema validation
- effective key logic
- malformed JSON handling
- oversized raw truncation
- JSONL export endpoint
- Go tests for parser/export behavior

Acceptance:

- valid envelopes parse
- malformed JSON is captured
- schema errors are represented
- oversized messages are retained safely
- JSONL export writes retained capture format

### Milestone 4: Event Table + Payload Inspector

Build:

- fixed-height virtualized event table
- capture-order row rendering
- row selection
- parsed/payload/raw/issues/metadata inspector tabs
- event status badges

Acceptance:

- events remain usable under live updates
- selected event details are inspectable
- source timestamp is shown as metadata only

### Milestone 5: Topic Health + Sequence Detection

Build:

- topic/key scope aggregation
- 1-second rolling rates
- last sequence tracking
- gap detection
- duplicate detection
- out-of-order detection
- issue attachment to revealing event
- topic health panel

Acceptance:

- skipped sequence creates gap issue
- duplicate sequence creates duplicate issue
- out-of-order sequence creates issue
- topic panel reflects counts
- issue details are inspectable

### Milestone 6: Stale Detection + Pause View

Build:

- default topic rules
- 500ms agent stale evaluation tick
- stale issue transitions
- pause live-follow
- buffered count since pause
- resume live-follow

Acceptance:

- market topic/key scope becomes stale after threshold
- stale state updates without new events
- paused view stops auto-following but agent capture continues
- resume jumps to latest

### Milestone 7: Filters + Issue Strip + Demo Stream

Build:

- topic/type/status/key filters
- compact issue list/strip
- jump-to-event from issue
- local demo WebSocket stream
- normal/gap/duplicate/out-of-order/stale/malformed/oversized scenarios

Acceptance:

- filters work without breaking live capture
- issue strip exposes recent problems
- demo stream reproduces deterministic issue scenarios

### Milestone 8: Load Scenario

Build:

- 1,000 events/sec for 10 seconds demo scenario
- performance instrumentation
- UI responsiveness checks

Acceptance:

- no browser tab freeze
- agent buffer caps correctly
- summary metrics update
- virtualized table remains usable
- payload inspector remains usable after burst
- pause/resume still works

### Milestone 9: Timeline

Build:

- event density visualization
- issue markers
- stale interval markers
- reconnect/disconnect markers
- click-to-jump

Acceptance:

- gaps and stale periods are visible over time
- selecting timeline region filters or jumps event table

### Milestone 10: Electrobun Desktop Shell

Build:

- desktop wrapper around SolidJS UI
- launches local agent
- save/open capture files
- recent target URLs

Acceptance:

- user can run StreamLens as desktop app
- desktop app connects to local streams
- capture export uses native file save

## Demo Scenario

Best MVP demo:

1. Start Tape:

```bash
tape stream demo.tape --port 8787 --speed 10x --chaos gaps
```

2. Start StreamLens agent.
3. Open StreamLens UI.
4. Connect to:

```text
ws://localhost:8787/stream
```

5. Show live event table.
6. Show topic health.
7. Show gap detection when Tape skips sequences.
8. Show stale detection when a market topic pauses.
9. Inspect a malformed or gapped payload.
10. Pause live-follow while agent capture continues.
11. Export capture as JSONL.

Demo stream can reproduce the same story without Tape installed, but Tape remains the canonical realistic source.

## README Positioning

Use this in the README:

```md
# StreamLens

StreamLens is a local real-time event-stream debugger for WebSocket-based applications.

A Go agent connects to live streams, captures events into a bounded local buffer, tracks topic health, detects sequence gaps, duplicate and out-of-order events, visualizes stale periods, and exposes a SolidJS inspector for debugging real-time systems.

StreamLens was built for trading-terminal style applications where stream correctness, freshness, reconnect behavior, and event ordering matter.
```

## CV / Interview Positioning

General version:

> Built StreamLens, a Go + SolidJS real-time WebSocket stream debugger that captures event streams, tracks topic health, detects sequence gaps and stale periods, inspects payloads, and exports stable JSONL captures for deterministic debugging.

Alchemy-specific version:

> Built StreamLens, a local developer tool for debugging real-time trading terminal streams, with a Go capture agent, SolidJS inspector, topic health, stale-state visualization, sequence-gap detection, payload inspection, reconnect tracking, and capture export.

Strong interview explanation:

> After building Flamel, I wanted tooling that made real-time stream behavior visible. StreamLens is the tool I wished I had while debugging stale state, reconnects, sequence gaps and malformed events. A local Go agent captures and normalizes the stream, while a SolidJS UI groups events by topic/key scope, detects ordering issues, visualizes stale periods and lets me inspect or export captured payloads.

## Product Success Criteria

StreamLens is successful if a strong engineer thinks:

> This person understands that real-time apps need tooling, not just WebSockets.

Specific success signs:

- the agent capture model is trustworthy
- the event table is dense and useful
- topic health makes stream behavior instantly legible
- sequence gaps are obvious
- stale periods are visible
- payload inspection is fast
- capture/export works
- the tool integrates with Tape
- the architecture is layered and defensible
- the UI feels like a real developer tool, not a toy dashboard
- SolidJS is used deliberately for fine-grained, high-frequency UI updates

## Final Build Strategy

Build in this order:

```text
1. Agent protocol + SolidJS shell
2. Agent upstream WebSocket capture
3. Agent normalization + export
4. Event table + payload inspector
5. Topic health + sequence detection
6. Stale detection + pause view
7. Filters + issue strip + demo stream
8. Load scenario
9. Timeline
10. Electrobun desktop shell
```

The most important rule:

> The Go agent is the capture truth. The SolidJS UI is the presentation truth. The Electrobun shell is polish.

Do not let desktop packaging delay the core agent/UI inspection experience.
