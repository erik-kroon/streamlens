# Wiretap

Wiretap is a local real-time event-stream debugger for WebSocket and SSE-based applications.

It runs a Go capture agent beside a SolidJS inspector so you can see what actually happened in a live stream: event order, topic freshness, sequence gaps, duplicate or malformed messages, reconnect behavior, raw payloads, and exportable captures.

Wiretap is built for systems where stream correctness matters. Trading terminals, collaborative tools, dashboards, replay engines, and event-driven internal tools all fail in ways that are hard to diagnose from logs alone. Wiretap keeps the stream local and makes those failures inspectable.

## What It Does

- Captures WebSocket and SSE messages through a local Go agent.
- Preserves raw payloads, receive timestamps, capture sequence, transport metadata, and parsed envelopes.
- Tracks topic/key health, message rates, stale scopes, parse errors, schema errors, sequence gaps, duplicates, and out-of-order events.
- Provides a SolidJS inspector with live event tables, payload inspection, issue views, topic health, session history, import, and export.
- Exports retained captures as JSONL and Tape-compatible files for deterministic replay and debugging.
- Ships with demo streams for normal, gap, duplicate, out-of-order, stale, malformed, oversized, burst, and fuzz scenarios.

## Architecture

```text
Target stream
  -> Wiretap Agent (Go)
  -> Wiretap Web UI (SolidJS)
  -> optional Wiretap Desktop shell (Electrobun)
```

The agent is the capture source of truth. The UI connects to the local agent API and renders the current capture state.

Default local ports:

- Agent API: `http://localhost:8790`
- Agent live feed: `ws://localhost:8790/live`
- Demo stream: `ws://localhost:8791/stream`
- Demo SSE stream: `http://localhost:8791/stream`

## Quick Start

Prerequisites:

- Bun
- Go

Install dependencies:

```sh
bun install
```

Start the Wiretap agent:

```sh
bun run dev:agent
```

Start the web UI in another terminal:

```sh
bun run dev:web
```

Open the Vite URL printed by the web process. The UI defaults to the local Wiretap agent and can connect to the built-in demo stream.

## Useful Commands

```sh
bun run dev              # run the workspace dev tasks
bun run dev:agent        # run the Go capture agent and demo stream
bun run dev:web          # run the SolidJS inspector
bun run dev:desktop      # run the Electrobun shell in development
bun run build            # build the workspace
bun run check-types      # run TypeScript checks
```

Run the agent directly:

```sh
cd apps/agent
go run ./cmd/wiretap-agent
```

Use a custom agent URL from the web UI:

```sh
VITE_WIRETAP_AGENT_URL=http://localhost:8790 bun run dev:web
```

Use a custom capture data directory:

```sh
WIRETAP_DATA_DIR=/tmp/wiretap bun run dev:agent
```

## Stream Envelope

Wiretap can keep raw messages, but it gets the most signal from JSON events shaped like this:

```ts
type WiretapEnvelope = {
  topic: string;
  type: string;
  seq?: number;
  ts?: number | string;
  key?: string;
  symbol?: string;
  payload?: unknown;
};
```

`topic`, `key` or `symbol`, and `seq` let Wiretap group scopes, track freshness, and detect ordering problems.

## Repository Layout

```text
apps/agent      Go capture agent, demo stream, import/export, replay support
apps/web        SolidJS inspector UI
apps/desktop    Electrobun desktop wrapper
packages/*      Shared TypeScript config and environment helpers
docs/prd.md     Product requirements and implementation scope
issues.md       Issue breakdown
```
