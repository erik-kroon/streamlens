Replace every React-specific part with **SolidJS**, and keep the rest of the architecture the same.

Here is the updated PRD language you can paste into your agent:

---

# PRD: Wiretap

## Product name

**Wiretap**

## One-liner

Wiretap is a real-time event-stream debugger for WebSocket-based applications, built to inspect live streams, track topic health, detect sequence gaps and stale periods, inspect payloads, capture/replay events, and make real-time system behavior legible.

## Core thesis

Real-time applications fail in subtle ways: missed events, duplicate messages, sequence gaps, stale topics, reconnect bugs, malformed payloads, and UI state drifting away from stream state.

Wiretap makes those failures visible.

It should feel like:

```text
Chrome DevTools Network tab
+ Wireshark-lite
+ trading-terminal stream inspector
+ local capture/replay tool
```

But focused on **application-level event streams**, not raw packets.

---

# 1. Product goals

## Primary goal

Build a polished developer tool for inspecting real-time WebSocket streams with strong frontend UX and strong systems credibility.

The product should let a developer answer:

- What events are arriving?
- In what order?
- Which topics are active or stale?
- Did sequence numbers gap, duplicate, or arrive out of order?
- What payload caused the UI to behave incorrectly?
- What happened before/after a reconnect?
- Can I capture this stream and replay it later?

## Secondary goal

Integrate naturally with the existing ecosystem:

```text
Tape     = deterministic market-event replay engine
Flamel   = real-time trading terminal
Wiretap  = real-time stream debugger
```

Ideal demo:

```text
Tape streams deterministic market events
→ Flamel renders them as a terminal
→ Wiretap inspects the stream behavior
```

## Tertiary goal

Create a high-signal portfolio/interview project for a real-time fintech/frontend role.

The project should signal:

- real-time systems thinking
- frontend product taste
- event-stream observability
- sequence/staleness reasoning
- Go infrastructure capability
- professional developer-tool architecture
- familiarity with **SolidJS-style fine-grained reactive UI architecture**

---

# 2. Product positioning

## What Wiretap is

Wiretap is a **local developer tool** for inspecting live real-time streams.

It has three layers:

```text
Wiretap Web UI
  - SolidJS inspector interface

Wiretap Agent
  - Go local capture/proxy service

Wiretap Desktop
  - Electrobun shell bundling UI + agent
```

## What Wiretap is not

Wiretap is not:

- a general-purpose logging SaaS
- an OpenTelemetry clone
- a packet sniffer
- a cloud observability platform
- a backend analytics warehouse
- a full protocol proxy for every transport
- a generic JSON viewer
- a trading terminal itself

It should stay focused:

> Make real-time event stream behavior visible, inspectable, and replayable.

---

# 3. Architecture overview

Wiretap is built in three progressively shippable layers.

```text
Target WebSocket Stream
        ↓
Wiretap Agent — Go local capture/proxy service
        ↓
Wiretap Web UI — SolidJS inspector
        ↓
Wiretap Desktop — Electrobun wrapper
```

## Layer 1: Wiretap Web UI

The browser-based inspector.

Responsibilities:

- connection UI
- event table
- topic health panel
- payload inspector
- sequence gap visualization
- stale topic visualization
- timeline
- filters
- pause/resume view
- export UI

The Web UI should be able to run standalone and connect directly to a WebSocket stream before the Go agent exists.

### Frontend stack

Use:

- **SolidJS**
- **TypeScript**
- **Solid Router** or TanStack Router if already configured and compatible
- **TailwindCSS**
- **shadcn-style components adapted for Solid**
- Virtualized table/list rendering for large event streams
- Local fine-grained stores/signals for event buffer, topic state, selected event, filters, and connection state

Do **not** use React.

## Layer 2: Wiretap Agent

A local Go service.

Responsibilities:

- connect to upstream WebSocket streams
- capture raw messages
- timestamp messages at receipt
- assign local capture sequence
- parse/normalize events
- track ring buffer
- optionally persist captures
- forward normalized events to UI
- export JSONL / `.tape`
- provide health/status API

The agent should stay narrow. It is infrastructure for capture and normalization, not a full observability backend.

## Layer 3: Wiretap Desktop

Electrobun desktop wrapper.

Responsibilities:

- package the SolidJS UI as a desktop app
- start/stop local Go agent
- provide local file open/save
- remember recent target URLs
- provide polished local developer-tool experience

Desktop is a distribution/polish layer, not a separate product.

---

# 4. State management architecture

## Critical rule

Do **not** put every incoming event directly into component-level reactive state in a way that causes broad UI invalidation.

The ingestion path must be buffered and throttled.

Recommended pipeline:

```text
WebSocket receive
→ parse raw message
→ append to non-reactive/ring buffer storage
→ update topic aggregates
→ detect issues
→ publish minimal fine-grained reactive updates
→ render virtualized event table
```

## Solid-specific state rules

Because SolidJS uses fine-grained reactivity, use it deliberately:

### Use signals/stores for UI projections

Good candidates:

- connection state
- selected event ID
- selected topic filter
- visible event window
- topic health map projection
- stream summary metrics
- paused/live state
- timeline viewport

### Avoid storing the entire high-frequency event stream in a deeply reactive store

Do **not** make every event a deeply reactive object if the stream may produce hundreds or thousands of events per second.

Prefer:

```text
Mutable ring buffer / plain array
+ reactive version counter
+ memoized visible window
+ virtualized rendering
```

### Suggested pattern

```text
eventBufferRef / plain ring buffer
topicStateMap / mutable aggregate map
signal: bufferVersion
signal: selectedEventId
signal: filters
memo: visibleEvents
```

This keeps high-frequency ingestion cheap while still allowing the UI to update predictably.

## UI rendering rules

- Event table must be virtualized.
- Topic health may update on animation frame or interval.
- Payload inspector reads selected event by ID.
- Incoming events should not trigger full app rerenders.
- Live auto-scroll should be optional and disabled when view is paused.

This is important because Wiretap itself must not fail under the stream behavior it is built to inspect.

---

# 5. MVP scope

## P0 features

### 1. WebSocket connection panel

User can:

- enter target URL
- connect
- disconnect
- see connection state
- see connected duration
- see reconnect count
- see last message time
- see total messages
- see total bytes

Connection states:

```text
idle
connecting
connected
disconnected
error
```

---

### 2. Event table

Main center surface.

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

- virtualized rows
- newest/live auto-scroll mode
- pause view mode
- click row to inspect payload
- filter by topic/type/status/key
- stable row identity

---

### 3. Topic health panel

Left rail.

Tracks topic/key health.

Columns:

```text
TOPIC
RATE
LAST SEQ
LAST MSG AGE
STATE
GAPS
ERRORS
```

Example:

```text
market.AAPL     184/s    10241    82ms     LIVE     0
market.MSFT      96/s     8812    1.4s     STALE    2
orders             0/s       42     12s     QUIET    0
portfolio          1/s      108    4.2s     STALE    0
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

---

### 4. Sequence gap detection

Wiretap detects sequence issues per configured sequence scope.

Default MVP scope:

```text
topic + key
```

If `key` is absent, fall back to:

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
- issue count on topic
- issue marker on timeline
- issue details in payload inspector

---

### 5. Stale topic detection

Each topic can have a freshness threshold.

Default config:

```json
{
  "market.*": { "staleMs": 1000, "seqMode": "topicKey" },
  "orders": { "staleMs": null, "seqMode": "topic" },
  "portfolio": { "staleMs": 5000, "seqMode": "topic" },
  "system": { "staleMs": 10000, "seqMode": "topic" }
}
```

Rules:

- `staleMs = null` means the topic can be quiet without being stale.
- stale is computed from receive time by default.
- if event source timestamp exists, show source lag separately.
- stale state must be visible in topic panel and timeline.

Important distinction:

```text
No events arriving          = receive staleness
Events arriving late        = source lag
Topic naturally quiet       = not stale if staleMs is null
```

---

### 6. Payload inspector

Right rail.

Click event → show:

- parsed envelope
- formatted JSON payload
- raw message
- receive timestamp
- source timestamp if present
- source lag
- payload size
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

---

### 7. Pause live view while buffering continues

User can pause the visible event table while capture continues.

States:

```text
live
paused_view
```

When paused:

- event table stops auto-scrolling
- incoming events still enter the buffer
- header shows buffered count since pause
- topic health still updates
- user can inspect historical events

When resumed:

- event table jumps back to latest
- buffered count resets

---

### 8. Replay/capture buffer

MVP buffer:

```text
10,000 events in memory
```

Capabilities:

- keep recent events
- inspect previous events
- export buffer as JSONL
- export selected range
- clear buffer

Future:

- persistent capture DB
- `.tape` export
- capture replay

---

### 9. Stream health summary

Top strip.

Example:

```text
WIRETAP · CONNECTED · 4 topics · 12,430 events · 184 msg/s · 2 gaps · 1 stale topic · 0 parse errors
```

Metrics:

- connection state
- total events
- total bytes
- event rate
- byte rate
- topic count
- stale topic count
- gap count
- duplicate count
- out-of-order count
- parse/schema error count
- buffer size

---

# 6. Event model

Wiretap must keep both the raw message and the parsed event.

## Default event envelope

Wiretap should support this default envelope:

```ts
type WiretapEventEnvelope = {
  topic?: string;
  type?: string;
  seq?: number;
  ts?: number | string;
  key?: string;
  symbol?: string;
  payload?: unknown;
};
```

Events that do not match the expected envelope should still be captured and shown as `UNPARSED` or `SCHEMA_ERROR`.

## Captured event

```ts
type CapturedEvent = {
  id: string;
  connectionId: string;
  captureSeq: number;
  receivedAt: number;
  raw: string;
  sizeBytes: number;

  parsed: WiretapEventEnvelope | null;
  parseError?: string;

  topic?: string;
  type?: string;
  key?: string;
  seq?: number;
  sourceTs?: number | string;

  statuses: EventStatus[];
  issues: StreamIssue[];
};
```

## Event status

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
  | "buffered"
  | "replayed";
```

## Topic state

```ts
type TopicState = {
  id: string;
  topic: string;
  key?: string;

  count: number;
  bytes: number;

  firstSeenAt: number;
  lastSeenAt: number;
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

## Stream issue

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
    | "reconnect"
    | "disconnect";

  severity: "info" | "warning" | "error";

  message: string;
  createdAt: number;

  details?: unknown;
};
```

---

# 7. Agent protocol

## Agent-to-UI WebSocket

Endpoint:

```text
ws://localhost:8790/events
```

Messages:

```ts
type AgentToUiMessage =
  | { type: "agent.ready"; payload: AgentStatus }
  | { type: "agent.error"; payload: AgentError }
  | { type: "upstream.connecting"; payload: ConnectionInfo }
  | { type: "upstream.connected"; payload: ConnectionInfo }
  | { type: "upstream.disconnected"; payload: ConnectionInfo }
  | { type: "event.captured"; payload: CapturedEvent }
  | { type: "issue.detected"; payload: StreamIssue }
  | { type: "capture.stats"; payload: CaptureStats };
```

## UI-to-Agent commands

```ts
type UiToAgentMessage =
  | {
      type: "connect";
      payload: { url: string; headers?: Record<string, string> };
    }
  | { type: "disconnect" }
  | { type: "clear_buffer" }
  | {
      type: "export_capture";
      payload: { format: "jsonl" | "tape"; range?: TimeRange };
    };
```

---

# 8. UI information architecture

## Top bar

Contains:

- app name
- connection state
- target URL
- total events
- msg/sec
- gap count
- stale topics
- parse errors
- pause/live state
- export button

Example:

```text
WIRETAP · CONNECTED · ws://localhost:8787/stream · 12,430 events · 184 msg/s · 2 gaps · 1 stale · 0 parse errors
```

## Left rail

Topic health.

Main interactions:

- click topic to filter
- show live/stale/quiet state
- show rates and issues

## Center

Event table.

Main interactions:

- filter
- sort
- select event
- pause/resume live
- jump to latest
- jump to issue

## Right rail

Payload inspector.

Tabs:

- Parsed
- Payload
- Raw
- Issues
- Metadata

## Bottom

Timeline / issue strip.

Shows:

- event density
- issue markers
- stale intervals
- selected event location

---

# 9. P1 features

## 1. Go local agent

Add `wiretap-agent`.

Example command:

```bash
wiretap-agent --target ws://localhost:8787/stream --port 8790
```

Agent exposes:

```text
ws://localhost:8790/events
GET  http://localhost:8790/health
POST http://localhost:8790/connect
POST http://localhost:8790/disconnect
GET  http://localhost:8790/stats
GET  http://localhost:8790/captures
POST http://localhost:8790/captures/export
```

Agent responsibilities:

- connect to upstream target stream
- receive raw messages
- timestamp `receivedAt`
- assign `captureSeq`
- forward to UI
- keep ring buffer
- export JSONL
- expose stats

---

## 2. Timeline view

Bottom strip.

Visualize:

- event density
- gaps
- duplicates
- out-of-order events
- stale intervals
- reconnects
- selected event

The timeline does not need to be complex. A simple canvas/SVG strip is enough.

---

## 3. Capture export to `.tape`

Export captured stream to Tape-compatible format.

This connects the ecosystem:

```text
live stream
→ Wiretap capture
→ .tape file
→ Tape replay
→ Flamel / Geber / Wiretap
```

MVP may export JSONL first, then `.tape`.

---

## 4. Configurable topic rules

Allow user to configure:

- topic pattern
- stale threshold
- sequence mode
- key extraction path
- topic extraction path
- timestamp extraction path

Example:

```json
{
  "topicRules": [
    {
      "pattern": "market.*",
      "staleMs": 1000,
      "seqMode": "topicKey",
      "keyPath": "$.symbol",
      "seqPath": "$.seq",
      "sourceTsPath": "$.ts"
    }
  ]
}
```

---

## 5. Reconnect/resync inspection

Highlight lifecycle events:

```text
CONNECTED
DISCONNECTED
RECONNECTING
RECONNECTED
RESYNC_REQUESTED
SNAPSHOT_APPLIED
RESYNC_COMPLETE
```

If upstream emits system events, Wiretap should detect and classify them.

---

# 10. P2 features

Explicitly not MVP:

- SSE support
- WebTransport support
- multiple simultaneous upstream streams
- Chrome DevTools extension
- persistent local capture database
- schema plugin system
- OpenTelemetry correlation
- stream diffing
- latency histogram
- replay server
- protocol fuzzing
- fault-injection proxy
- native packet inspection

---

# 11. UI/design direction

Wiretap should feel like a serious developer tool.

## Good references

- Chrome DevTools Network tab
- observability tools
- packet/event analyzers
- trading terminal debug panels
- dense operator workspaces

## Visual principles

- dense but calm
- low ceremony
- clear states
- minimal decorative chrome
- strong table ergonomics
- fast keyboard/mouse workflows
- terse labels
- inspectability over decoration

## Avoid

- generic dashboard look
- big cards everywhere
- marketing copy in the UI
- colorful but shallow charts
- overexplaining the product on every panel

---

# 12. Non-functional requirements

## Performance

Wiretap must handle at least:

```text
1,000 events/sec for short bursts
10,000 event in-memory buffer
virtualized table rendering
throttled topic aggregation updates
```

Stretch target:

```text
5,000 events/sec burst ingestion without UI lockup
```

## Reliability

Wiretap should not lose capture continuity just because the user pauses the view.

## Inspectability

Every issue should be explainable:

- where it happened
- which topic/key
- which event triggered it
- what expected sequence was
- what actual sequence was

## Local-first

MVP should work locally without cloud services.

## Security

Do not send captured stream data to any external service.

---

# 13. Acceptance criteria

## P0 acceptance

Wiretap is MVP-complete when:

1. User can connect directly to a WebSocket stream.
2. Incoming events appear in a virtualized event table.
3. Wiretap parses default event envelopes.
4. Topic health panel tracks rates, last event age, gaps, duplicates, out-of-order events.
5. Sequence gap detection works for topic/key streams.
6. Stale detection works using configurable thresholds.
7. Payload inspector shows parsed, raw, metadata, and issue details.
8. User can pause live view while capture continues.
9. User can export buffered events as JSONL.
10. Wiretap can inspect a Tape or Flamel WebSocket stream.

## P1 acceptance

Wiretap is v1-complete when:

1. Go agent can connect to upstream WebSocket streams.
2. SolidJS Web UI can connect to local agent.
3. Agent forwards captured events to UI.
4. Agent exposes health/stats API.
5. Agent exports captures.
6. Timeline shows density/issues/stale periods.
7. Basic `.tape` export exists.
8. Electrobun shell can launch the UI.

---

# 14. Milestone plan

## Milestone 1: SolidJS Web UI skeleton

Build:

- app shell
- top bar
- left topic panel
- center event table placeholder
- right payload inspector
- bottom timeline placeholder

Acceptance:

- UI layout exists
- fake events can populate all panels
- Solid fine-grained state model is established

---

## Milestone 2: Direct WebSocket capture

Build:

- URL input
- connect/disconnect
- receive raw messages
- parse default envelope
- append to ring buffer
- show events in table

Acceptance:

- connects to Tape/Flamel stream
- events appear live
- selected event appears in inspector

---

## Milestone 3: Topic health + sequence detection

Build:

- topic/key grouping
- event rates
- last seq
- gap/duplicate/out-of-order detection
- status badges

Acceptance:

- skipped sequence creates gap issue
- duplicate sequence creates duplicate issue
- out-of-order sequence creates issue
- topic panel reflects counts

---

## Milestone 4: Stale detection + pause mode

Build:

- topic stale rules
- stale indicators
- pause live view
- buffered count
- resume live

Acceptance:

- market topic becomes stale after threshold
- paused view stops scrolling but capture continues
- resume jumps to latest

---

## Milestone 5: Export + filters

Build:

- topic/type/status filters
- payload search
- export JSONL
- clear buffer

Acceptance:

- exported JSONL contains captured raw/parsed events
- filters work without breaking live capture

---

## Milestone 6: Go agent

Build:

- local Go service
- upstream WebSocket client
- local WebSocket to UI
- health endpoint
- stats endpoint
- ring buffer

Acceptance:

- UI connects to agent instead of upstream
- agent captures and forwards events
- agent survives UI reload

---

## Milestone 7: Timeline

Build:

- event density visualization
- issue markers
- stale interval markers
- click-to-jump

Acceptance:

- gaps and stale periods are visible over time
- selecting timeline region filters/jumps event table

---

## Milestone 8: Electrobun desktop shell

Build:

- desktop wrapper around SolidJS UI
- launches local agent
- save/open capture files
- recent target URLs

Acceptance:

- user can run Wiretap as desktop app
- desktop app connects to local streams
- capture export uses native file save

---

# 15. Demo scenario

Best demo:

1. Start Tape:

```bash
tape stream demo.tape --port 8787 --speed 10x --chaos gaps
```

2. Open Wiretap.
3. Connect to:

```text
ws://localhost:8787/stream
```

4. Show live event table.
5. Show topic health.
6. Show gap detection when chaos mode skips sequences.
7. Show stale detection when quote stream pauses.
8. Inspect a malformed or gapped payload.
9. Pause live view while capture continues.
10. Export capture as JSONL or `.tape`.
11. Optionally open Flamel consuming same stream.

This creates the narrative:

> Tape produces deterministic stream behavior, Flamel renders it, and Wiretap explains it.

---

# 16. README positioning

Use this in the README:

```md
# Wiretap

Wiretap is a real-time event-stream debugger for WebSocket-based applications.

It connects to live streams, captures events into a local replay buffer, tracks topic health, detects sequence gaps, duplicate and out-of-order events, visualizes stale periods, and provides a payload inspector for debugging real-time systems.

Wiretap was built for trading-terminal style applications where stream correctness, freshness, reconnect behavior, and event ordering matter.

The inspector UI is built with SolidJS to take advantage of fine-grained reactivity for high-frequency event streams.
```

---

# 17. CV / interview positioning

## General version

> Built Wiretap, a SolidJS-based real-time WebSocket stream debugger that captures event streams, tracks topic health, detects sequence gaps and stale periods, inspects payloads, and exports replay buffers for deterministic debugging.

## Alchemy-specific version

> Built Wiretap, a SolidJS developer tool for debugging real-time trading terminal streams, with topic health, stale-state visualization, sequence-gap detection, payload inspection, reconnect tracking, and replay-buffer export.

## Strong interview explanation

> After building Flamel, I wanted tooling that made real-time stream behavior visible. Wiretap is the tool I wished I had while debugging stale state, reconnects, sequence gaps and malformed events. It connects to a live stream, groups events by topic, detects ordering issues, visualizes stale periods and lets me inspect or export captured payloads. I built the UI in SolidJS because its fine-grained reactivity maps well to high-frequency stream inspection.

---

# 18. Product success criteria

Wiretap is successful if a strong engineer thinks:

> This person understands that real-time apps need tooling, not just WebSockets.

Specific success signs:

- the event table is dense and useful
- topic health makes stream behavior instantly legible
- sequence gaps are obvious
- stale periods are visible
- payload inspection is fast
- capture/export works
- the tool integrates with Tape and Flamel
- the architecture is layered and defensible
- the UI feels like a real developer tool, not a toy dashboard
- SolidJS is used deliberately for fine-grained, high-frequency UI updates

---

# 19. Final build strategy

Build in this order:

```text
1. SolidJS web inspector
2. Direct WebSocket connection
3. Topic health + gap/stale detection
4. Payload inspector
5. Pause buffer + export
6. Go local agent
7. Timeline
8. Electrobun desktop shell
```

The most important rule:

> The SolidJS Web UI is the product. The Go agent is infrastructure. The Electrobun shell is polish.

Do not let agent or desktop packaging delay the core inspection experience.
