package main

import (
	"net/http"
	"strconv"
	"strings"
)

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
