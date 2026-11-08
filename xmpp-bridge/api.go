package main

// What PocketBase asks of the child (DESIGN.md §38.3): HTTP on 127.0.0.1, each request with the secret.
//
//	POST /rooms {"rooms": [{"muc", "key", "password", "since"}]}  the conferences to be in, all of them
//	POST /send  {"muc", "id", "body", "reply", "replace", "retract"}  a message to a conference (sendOptions)
//
// A refusal is {"error", "transient"}: transient when it may work later (not connected, not in the conference yet).

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const secretHeader = "X-Chirkle-Bridge"

func (b *bridge) api(secret string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rooms", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Rooms []wantedRoom `json:"rooms"`
		}
		if !decode(w, r, &body) {
			return
		}
		if err := b.setRooms(body.Rooms); err != nil {
			refuse(w, err.Error(), false)
			return
		}
		reply(w, http.StatusOK, map[string]any{})
	})
	mux.HandleFunc("POST /send", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MUC  string `json:"muc"`
			ID   string `json:"id"`
			Body string `json:"body"`
			sendOptions
		}
		if !decode(w, r, &body) {
			return
		}
		if body.ID == "" || body.Body == "" {
			refuse(w, "id and body are required", false)
			return
		}
		if err := b.sendGroup(context.WithoutCancel(r.Context()), body.MUC, body.ID, body.Body, body.sendOptions); err != nil {
			var se *sendError
			refuse(w, err.Error(), errors.As(err, &se) && se.transient)
			return
		}
		reply(w, http.StatusOK, map[string]any{"id": body.ID})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(secretHeader)), []byte(secret)) != 1 {
			reply(w, http.StatusUnauthorized, map[string]any{"error": "wrong secret"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		refuse(w, "bad JSON: "+err.Error(), false)
		return false
	}
	return true
}

func refuse(w http.ResponseWriter, msg string, transient bool) {
	status := http.StatusBadRequest
	if transient {
		status = http.StatusServiceUnavailable
	}
	reply(w, status, map[string]any{"error": msg, "transient": transient})
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
