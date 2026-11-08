# Production image: the built frontend + the pinned PocketBase and ffmpeg, and with --build-arg XMPP=on the XMPP
# bridge's child. Used by Dokku (README "Deploying").

# The XMPP bridge (README "XMPP integration") is built only when asked: an image without it never pulls Go or builds it.
ARG XMPP=off

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

# ---- pocketbase: the pinned, checksum-verified binary ----
FROM alpine:3.22 AS pocketbase
RUN apk add --no-cache curl
WORKDIR /src
COPY scripts/fetch-pocketbase.sh scripts/
RUN sh scripts/fetch-pocketbase.sh

# ---- the XMPP bridge's child (DESIGN.md §38.9): one static binary, built from xmpp-bridge/ at this commit ----
FROM golang:1.27.3-alpine AS xmpp-on
WORKDIR /src/xmpp-bridge
COPY xmpp-bridge/go.mod xmpp-bridge/go.sum ./
RUN go mod download
COPY xmpp-bridge ./
COPY package.json /src/
RUN v=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' /src/package.json) \
  && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$v" -o /out/xmpp-bridge . \
  && /out/xmpp-bridge --version

# Without it: nothing (BuildKit builds only the stages the image uses, so xmpp-on is skipped).
FROM alpine:3.22 AS xmpp-off
RUN mkdir /out

FROM xmpp-${XMPP} AS xmpp

# ---- runtime ----
FROM alpine:3.22
# ffmpeg: the media worker makes each video's poster frame for the room and the media grid (DESIGN.md §30.1). Without it (or with
# -e FFMPEG=off) the room loads videos to draw their first frame, as before. busybox's `timeout` stops a run that hangs.
# curl: the link previews worker fetches pages with it (DESIGN.md §28.1), connecting only to addresses it has checked.
RUN apk add --no-cache ca-certificates tzdata ffmpeg curl \
  && adduser -D -H -u 32767 chirkle \
  && mkdir /pb_data && chown chirkle /pb_data
WORKDIR /app
COPY --from=pocketbase /src/bin/pocketbase ./pocketbase
COPY --from=web /src/pb_public ./pb_public
COPY pb_migrations ./pb_migrations
COPY pb_hooks ./pb_hooks
COPY --from=xmpp /out/ ./xmpp/
USER chirkle
# With the child built, the XMPP bridge is on once XMPP_JID and XMPP_PASSWORD are set (README "XMPP integration").
ENV CHIRKLE_XMPP_BIN=/app/xmpp/xmpp-bridge
# Rate limits are per client IP, and Dokku's proxy is always in front: trust the address it adds to X-Forwarded-For.
# Use -e TRUSTED_PROXY=off when clients reach the container directly (README "Deploying").
ENV TRUSTED_PROXY=X-Forwarded-For
# All data (SQLite + uploaded files) lives here: mount persistent storage on it.
VOLUME /pb_data
EXPOSE 8090
# For plain Docker / Compose (Dokku runs its own check from app.json). busybox wget is in the base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1
# --hooksPool: PocketBase enriches a page of records in parallel, one JS hook call each (onRecordEnrich on messages).
# Beyond the pool (default 15) every call builds a fresh JS runtime: a 50-message page took ~70 ms instead of ~20 ms.
CMD ["/app/pocketbase", "serve", "--http=0.0.0.0:8090", "--hooksPool=100", "--dir=/pb_data", "--publicDir=/app/pb_public", "--migrationsDir=/app/pb_migrations", "--hooksDir=/app/pb_hooks"]
