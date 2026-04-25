package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	replayFormatRaw   = "raw"
	replayFormatJSONL = "jsonl"
	replayFormatTape  = "tape"
)

type replayOptions struct {
	Speed  float64 `json:"speed"`
	Loop   bool    `json:"loop"`
	Paused bool    `json:"paused"`
	Format string  `json:"format"`
}

type replayFrame struct {
	Opcode     byte
	Payload    []byte
	ReceivedAt time.Time
}

type replayPlaybackState struct {
	mu      sync.RWMutex
	speed   float64
	loop    bool
	paused  bool
	wakeups chan struct{}
}

type replayControlMessage struct {
	Type   string  `json:"type"`
	Speed  float64 `json:"speed,omitempty"`
	Loop   *bool   `json:"loop,omitempty"`
	Paused *bool   `json:"paused,omitempty"`
}

func (a *agent) handleSessionReplay(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	options := parseReplayOptions(r.URL.Query())
	events, err := a.recorder.store.readAllEvents(sessionID)
	if err != nil {
		writeSessionStoreError(w, err)
		return
	}
	frames, err := replayFramesForEvents(events, options.Format)
	if err != nil {
		writeHTTPError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(frames) == 0 {
		writeHTTPError(w, http.StatusConflict, "session has no replayable events")
		return
	}

	if !isWebSocketUpgrade(r) {
		http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
		return
	}

	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket hijacking unsupported", http.StatusInternalServerError)
		return
	}

	conn, rw, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "websocket hijack failed", http.StatusInternalServerError)
		return
	}
	defer conn.Close()

	if err := writeUpgradeResponse(rw, key, ""); err != nil {
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	state := newReplayPlaybackState(options)
	go readReplayControlFrames(ctx, &upstreamConn{Conn: conn, reader: rw.Reader}, state, cancel)

	if err := serveReplayFrames(ctx, conn, frames, state); err != nil && !errors.Is(err, context.Canceled) {
		slog.Debug("replay websocket ended", "session", sessionID, "error", err)
	}
}

func parseReplayOptions(values url.Values) replayOptions {
	options := replayOptions{
		Speed:  1,
		Format: replayFormatRaw,
	}
	if speed, err := strconv.ParseFloat(strings.TrimSpace(values.Get("speed")), 64); err == nil {
		options.Speed = normalizeReplaySpeed(speed)
	}
	if loop, err := strconv.ParseBool(strings.TrimSpace(values.Get("loop"))); err == nil {
		options.Loop = loop
	}
	if paused, err := strconv.ParseBool(strings.TrimSpace(values.Get("paused"))); err == nil {
		options.Paused = paused
	}
	options.Format = normalizeReplayFormat(values.Get("format"))
	return options
}

func normalizeReplaySpeed(speed float64) float64 {
	switch {
	case speed < 0.25:
		return 0.25
	case speed > 8:
		return 8
	default:
		return speed
	}
}

func normalizeReplayFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "", replayFormatRaw:
		return replayFormatRaw
	case replayFormatJSONL, "wiretap":
		return replayFormatJSONL
	case replayFormatTape:
		return replayFormatTape
	default:
		return replayFormatRaw
	}
}

func replayFramesForEvents(events []captureEvent, format string) ([]replayFrame, error) {
	frames := make([]replayFrame, 0, len(events))
	for index, event := range events {
		frame, ok, err := replayFrameForEvent(event, index, format)
		if err != nil {
			return nil, err
		}
		if ok {
			frames = append(frames, frame)
		}
	}
	return frames, nil
}

func replayFrameForEvent(event captureEvent, index int, format string) (replayFrame, bool, error) {
	var payload []byte
	opcode := byte(0x1)
	var err error

	switch normalizeReplayFormat(format) {
	case replayFormatJSONL:
		payload, err = json.Marshal(exportEvent(event))
	case replayFormatTape:
		payload, err = json.Marshal(tapeEventRecord(event, index))
	default:
		opcode, payload, err = replayRawPayload(event)
	}
	if err != nil {
		return replayFrame{}, false, err
	}
	if len(payload) == 0 {
		return replayFrame{}, false, nil
	}

	receivedAt, _ := time.Parse(time.RFC3339Nano, event.ReceivedAt)
	return replayFrame{Opcode: opcode, Payload: payload, ReceivedAt: receivedAt}, true, nil
}

func replayRawPayload(event captureEvent) (byte, []byte, error) {
	opcode := byte(0x1)
	if strings.EqualFold(event.Opcode, "binary") {
		opcode = 0x2
	}

	if event.RawBase64 != "" {
		payload, err := base64.StdEncoding.DecodeString(event.RawBase64)
		if err != nil {
			return opcode, nil, fmt.Errorf("invalid rawBase64 for capture sequence %d: %w", event.CaptureSeq, err)
		}
		return opcode, payload, nil
	}
	if event.Raw != "" {
		return opcode, []byte(event.Raw), nil
	}
	if event.Envelope != nil {
		payload, err := json.Marshal(event.Envelope)
		return 0x1, payload, err
	}
	return opcode, nil, nil
}

func newReplayPlaybackState(options replayOptions) *replayPlaybackState {
	return &replayPlaybackState{
		speed:   normalizeReplaySpeed(options.Speed),
		loop:    options.Loop,
		paused:  options.Paused,
		wakeups: make(chan struct{}, 1),
	}
}

func (state *replayPlaybackState) snapshot() replayOptions {
	state.mu.RLock()
	defer state.mu.RUnlock()
	return replayOptions{Speed: state.speed, Loop: state.loop, Paused: state.paused}
}

func (state *replayPlaybackState) update(control replayControlMessage) {
	state.mu.Lock()
	switch strings.ToLower(strings.TrimSpace(control.Type)) {
	case "replay.play", "play":
		state.paused = false
	case "replay.pause", "pause":
		state.paused = true
	case "replay.speed", "speed":
		if control.Speed > 0 {
			state.speed = normalizeReplaySpeed(control.Speed)
		}
	case "replay.loop", "loop":
		if control.Loop != nil {
			state.loop = *control.Loop
		}
	case "replay.state", "state":
		if control.Speed > 0 {
			state.speed = normalizeReplaySpeed(control.Speed)
		}
		if control.Loop != nil {
			state.loop = *control.Loop
		}
		if control.Paused != nil {
			state.paused = *control.Paused
		}
	}
	state.mu.Unlock()
	state.wake()
}

func (state *replayPlaybackState) wake() {
	select {
	case state.wakeups <- struct{}{}:
	default:
	}
}

func readReplayControlFrames(ctx context.Context, conn *upstreamConn, state *replayPlaybackState, cancel context.CancelFunc) {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		frame, err := readServerFrame(conn)
		if err != nil {
			return
		}
		switch frame.opcode {
		case 0x1:
			var control replayControlMessage
			trimmed := strings.TrimSpace(string(frame.payload))
			if strings.HasPrefix(trimmed, "{") {
				if err := json.Unmarshal(frame.payload, &control); err != nil {
					continue
				}
			} else {
				control.Type = trimmed
			}
			state.update(control)
		case 0x8:
			return
		case 0x9:
			_ = writeWebSocketMessage(conn.Conn, 0xA, frame.payload)
		}
	}
}

func serveReplayFrames(ctx context.Context, conn net.Conn, frames []replayFrame, state *replayPlaybackState) error {
	for {
		for index, frame := range frames {
			if err := waitReplayDelay(ctx, state, replayFrameDelay(frames, index)); err != nil {
				return err
			}
			if err := waitReplayUnpaused(ctx, state); err != nil {
				return err
			}
			if err := conn.SetWriteDeadline(time.Now().Add(writeDeadlineTimeout)); err != nil {
				return err
			}
			if err := writeWebSocketMessage(conn, frame.Opcode, frame.Payload); err != nil {
				return err
			}
		}
		if !state.snapshot().Loop {
			return nil
		}
	}
}

func replayFrameDelay(frames []replayFrame, index int) time.Duration {
	if index <= 0 || index >= len(frames) {
		return 0
	}
	previous := frames[index-1].ReceivedAt
	current := frames[index].ReceivedAt
	if previous.IsZero() || current.IsZero() || current.Before(previous) {
		return 0
	}
	return current.Sub(previous)
}

func waitReplayDelay(ctx context.Context, state *replayPlaybackState, delay time.Duration) error {
	for {
		if err := waitReplayUnpaused(ctx, state); err != nil {
			return err
		}
		options := state.snapshot()
		scaled := time.Duration(float64(delay) / options.Speed)
		if scaled <= 0 {
			return nil
		}
		timer := time.NewTimer(scaled)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-state.wakeups:
			timer.Stop()
			continue
		case <-timer.C:
			return nil
		}
	}
}

func waitReplayUnpaused(ctx context.Context, state *replayPlaybackState) error {
	for {
		if !state.snapshot().Paused {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-state.wakeups:
		}
	}
}
