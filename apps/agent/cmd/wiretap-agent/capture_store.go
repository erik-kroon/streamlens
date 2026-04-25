package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const (
	captureStoreSchemaVersion = 1
	defaultStoredEventLimit   = 100_000
	maxStoredEventLineBytes   = 4 * maxRawMessageBytes
)

type captureStore struct {
	dir        string
	eventLimit int
}

type captureStoreIndex struct {
	SchemaVersion    int    `json:"schemaVersion"`
	CurrentSessionID string `json:"currentSessionId"`
}

type captureSession struct {
	ID                 string `json:"id"`
	SchemaVersion      int    `json:"schemaVersion"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
	TargetURL          string `json:"targetUrl,omitempty"`
	EventCount         int64  `json:"eventCount"`
	IssueCount         int64  `json:"issueCount"`
	RetainedEventCount int    `json:"retainedEventCount"`
}

type captureSessionSnapshot struct {
	Session captureSession `json:"session"`
	Events  []captureEvent `json:"events"`
	Topics  []topicState   `json:"topics"`
}

type captureEventPage struct {
	Session captureSession `json:"session"`
	Offset  int            `json:"offset"`
	Limit   int            `json:"limit"`
	Total   int            `json:"total"`
	Events  []captureEvent `json:"events"`
}

func openCaptureStore(dir string) (*captureStore, error) {
	if dir == "" {
		defaultDir, err := defaultCaptureStoreDir()
		if err != nil {
			return nil, err
		}
		dir = defaultDir
	}
	store := &captureStore{dir: dir, eventLimit: defaultStoredEventLimit}
	if err := os.MkdirAll(store.sessionsDir(), 0o755); err != nil {
		return nil, err
	}
	return store, nil
}

func defaultCaptureStoreDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "wiretap", "captures"), nil
}

func (store *captureStore) loadOrCreateCurrentSession() (captureSessionSnapshot, error) {
	index, err := store.readIndex()
	if err != nil {
		return captureSessionSnapshot{}, err
	}
	if index.CurrentSessionID == "" {
		return store.createSession("")
	}

	snapshot, err := store.loadSession(index.CurrentSessionID)
	if err == nil {
		return snapshot, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return captureSessionSnapshot{}, err
	}
	return store.createSession("")
}

func (store *captureStore) createSession(targetURL string) (captureSessionSnapshot, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	session := captureSession{
		ID:            fmt.Sprintf("cap-%d", time.Now().UTC().UnixNano()),
		SchemaVersion: captureStoreSchemaVersion,
		CreatedAt:     now,
		UpdatedAt:     now,
		TargetURL:     targetURL,
	}
	if err := os.MkdirAll(store.sessionDir(session.ID), 0o755); err != nil {
		return captureSessionSnapshot{}, err
	}
	if err := store.writeSession(session); err != nil {
		return captureSessionSnapshot{}, err
	}
	if err := store.writeTopics(session.ID, nil); err != nil {
		return captureSessionSnapshot{}, err
	}
	if err := store.writeIndex(captureStoreIndex{
		SchemaVersion:    captureStoreSchemaVersion,
		CurrentSessionID: session.ID,
	}); err != nil {
		return captureSessionSnapshot{}, err
	}
	return captureSessionSnapshot{Session: session}, nil
}

func (store *captureStore) loadSession(sessionID string) (captureSessionSnapshot, error) {
	session, err := store.readSession(sessionID)
	if err != nil {
		return captureSessionSnapshot{}, err
	}
	topics, err := store.readTopics(sessionID)
	if err != nil {
		return captureSessionSnapshot{}, err
	}
	events, err := store.readLastEvents(sessionID, maxBufferedEvents)
	if err != nil {
		return captureSessionSnapshot{}, err
	}
	return captureSessionSnapshot{Session: session, Events: events, Topics: topics}, nil
}

func (store *captureStore) appendEvent(sessionID string, event captureEvent, topics []topicState, session captureSession) (captureSession, error) {
	if err := os.MkdirAll(store.sessionDir(sessionID), 0o755); err != nil {
		return captureSession{}, err
	}
	file, err := os.OpenFile(store.eventsPath(sessionID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return captureSession{}, err
	}
	encoder := json.NewEncoder(file)
	if err := encoder.Encode(event); err != nil {
		_ = file.Close()
		return captureSession{}, err
	}
	if err := file.Close(); err != nil {
		return captureSession{}, err
	}
	if err := store.writeTopics(sessionID, topics); err != nil {
		return captureSession{}, err
	}
	session.UpdatedAt = event.ReceivedAt
	if err := store.writeSession(session); err != nil {
		return captureSession{}, err
	}
	return session, nil
}

func (store *captureStore) writeTopicSnapshot(sessionID string, topics []topicState, session captureSession) (captureSession, error) {
	session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := store.writeTopics(sessionID, topics); err != nil {
		return captureSession{}, err
	}
	if err := store.writeSession(session); err != nil {
		return captureSession{}, err
	}
	return session, nil
}

func (store *captureStore) eventPage(sessionID string, offset int, limit int) (captureEventPage, error) {
	session, err := store.readSession(sessionID)
	if err != nil {
		return captureEventPage{}, err
	}
	events, total, err := store.readEventPage(sessionID, offset, limit)
	if err != nil {
		return captureEventPage{}, err
	}
	return captureEventPage{Session: session, Offset: offset, Limit: limit, Total: total, Events: events}, nil
}

func (store *captureStore) readIndex() (captureStoreIndex, error) {
	var index captureStoreIndex
	if err := readJSONFile(store.indexPath(), &index); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return captureStoreIndex{SchemaVersion: captureStoreSchemaVersion}, nil
		}
		return captureStoreIndex{}, err
	}
	if index.SchemaVersion == 0 {
		index.SchemaVersion = captureStoreSchemaVersion
	}
	return index, nil
}

func (store *captureStore) writeIndex(index captureStoreIndex) error {
	return writeJSONFile(store.indexPath(), index)
}

func (store *captureStore) readSession(sessionID string) (captureSession, error) {
	var session captureSession
	if err := readJSONFile(store.sessionPath(sessionID), &session); err != nil {
		return captureSession{}, err
	}
	if session.SchemaVersion != captureStoreSchemaVersion {
		return captureSession{}, fmt.Errorf("unsupported capture session schema version %d", session.SchemaVersion)
	}
	return session, nil
}

func (store *captureStore) writeSession(session captureSession) error {
	return writeJSONFile(store.sessionPath(session.ID), session)
}

func (store *captureStore) readTopics(sessionID string) ([]topicState, error) {
	var topics []topicState
	if err := readJSONFile(store.topicsPath(sessionID), &topics); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return topics, nil
}

func (store *captureStore) writeTopics(sessionID string, topics []topicState) error {
	if topics == nil {
		topics = []topicState{}
	}
	return writeJSONFile(store.topicsPath(sessionID), topics)
}

func (store *captureStore) readLastEvents(sessionID string, count int) ([]captureEvent, error) {
	events, _, err := store.readEventPage(sessionID, 0, defaultStoredEventLimit)
	if err != nil {
		return nil, err
	}
	if len(events) <= count {
		return events, nil
	}
	return events[len(events)-count:], nil
}

func (store *captureStore) readEventPage(sessionID string, offset int, limit int) ([]captureEvent, int, error) {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 || limit > 1_000 {
		limit = 1_000
	}

	file, err := os.Open(store.eventsPath(sessionID))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []captureEvent{}, 0, nil
		}
		return nil, 0, err
	}
	defer file.Close()

	var events []captureEvent
	total := 0
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), maxStoredEventLineBytes)
	for scanner.Scan() {
		var event captureEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return nil, 0, err
		}
		if total >= offset && len(events) < limit {
			events = append(events, event)
		}
		total++
	}
	if err := scanner.Err(); err != nil {
		return nil, 0, err
	}
	return events, total, nil
}

func (store *captureStore) sessionsDir() string {
	return filepath.Join(store.dir, "sessions")
}

func (store *captureStore) sessionDir(sessionID string) string {
	return filepath.Join(store.sessionsDir(), sessionID)
}

func (store *captureStore) indexPath() string {
	return filepath.Join(store.dir, "index.json")
}

func (store *captureStore) sessionPath(sessionID string) string {
	return filepath.Join(store.sessionDir(sessionID), "session.json")
}

func (store *captureStore) eventsPath(sessionID string) string {
	return filepath.Join(store.sessionDir(sessionID), "events.jsonl")
}

func (store *captureStore) topicsPath(sessionID string) string {
	return filepath.Join(store.sessionDir(sessionID), "topics.json")
}

func writeJSONFile(path string, value interface{}) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSONFile(path string, value interface{}) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewDecoder(file).Decode(value)
}

func sortTopicsByID(topics []topicState) {
	sort.Slice(topics, func(i int, j int) bool {
		return topics[i].ID < topics[j].ID
	})
}
