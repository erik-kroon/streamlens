package main

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

func (a *agent) ensureStreamsLocked() {
	if a.streams == nil {
		a.streams = make(map[string]*streamRuntime)
	}
}

func (a *agent) refreshAggregateConnectionStateLocked() {
	a.state = stateReady
	a.lastError = ""
	a.connectedAt = nil
	a.connectionID = ""
	a.session = nil
	a.activeConfig = nil

	var fallback *streamRuntime
	for _, stream := range a.streams {
		if fallback == nil || stream.ID < fallback.ID {
			fallback = stream
		}
		if stream.State == stateConnected {
			a.state = stateConnected
			a.lastError = stream.LastError
			a.connectedAt = stream.ConnectedAt
			a.connectionID = stream.ConnectionID
			a.session = stream.Session
			a.activeConfig = stream.Config
			return
		}
		if stream.State == stateConnecting || stream.State == stateReconnecting {
			a.state = stream.State
			a.lastError = stream.LastError
			a.session = stream.Session
			a.activeConfig = stream.Config
		} else if stream.State == stateError && a.state == stateReady {
			a.state = stateError
			a.lastError = stream.LastError
			a.activeConfig = stream.Config
		}
	}
	if a.activeConfig == nil && fallback != nil {
		a.activeConfig = fallback.Config
	}
	if len(a.streams) > 0 && a.state == stateReady {
		a.state = stateDisconnected
	}
}

func (a *agent) streamStatusesLocked() []streamStatus {
	statuses := make([]streamStatus, 0, len(a.streams))
	for _, stream := range a.streams {
		connectedAt := stream.ConnectedAtText
		if connectedAt == "" && stream.ConnectedAt != nil {
			connectedAt = stream.ConnectedAt.Format(time.RFC3339Nano)
		}
		statuses = append(statuses, streamStatus{
			ID:           stream.ID,
			Transport:    stream.Transport,
			URL:          stream.URL,
			State:        stream.State,
			LastError:    stream.LastError,
			ConnectedAt:  connectedAt,
			ConnectionID: stream.ConnectionID,
			Connections:  stream.Connections,
			Events:       stream.Events,
			Issues:       stream.Issues,
		})
	}
	sortStreamStatuses(statuses)
	return statuses
}

func (a *agent) rebuildStreamRuntimeFromEvents() {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.rebuildStreamRuntimeFromEventsLocked()
}

func (a *agent) rebuildStreamRuntimeFromEventsLocked() {
	a.streams = make(map[string]*streamRuntime)
	for _, event := range a.events {
		streamID := normalizedStreamID(event.StreamID)
		stream := a.streams[streamID]
		if stream == nil {
			stream = &streamRuntime{ID: streamID, State: stateDisconnected}
			a.streams[streamID] = stream
		}
		if event.Transport != "" {
			stream.Transport = event.Transport
		}
		stream.Events++
		stream.Issues += int64(len(event.Issues))
		if event.ConnectionID != "" {
			stream.ConnectionID = event.ConnectionID
		}
	}
	a.refreshAggregateConnectionStateLocked()
}

func normalizedStreamID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultStreamID
	}
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			builder.WriteRune(char)
		}
	}
	if builder.Len() == 0 {
		return defaultStreamID
	}
	return builder.String()
}

func streamIDFromRequest(r *http.Request) string {
	return normalizedStreamID(r.URL.Query().Get("streamId"))
}

func sortStreamStatuses(streams []streamStatus) {
	sort.Slice(streams, func(i, j int) bool {
		return streams[i].ID < streams[j].ID
	})
}
