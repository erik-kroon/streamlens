package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

const maxImportJSONLBytes = 512 * 1024 * 1024

func (a *agent) handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	if a.recorder == nil || a.recorder.store == nil {
		writeHTTPError(w, http.StatusServiceUnavailable, "capture database is not configured")
		return
	}

	sessions, err := a.recorder.store.listSessions()
	if err != nil {
		writeHTTPError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (a *agent) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	if a.recorder == nil || a.recorder.store == nil {
		writeHTTPError(w, http.StatusServiceUnavailable, "capture database is not configured")
		return
	}

	sessionID, action, ok := parseSessionPath(r.URL.Path)
	if !ok || invalidSessionID(sessionID) {
		http.NotFound(w, r)
		return
	}

	switch {
	case action == "open" && r.Method == http.MethodPost:
		a.handleOpenSession(w, sessionID)
	case action == "events" && r.Method == http.MethodGet:
		a.handleSessionEvents(w, r, sessionID)
	case action == "export/jsonl" && r.Method == http.MethodGet:
		a.handleExportSessionJSONL(w, sessionID)
	case action == "export/tape" && r.Method == http.MethodGet:
		a.handleExportSessionTape(w, sessionID)
	case action == "replay" && r.Method == http.MethodGet:
		a.handleSessionReplay(w, r, sessionID)
	case action == "" && r.Method == http.MethodDelete:
		a.handleDeleteSession(w, sessionID)
	default:
		allowed := []string{http.MethodDelete, http.MethodGet, http.MethodPost}
		writeMethodNotAllowed(w, allowed...)
	}
}

func (a *agent) handleCurrentSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	if a.recorder == nil {
		writeHTTPError(w, http.StatusServiceUnavailable, "capture database is not configured")
		return
	}

	writeJSON(w, http.StatusOK, a.recorder.currentSession())
}

func (a *agent) handleCurrentSessionEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	if a.recorder == nil {
		writeHTTPError(w, http.StatusServiceUnavailable, "capture database is not configured")
		return
	}

	offset := parseQueryInt(r, "offset", 0)
	limit := parseQueryInt(r, "limit", 1_000)
	page, err := a.recorder.eventPage(offset, limit)
	if err != nil {
		writeHTTPError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *agent) handleImportJSONL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	if a.recorder == nil {
		writeHTTPError(w, http.StatusServiceUnavailable, "capture database is not configured")
		return
	}

	reader, filename, closeReader, err := importBodyReader(w, r)
	if err != nil {
		writeHTTPError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer closeReader()

	events, err := parseImportJSONL(reader)
	if err != nil {
		writeHTTPError(w, http.StatusBadRequest, err.Error())
		return
	}

	a.stopAllConnections(stateReady, "")
	targetURL := "import:jsonl"
	if filename != "" {
		targetURL = "import:" + filename
	}
	result, err := a.importJSONLEvents(events, targetURL)
	if err != nil {
		writeHTTPError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func importBodyReader(w http.ResponseWriter, r *http.Request) (io.Reader, string, func(), error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImportJSONLBytes)
	contentType := r.Header.Get("Content-Type")
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err == nil && mediaType == "multipart/form-data" {
		if err := r.ParseMultipartForm(maxImportJSONLBytes); err != nil {
			return nil, "", func() {}, err
		}
		file, header, err := r.FormFile("capture")
		if err != nil {
			return nil, "", func() {}, err
		}
		filename := filepath.Base(header.Filename)
		if filename == "." || filename == string(filepath.Separator) {
			filename = ""
		}
		return file, filename, func() { _ = file.Close() }, nil
	}
	return r.Body, "", func() { _ = r.Body.Close() }, nil
}

func (a *agent) handleOpenSession(w http.ResponseWriter, sessionID string) {
	snapshot, err := a.recorder.store.openSession(sessionID)
	if err != nil {
		writeSessionStoreError(w, err)
		return
	}
	a.loadSessionSnapshot(snapshot)
	writeJSON(w, http.StatusOK, snapshot.Session)
}

func (a *agent) handleSessionEvents(w http.ResponseWriter, r *http.Request, sessionID string) {
	offset := parseQueryInt(r, "offset", 0)
	limit := parseQueryInt(r, "limit", 1_000)
	page, err := a.recorder.store.eventPage(sessionID, offset, limit)
	if err != nil {
		writeSessionStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (a *agent) handleDeleteSession(w http.ResponseWriter, sessionID string) {
	snapshot, err := a.recorder.store.deleteSession(sessionID)
	if err != nil {
		writeSessionStoreError(w, err)
		return
	}

	if snapshot.Session.ID != "" {
		a.loadSessionSnapshot(snapshot)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *agent) handleExportSessionJSONL(w http.ResponseWriter, sessionID string) {
	session, err := a.recorder.store.readSession(sessionID)
	if err != nil {
		writeSessionStoreError(w, err)
		return
	}
	events, err := a.recorder.store.readAllEvents(sessionID)
	if err != nil {
		writeHTTPError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", exportSessionFilename(session)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	encoder := json.NewEncoder(w)
	for _, event := range events {
		if err := encoder.Encode(exportEvent(event)); err != nil {
			slog.Error("failed to write session jsonl export", "session", sessionID, "error", err)
			return
		}
	}
}

func (a *agent) loadSessionSnapshot(snapshot captureSessionSnapshot) {
	a.mu.Lock()
	a.events = snapshot.Events
	a.topics = newTopicTrackerFromSnapshot(snapshot.Topics)
	a.eventCount = snapshot.Session.EventCount
	a.issueCount = snapshot.Session.IssueCount
	a.nextCaptureSeq = latestCaptureSeq(snapshot.Events)
	a.sequences = newSequenceTracker()
	a.rebuildSequenceTrackerFromEventsLocked()
	a.rebuildStreamRuntimeFromEventsLocked()
	if a.recorder != nil {
		a.recorder.setSession(snapshot.Session)
	}
	a.mu.Unlock()

	a.broadcast(agentMessage{Type: "capture.snapshot", Payload: snapshot.Events})
	a.broadcast(agentMessage{Type: "topic.snapshot", Payload: snapshot.Topics})
	a.broadcast(agentMessage{Type: "capture.stats", Payload: a.stats()})
}

func parseQueryInt(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func parseSessionPath(path string) (string, string, bool) {
	trimmed := strings.Trim(strings.TrimPrefix(path, "/sessions/"), "/")
	if trimmed == "" || trimmed == path {
		return "", "", false
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) == 1 {
		return parts[0], "", true
	}
	return parts[0], strings.Join(parts[1:], "/"), true
}

func invalidSessionID(sessionID string) bool {
	return sessionID == "" || strings.Contains(sessionID, "/") || strings.Contains(sessionID, "\\") || strings.Contains(sessionID, "..")
}

func writeSessionStoreError(w http.ResponseWriter, err error) {
	if strings.Contains(err.Error(), "no such file") {
		writeHTTPError(w, http.StatusNotFound, "capture session was not found")
		return
	}
	writeHTTPError(w, http.StatusInternalServerError, err.Error())
}

func exportSessionFilename(session captureSession) string {
	id := strings.TrimSpace(session.ID)
	if id == "" {
		id = "session"
	}
	return fmt.Sprintf("wiretap-%s.jsonl", id)
}
