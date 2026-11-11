# Production image: the built frontend + the Chirkle server (server/: PocketBase with the hot paths in Go), and ffmpeg.
# Used by Dokku (README "Deploying").

# ---- frontend: web/ → pb_public/ ----
FROM node:22-alpine AS web
# npm 10 (bundled with Node 22) crashes resolving this lockfile; package.json asks for npm ≥ 11.
RUN npm install -g npm@11
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts scripts
COPY web web
RUN npm run build

# ---- server: server/ → chirkle-server (pure Go, no CGO) ----
FROM golang:1.27-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /chirkle-server .

# ---- runtime ----
FROM alpine:3.22
# ffmpeg: the media worker makes each video's poster frame for the room and the media grid (DESIGN.md §30.1). Without it (or with
# -e FFMPEG=off) the room loads videos to draw their first frame, as before. busybox's `timeout` stops a run that hangs.
# curl: the link previews worker fetches pages with it (DESIGN.md §28.1), connecting only to addresses it has checked.
RUN apk add --no-cache ca-certificates tzdata ffmpeg curl \
  && adduser -D -H -u 32767 chirkle \
  && mkdir /pb_data && chown chirkle /pb_data
WORKDIR /app
COPY --from=server /chirkle-server ./chirkle-server
# The name it had before the server was built from server/ (`dokku run chirkle /app/pocketbase superuser …`).
RUN ln -s chirkle-server /app/pocketbase
COPY --from=web /src/pb_public ./pb_public
COPY pb_migrations ./pb_migrations
COPY pb_hooks ./pb_hooks
# Dokku reads the health check from the image's WORKDIR when it deploys a prebuilt image (`git:from-image`).
COPY app.json ./
USER chirkle
# Rate limits are per client IP, and Dokku's proxy is always in front: trust the address it adds to X-Forwarded-For.
# Use -e TRUSTED_PROXY=off when clients reach the container directly (README "Deploying").
ENV TRUSTED_PROXY=X-Forwarded-For
# All data (SQLite + uploaded files) lives here: mount persistent storage on it.
VOLUME /pb_data
EXPOSE 8090
# For plain Docker / Compose (Dokku runs its own check from app.json). busybox wget is in the base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1
# --hooksPool: JS hook runtimes kept warm. Beyond the pool (default 15) every call builds a fresh one. The messages enrich
# hook is Go's now (server/enrich.go), but the records API's request hooks and the other routes still run in these.
CMD ["/app/chirkle-server", "serve", "--http=0.0.0.0:8090", "--hooksPool=100", "--dir=/pb_data", "--publicDir=/app/pb_public", "--migrationsDir=/app/pb_migrations", "--hooksDir=/app/pb_hooks"]
