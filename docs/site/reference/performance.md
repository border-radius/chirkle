---
title: Performance
description: How many people Chirkle holds on a $5 VPS with one CPU and 1 GB of RAM, how it was measured, how it behaves under overload, and how to test your own.
section: Reference
order: 2
---

Chirkle is built to run a busy community on the smallest server you can rent. This page sums up what's been measured.
The full log, with every run and what changed between them, is
[`docs/PERF.md`](https://github.com/border-radius/chirkle/blob/master/docs/PERF.md).

## On a $5 VPS

On one CPU and 1 GB of RAM, the size of a $5 VPS:

| People online | How they chat | Sending a message (typical / slowest 5%) | Memory |
|---|---|---|---|
| 1,000 | At a normal pace: an action a minute each | about 60 ms / 260 ms | 0.4 GB |
| 2,000 | At a normal pace | sends slow down, to about 1–2 s | 0.8 GB |
| 300 | Nonstop: an action every 5 seconds each | about 40 ms / 180 ms | 0.5 GB |
| 400 | Nonstop | about 0.6 s / 1.6 s | 0.65 GB |

An *action* is what the app does: opening a room, sending a message (some with a photo, some replies), reacting,
marking a room read, scrolling back, listing rooms.

**1,000 people reconnecting at once**, as after a restart or a network blip, catch up within seconds.

## Under overload

Past what one CPU can do, Chirkle slows down rather than falling over. Requests beyond what the server can usefully run
together wait their turn in a queue that costs almost nothing, instead of each taking memory. With 3,000 people chatting
at a normal pace on one CPU, more than it can serve quickly, sends take over a minute, but the server stays within its
memory, no request fails and every live message is delivered.

## How it was measured

On a development machine, with the server pinned to one CPU and its memory held to 700 MB, and simulated users running
on other CPUs. Each simulated user keeps a live connection, as the web app does, and acts after a random pause.
Uploaded files were served from S3, as on a hosted server, and thumbnails served from a cache, as Cloudflare or the
browser would. Numbers vary by about 10% between runs.

## What makes it light

- **One process, one SQLite file.** No database server, no queue, no cache server.
- **The busiest work in Go:** room lists, message pages, live messages and unread counts run as compiled code inside
  the server, not as scripts.
- **Answers made once:** a page of messages is serialized once, and tagged so a client that has it already gets a
  short "not changed" answer.
- **Compressed answers:** the web app's scripts and stylesheets are compressed once when it is built (brotli and
  gzip), and pages of messages and other JSON are gzipped as they are sent, with no proxy needed.
- **Background workers** make thumbnails, previews and exports, so a request never waits on them.

## The clients

- **The web app** loads about 50 KB of JavaScript and 11 KB of CSS, gzipped. The build fails if the first load grows
  past 62.5 KB, or any screen loaded later (the image viewer, search, collections, the emoji picker and others) past
  16 KB.
- **Switching rooms is instant:** each room's latest messages are kept in the browser and shown at once while the
  server answers, and rooms with unread messages are fetched ahead.
- **The Android app** is a 3 MB download, with its own performance budget checked on every build.

## Measure your own

From a clone of the [repository](https://github.com/border-radius/chirkle), with the server built (`npm run setup`):

```sh
# a throwaway server, timing one thing at a time
node --no-warnings scripts/bench.ts

# a crowd: 500 users arriving over 60 s, on one pinned CPU with 700 MB
taskset -c 0-5 node --no-warnings scripts/stress.ts --users=500 --think=60000 --arrive=60 \
  --cpu=7 --memlimit=700MiB --files=off
```

`scripts/stress.ts` needs `versitygw` for its S3 stand-in; `npm run doctor` checks what's missing. Its comments list
every option.
