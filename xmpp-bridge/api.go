package main

// What PocketBase asks of the child (DESIGN.md §38.3): HTTP on 127.0.0.1, each request with the secret.
//
//	POST /rooms {"rooms": [{"muc", "key", "password", "since"}]}  the conferences to be in, all of them
//	POST /send  {"muc", "id", "body", "reply", "replace", "retract", "oob"}  a message to a conference (sendOptions)
//	POST /upload {"path", "name", "type"}  → {"url"}  a file PocketBase serves at path, put on the bot's server
//	POST /moderate {"muc", "id", "reason"}  a message (its stanza id) retracted by the bot as a moderator (XEP-0425)
//	POST /avatar {"muc", "nick"}  → {"token", "type"} (or {} for none)  an occupant's vCard photo, fetched
//	GET  /photo/{token}  that photo, once, within 2 minutes: the token is its secret (no header: PocketBase reads it
//	                     as a file from a URL)
//
// A refusal is {"error", "transient"}: transient when it may work later (not connected, not in the conference yet).
// An upload refused for good may say why in "code": "unsupported" (no upload service) or "too_large".

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
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
		if body.ID == "" || body.Body == "" && body.React == nil {
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
	mux.HandleFunc("POST /upload", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
			Name string `json:"name"`
			Type string `json:"type"`
		}
		if !decode(w, r, &body) {
			return
		}
		if body.Path == "" || body.Name == "" {
			refuse(w, "path and name are required", false)
			return
		}
		u, err := b.upload(context.WithoutCancel(r.Context()), body.Path, body.Name, body.Type)
		if err != nil {
			var ue *uploadError
			if errors.As(err, &ue) {
				refuseWith(w, ue.msg, ue.transient, ue.code)
			} else {
				refuse(w, err.Error(), true)
			}
			return
		}
		reply(w, http.StatusOK, map[string]any{"url": u})
	})
	mux.HandleFunc("POST /moderate", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MUC    string `json:"muc"`
			ID     string `json:"id"`
			Reason string `json:"reason"`
		}
		if !decode(w, r, &body) {
			return
		}
		if body.ID == "" {
			refuse(w, "id is required", false)
			return
		}
		if err := b.moderate(context.WithoutCancel(r.Context()), body.MUC, body.ID, body.Reason); err != nil {
			var se *sendError
			refuse(w, err.Error(), errors.As(err, &se) && se.transient)
			return
		}
		reply(w, http.StatusOK, map[string]any{})
	})
	mux.HandleFunc("POST /avatar", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MUC  string `json:"muc"`
			Nick string `json:"nick"`
		}
		if !decode(w, r, &body) {
			return
		}
		token, typ, err := b.avatar(context.WithoutCancel(r.Context()), body.MUC, body.Nick)
		if err != nil {
			var se *sendError
			refuse(w, err.Error(), errors.As(err, &se) && se.transient)
			return
		}
		if token == "" {
			reply(w, http.StatusOK, map[string]any{})
			return
		}
		reply(w, http.StatusOK, map[string]any{"token": token, "type": typ})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token, ok := strings.CutPrefix(r.URL.Path, "/photo/"); ok && r.Method == http.MethodGet {
			ph, found := b.photos.take(token)
			if !found {
				http.NotFound(w, r)
				return
			}
			if ph.typ != "" {
				w.Header().Set("Content-Type", ph.typ)
			}
			w.Write(ph.data)
			return
		}
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

func refuse(w http.ResponseWriter, msg string, transient bool) { refuseWith(w, msg, transient, "") }

func refuseWith(w http.ResponseWriter, msg string, transient bool, code string) {
	status := http.StatusBadRequest
	if transient {
		status = http.StatusServiceUnavailable
	}
	body := map[string]any{"error": msg, "transient": transient}
	if code != "" {
		body["code"] = code
	}
	reply(w, status, body)
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
