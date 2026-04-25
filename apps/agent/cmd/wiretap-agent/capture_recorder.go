package main

import (
	"errors"
	"sync"
	"time"
)

type captureRecorder struct {
	mu      sync.Mutex
	store   *captureStore
	session captureSession
}

func newCaptureRecorder(store *captureStore, session captureSession) *captureRecorder {
	return &captureRecorder{store: store, session: session}
}

func (recorder *captureRecorder) currentSession() captureSession {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.session
}

func (recorder *captureRecorder) createSession(targetURL string) (captureSession, error) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if recorder.store == nil {
		recorder.session = captureSession{}
		return recorder.session, nil
	}

	snapshot, err := recorder.store.createSession(targetURL)
	if err != nil {
		return captureSession{}, err
	}
	recorder.session = snapshot.Session
	return recorder.session, nil
}

func (recorder *captureRecorder) updateTargetURL(targetURL string) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if recorder.store == nil || recorder.session.ID == "" {
		return nil
	}
	recorder.session.TargetURL = targetURL
	recorder.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return recorder.store.writeSession(recorder.session)
}

func (recorder *captureRecorder) recordEvent(event captureEvent, topics []topicState, eventCount int64, issueCount int64, retainedCount int) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if recorder.store == nil || recorder.session.ID == "" {
		return nil
	}
	recorder.session.EventCount = eventCount
	recorder.session.IssueCount = issueCount
	recorder.session.RetainedEventCount = retainedCount
	session, err := recorder.store.appendEvent(recorder.session.ID, event, topics, recorder.session)
	if err != nil {
		return err
	}
	recorder.session = session
	return nil
}

func (recorder *captureRecorder) recordTopicSnapshot(topics []topicState, issueCount int64, retainedCount int) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if recorder.store == nil || recorder.session.ID == "" {
		return nil
	}
	recorder.session.IssueCount = issueCount
	recorder.session.RetainedEventCount = retainedCount
	session, err := recorder.store.writeTopicSnapshot(recorder.session.ID, topics, recorder.session)
	if err != nil {
		return err
	}
	recorder.session = session
	return nil
}

func (recorder *captureRecorder) eventPage(offset int, limit int) (captureEventPage, error) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()

	if recorder.store == nil {
		return captureEventPage{}, errors.New("capture database is not configured")
	}
	return recorder.store.eventPage(recorder.session.ID, offset, limit)
}
