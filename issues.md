# Wiretap Optimal-State Issue Breakdown

Parent PRD source: `docs/prd.md`

The PRD currently exists as a local document, not a GitHub issue. Before creating GitHub issues, create or identify a parent PRD issue and use its issue number in each child issue body.

This breakdown targets the end-state product, not only MVP. It includes desktop packaging, persistence, replay/import, `.tape` export, multiple transports, extension surfaces, schema plugins, OpenTelemetry correlation, diffing, latency analytics, replay/fault tooling, fuzzing, and native packet inspection.

## Proposed Issues

1. **Agent status protocol reaches the SolidJS shell**
   - Type: AFK
   - Blocked by: None
   - User stories covered: 3
   - Scope: Go agent process, health endpoint, live status WebSocket, typed agent-to-UI protocol, SolidJS shell status rendering.

2. **Agent connects to upstream WebSocket and streams captured raw events to UI**
   - Type: AFK
   - Blocked by: 1
   - User stories covered: 1, 2, 3, 4
   - Scope: upstream WebSocket client, custom headers, bearer/API-key auth, subprotocols, connect/disconnect/reconnect commands, raw capture feed.

3. **Agent normalizes envelopes and preserves malformed/oversized messages**
   - Type: AFK
   - Blocked by: 2
   - User stories covered: 4, 5, 6, 11
   - Scope: default envelope parser, schema validation, effective key, malformed JSON, oversized truncation, retained capture model, tests.

4. **Virtualized event table and payload inspector render captured events**
   - Type: AFK
   - Blocked by: 3
   - User stories covered: 4, 5, 6, 11
   - Scope: fixed-row virtual table, capture-order rendering, row selection, parsed/payload/raw/issues/metadata inspector tabs.

5. **Topic health rows expose rate, freshness, and issue counters**
   - Type: AFK
   - Blocked by: 3, 4
   - User stories covered: 7, 13
   - Scope: topic/key aggregation, rolling rates, last seen, state, issue counts, click-to-filter.

6. **Sequence gap, duplicate, and out-of-order issues surface end-to-end**
   - Type: AFK
   - Blocked by: 5
   - User stories covered: 8, 9, 11, 14
   - Scope: sequence cursor logic, issue creation, event-row badges, topic counters, issue inspector details.

7. **Stale topic detection updates without new messages**
   - Type: AFK
   - Blocked by: 5
   - User stories covered: 7, 10, 14
   - Scope: default topic rules, 500ms stale tick, stale transitions, topic-level issues, UI surfacing.

8. **Pause live-follow while agent capture continues**
   - Type: AFK
   - Blocked by: 4, 5
   - User stories covered: 3, 12, 13
   - Scope: UI auto-follow pause, buffered count since pause, continued agent capture, resume-to-latest.

9. **JSONL export writes the retained capture**
   - Type: AFK
   - Blocked by: 3
   - User stories covered: 5, 6, 15
   - Scope: export endpoint, retained capture format, truncation metadata, browser download UI, export tests.

10. **Deterministic demo stream drives issue scenarios through the full stack**
    - Type: AFK
    - Blocked by: 6, 7, 9
    - User stories covered: 16, 18
    - Scope: local demo stream server, normal/gap/duplicate/out-of-order/stale/malformed/oversized scenarios, UI scenario selector.

11. **1,000 events/sec burst remains usable**
    - Type: AFK
    - Blocked by: 8, 10
    - User stories covered: 17
    - Scope: burst generator, agent buffer cap verification, UI responsiveness checks, metrics under load.

12. **Persistent capture database stores sessions across restarts**
    - Type: AFK
    - Blocked by: 9
    - User stories covered: 3, 15
    - Scope: local embedded capture database, session metadata, event pages, issue/topic snapshots, retention limits, migration path.

13. **Capture library lists, opens, deletes, and exports saved sessions**
    - Type: AFK
    - Blocked by: 12
    - User stories covered: 3, 11, 15
    - Scope: saved capture API, capture library UI, session open/delete, export from persisted capture.

14. **Import JSONL as an inspectable capture session**
    - Type: AFK
    - Blocked by: 12, 13
    - User stories covered: 11, 15
    - Scope: JSONL import parser, capture reconstruction, issue recomputation, imported-session UI state.

15. **Replay imported or saved captures through the inspector**
    - Type: AFK
    - Blocked by: 14
    - User stories covered: 11, 15
    - Scope: replay clock, speed controls, pause/seek, replayed event status, topic health during replay.

16. **Export capture to Tape-compatible `.tape` format**
    - Type: AFK
    - Blocked by: 14, 15
    - User stories covered: 15, 18
    - Scope: `.tape` mapping, metadata preservation, export UI, compatibility verification against Tape.

17. **Manage multiple simultaneous upstream streams**
    - Type: AFK
    - Blocked by: 2, 12
    - User stories covered: 1, 3, 4, 7, 13
    - Scope: multiple connection configs, stream IDs, per-stream buffers, merged/global views, per-stream filters, UI stream switcher.

18. **Add SSE as a first-class capture transport**
    - Type: AFK
    - Blocked by: 17
    - User stories covered: 1, 4, 5, 7, 11
    - Scope: SSE upstream client, shared capture normalization path, transport metadata, UI transport selection.

19. **Add WebTransport as a first-class capture transport**
    - Type: HITL
    - Blocked by: 17
    - User stories covered: 1, 4, 5, 7, 11
    - Scope: WebTransport feasibility spike, connection support, stream/datagram capture mapping, UI transport metadata.

20. **Configurable extraction rules and schema plugin runtime**
    - Type: AFK
    - Blocked by: 3, 12
    - User stories covered: 5, 7, 8, 10, 11, 13
    - Scope: topic/key/seq/timestamp extraction config, plugin interface, sandbox boundaries, schema validation results, rule editor.

21. **Schema plugin marketplace/local plugin management**
    - Type: HITL
    - Blocked by: 20
    - User stories covered: 5, 11, 13
    - Scope: plugin install/load/update UX, local trust model, plugin metadata, enable/disable, error isolation.

22. **OpenTelemetry correlation connects stream events to traces/logs**
    - Type: AFK
    - Blocked by: 20
    - User stories covered: 5, 11, 13
    - Scope: trace/span extraction, correlation fields, OTLP import/query config, inspector correlation panel.

23. **Latency histogram and source-lag analytics**
    - Type: AFK
    - Blocked by: 3, 5, 12
    - User stories covered: 7, 10, 11, 17
    - Scope: source timestamp lag, receive interval latency, histogram aggregation, timeline/summary visualization.

24. **Timeline shows density, issues, stale intervals, reconnects, and latency**
    - Type: AFK
    - Blocked by: 6, 7, 23
    - User stories covered: 7, 8, 9, 10, 11, 14
    - Scope: visual timeline, density bands, issue markers, stale intervals, reconnect markers, latency overlay, click-to-jump.

25. **Stream diff compares two captures or live streams**
    - Type: AFK
    - Blocked by: 13, 17, 20
    - User stories covered: 4, 7, 8, 9, 11, 15
    - Scope: capture/live stream selection, event alignment, missing/extra/divergent event detection, diff UI.

26. **Replay server serves saved captures as live streams**
    - Type: AFK
    - Blocked by: 15, 16
    - User stories covered: 15, 18
    - Scope: local replay WebSocket server, speed controls, loop/pause, `.tape`/JSONL replay sources, endpoint UI.

27. **Fault-injection proxy mutates live streams for testing**
    - Type: AFK
    - Blocked by: 2, 6, 7, 26
    - User stories covered: 8, 9, 10, 16, 18
    - Scope: proxy mode, drop/duplicate/reorder/delay/mutate rules, scenario controls, issue verification.

28. **Protocol fuzzing generates adversarial stream inputs**
    - Type: AFK
    - Blocked by: 20, 27
    - User stories covered: 5, 6, 16, 17
    - Scope: fuzz generators, schema-aware and raw mutation modes, safety limits, reproducible seeds, regression fixtures.

29. **Chrome DevTools extension inspects browser app streams through Wiretap**
    - Type: HITL
    - Blocked by: 1, 2, 17
    - User stories covered: 1, 4, 5, 11
    - Scope: extension architecture decision, page/content/devtools panels, bridge to local agent, permission model.

30. **Electrobun desktop shell bundles UI and agent**
    - Type: AFK
    - Blocked by: 13, 24
    - User stories covered: 1, 2, 3, 11, 15
    - Scope: desktop packaging, agent lifecycle, port management, native save/open, recent targets, update-safe local storage.

31. **Native packet inspection captures low-level traffic metadata**
    - Type: HITL
    - Blocked by: 17, 30
    - User stories covered: 4, 10, 11
    - Scope: platform feasibility, permissions, capture adapter, packet-to-application correlation, privacy/security UX.

32. **Design review for dense developer-tool ergonomics**
    - Type: HITL
    - Blocked by: 4, 5, 6, 7, 24, 30
    - User stories covered: 7, 11, 12, 13, 14
    - Scope: desktop/web density, table ergonomics, inspector polish, timeline readability, accessibility, interaction review.

## Dependency Order

Create issues in this order unless implementation priorities change:

1. Agent status protocol reaches the SolidJS shell
2. Agent connects to upstream WebSocket and streams captured raw events to UI
3. Agent normalizes envelopes and preserves malformed/oversized messages
4. Virtualized event table and payload inspector render captured events
5. Topic health rows expose rate, freshness, and issue counters
6. Sequence gap, duplicate, and out-of-order issues surface end-to-end
7. Stale topic detection updates without new messages
8. Pause live-follow while agent capture continues
9. JSONL export writes the retained capture
10. Deterministic demo stream drives issue scenarios through the full stack
11. 1,000 events/sec burst remains usable
12. Persistent capture database stores sessions across restarts
13. Capture library lists, opens, deletes, and exports saved sessions
14. Import JSONL as an inspectable capture session
15. Replay imported or saved captures through the inspector
16. Export capture to Tape-compatible `.tape` format
17. Manage multiple simultaneous upstream streams
18. Add SSE as a first-class capture transport
19. Add WebTransport as a first-class capture transport
20. Configurable extraction rules and schema plugin runtime
21. Schema plugin marketplace/local plugin management
22. OpenTelemetry correlation connects stream events to traces/logs
23. Latency histogram and source-lag analytics
24. Timeline shows density, issues, stale intervals, reconnects, and latency
25. Stream diff compares two captures or live streams
26. Replay server serves saved captures as live streams
27. Fault-injection proxy mutates live streams for testing
28. Protocol fuzzing generates adversarial stream inputs
29. Chrome DevTools extension inspects browser app streams through Wiretap
30. Electrobun desktop shell bundles UI and agent
31. Native packet inspection captures low-level traffic metadata
32. Design review for dense developer-tool ergonomics

Phase 0: reconcile current partial implementation against issues 1-4.

Phase 1, parallel:

Workspace A: 1-3 hardening.
Workspace B: 4 + 8 UI table/inspector/live-follow.
Workspace C: 5-7 topic health and issue detection.
Workspace D: 9 export, then 10 demo scaffolding.
Phase 2:

10 full-stack scenario completion.
11 burst/performance.
12 persistence.
Phase 3, parallel after 12:

13 library.
14 import.
17 multi-stream design/implementation, if persistence model supports it.
20 extraction rules/plugin runtime design, if topic contracts are stable.
Phase 4:

15, 16, 18, 22, 23, 25.
Phase 5:

24, 26, 27, 28, 30, 32.
Phase 6 HITL/platform:

19, 21, 29, 31.
