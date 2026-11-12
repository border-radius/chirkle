package main

// Messages' and collection items' files, and video posters (DESIGN.md §37, §37.3): served from their shared `files`
// row, without a file token (the URL is the secret), for as long as the message or item shows the file. In Go
// (docs/REFACTOR.md item 61): a JS route held a JS runtime of the pool for the whole download, minutes for a large
// file to a slow phone (BUG-250's mechanism), and many at once overflowed the pool. pb_hooks/lib/files.js keeps the
// rest of the `files` rows' life (uploads, links, the worker's moves) and says where a file is (keyOf, posterKeyOf).

import (
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

// The images PocketBase makes thumbnails of, and the size it makes for any file field besides the field's own.
var thumbExt = []string{"jpg", "jpeg", "png", "gif", "webp"}

const defaultThumb = "100x100"

// posterName: a video's poster frame, beside its thumbnails (lib/media.js POSTER).
const posterName = "poster.jpg"

var videoExt = []string{"mp4", "m4v", "webm", "mov", "ogv"}

// extOf: a file name's extension, lowercased ("" without one).
func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return strings.ToLower(name[i+1:])
	}
	return ""
}

// fileKeyOf: where a `files` row's file is now: its old place until the worker has moved it (`src`), then its own
// folder (lib/files.js keyOf).
func fileKeyOf(row *core.Record) string {
	if src := row.GetString("src"); src != "" {
		return src
	}
	return row.BaseFilesPath() + "/" + row.GetString("file")
}

// thumbKeyOf: where a stored file's thumbnail `size`, or its poster, is (lib/files.js thumbKeyOf).
func thumbKeyOf(key, size string) string {
	slash := strings.LastIndex(key, "/")
	dir := key[:slash] + "/thumbs_" + key[slash+1:] + "/"
	if size == posterName {
		return dir + size
	}
	return dir + size + "_" + key[slash+1:]
}

// fileRowByName: the `files` row of a stored name, or nil.
func fileRowByName(app core.App, name string) *core.Record {
	if name == "" {
		return nil
	}
	row, err := app.FindFirstRecordByFilter("files", "file = {:name}", dbx.Params{"name": name})
	if err != nil {
		return nil
	}
	return row
}

// messageShows: does message msg (as stored) show stored name `name`, its own or as a forward its original's (§21.3)?
// Never once deleted.
func messageShows(app core.App, msg *core.Record, name string) bool {
	if msg.GetBool("deleted") {
		return false
	}
	if slices.Contains(msg.GetStringSlice("files"), name) {
		return true
	}
	id := msg.GetString("forward_of")
	if id == "" {
		return false
	}
	original, err := app.FindRecordById("messages", id)
	return err == nil && !original.GetBool("deleted") && slices.Contains(original.GetStringSlice("files"), name)
}

// shownBy: the `files` row that collection's record id shows as `name` (a message's attachment, a collection item's
// file), or nil when it doesn't show it (any more).
func shownBy(app core.App, collection, id, name string) *core.Record {
	rec, err := app.FindRecordById(collection, id)
	if err != nil {
		return nil
	}
	shows := rec.GetString("file") == name
	if collection == "messages" {
		shows = messageShows(app, rec, name)
	}
	if !shows {
		return nil
	}
	return fileRowByName(app, name)
}

// serveFile: GET /api/files/messages/{recordId}/{filename} and /api/files/collection_items/{recordId}/{filename}.
// More specific than PocketBase's /api/files/{collection}/…, and as its handler does: `thumb` (one of the field's
// sizes, or 100x100) serves that thumbnail of an image, made when first asked for; `download` makes it an attachment;
// ranges, and the headers that keep a file from running as a page (Serve). A `token` is ignored. 404 when the message
// or item doesn't show it. A file not moved to its row's folder yet is served from its old place (`src`), with a
// thumbnail only if one is there already: those folders have the ones that were ever asked for.
func serveFile(collection string) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		name := e.Request.PathValue("filename")
		row := shownBy(e.App, collection, e.Request.PathValue("recordId"), name)
		if row == nil {
			return e.NotFoundError("", nil)
		}
		moved := row.GetString("src") == ""
		key := fileKeyOf(row)
		file := row.GetString("file")
		q := e.Request.URL.Query()
		thumb := q.Get("thumb")
		var sizes []string
		if f, ok := row.Collection().Fields.GetByName("file").(*core.FileField); ok {
			sizes = f.Thumbs
		}
		fsys, err := e.App.NewFilesystem()
		if err != nil {
			return e.InternalServerError("", err)
		}
		defer fsys.Close()
		served := key
		if thumb != "" && (thumb == defaultThumb || slices.Contains(sizes, thumb)) && slices.Contains(thumbExt, extOf(file)) {
			at := thumbKeyOf(key, thumb)
			if ok, _ := fsys.Exists(at); ok {
				served = at
			} else if ok, _ := fsys.Exists(key); moved && ok {
				if fsys.CreateThumb(key, at, thumb) == nil {
					served = at
				} // else as PocketBase does: the file itself when it can't make one
			}
		}
		if served == key {
			if ok, _ := fsys.Exists(key); !ok {
				return e.NotFoundError("", nil)
			}
		}
		if d := q.Get("download"); d != "" && d != "0" && d != "false" {
			e.Response.Header().Set("Content-Disposition", "attachment; filename="+file)
		}
		if err := fsys.Serve(e.Response, e.Request, served, file); err != nil {
			return e.NotFoundError("", err)
		}
		return nil
	}
}

// servePoster: GET /api/chat/posters/{message}/{file} and /api/chat/posters/items/{item}/{file}: the poster frame of a
// video the message (or as a forward, its original) or collection item shows, for whoever has the video's URL. 404
// for anything else, and until the worker has made it.
func servePoster(collection, idParam string) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		file := e.Request.PathValue("file")
		if !slices.Contains(videoExt, extOf(file)) {
			return e.NotFoundError("", nil)
		}
		row := shownBy(e.App, collection, e.Request.PathValue(idParam), file)
		if row == nil {
			return e.NotFoundError("", nil)
		}
		fsys, err := e.App.NewFilesystem()
		if err != nil {
			return e.InternalServerError("", err)
		}
		defer fsys.Close()
		key := thumbKeyOf(fileKeyOf(row), posterName)
		if ok, _ := fsys.Exists(key); !ok {
			return e.NotFoundError("", nil)
		}
		// Never changes under one name: a new upload gets a new file name.
		e.Response.Header().Set("Cache-Control", "private, max-age=2592000")
		if err := fsys.Serve(e.Response, e.Request, key, posterName); err != nil {
			return e.NotFoundError("", err)
		}
		return nil
	}
}

// bindFiles: the `files` rows are served only through the routes above, never by PocketBase's own file route.
func bindFiles(app core.App) {
	app.OnFileDownloadRequest("files").Bind(&hook.Handler[*core.FileDownloadRequestEvent]{
		Func: func(e *core.FileDownloadRequestEvent) error { return e.NotFoundError("", nil) },
	})
}

// fileRoutes: path → handler, added by register (main.go).
var fileRoutes = map[string]func(*core.RequestEvent) error{
	"/api/files/messages/{recordId}/{filename}":         serveFile("messages"),
	"/api/files/collection_items/{recordId}/{filename}": serveFile("collection_items"),
	"/api/chat/posters/{message}/{file}":                servePoster("messages", "message"),
	"/api/chat/posters/items/{item}/{file}":             servePoster("collection_items", "item"),
}
