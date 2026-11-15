# §25. Measured scale

Part of the design document: [index](../DESIGN.md).

`tests/perf/scale.ts` seeds a throwaway server and times, through the app's own client, the requests whose cost grows
with the data (`node --experimental-eventsource --no-warnings tests/perf/scale.ts`; sizes from `ROOMS`, `USERS`,
`MESSAGES`, `LISTENERS`). Measured 2026-10-13 on the dev machine (AMD Custom APU 0405: a Steam Deck, 4 cores /
8 threads), 100,000 messages, every room with ≥ 100 unread for the caller (the worst case for §18.2: each count stops
at 100):

| Request | 200 rooms, 50 listeners | 1,000 rooms, 200 listeners |
|---|---|---|
| `GET /api/chat/unread` (§18.2) | 52 ms | 237 ms |
| List rooms | 19 ms | 80 ms |
| Latest page of a room (50 messages) | 10 ms | 10 ms |
| Send a message | 5 ms | 5 ms |
| Send, until every listener has the event (§18.3) | 34 ms | 82 ms |

- **Linear in what grows:** unread counts ≈ 0.24 ms per visible room (worst case), the room list ≈ 0.08 ms per room,
  a message's fan-out ≈ 0.4 ms per connected listener (every open signed-in tab listens to every room it can see).
  Pages and sends don't depend on the size.
- **First to matter:** the unread counts, fetched on load, on every reconnect and after reads elsewhere (debounced).
  Around 4,000 visible rooms one fetch would have taken about a second of server time (done, below). Next, the
  fan-out: at hundreds of open tabs, each message costs tens of ms of server time (done since, below).

Measured again 2026-11-13 (REFACTOR item 26), the Go server (§9 of PERF.md), 1,000 rooms, 200 users and listeners,
100,000 messages, same machine:

| Request | before | after |
|---|---|---|
| `GET /api/chat/unread` | 280 ms | 56 ms |
| List rooms | 51 ms | 54 ms |
| Latest page of a room | 8 ms | 8 ms |
| Send a message | 9 ms | 10 ms |
| Send, until all 200 listeners have the event | 29 ms | 26 ms |

- **Unread counts:** each room's count is now made once (SQLite made it twice, for `n > 0` and for the value) and
  reads only the partial index `idx_messages_unread` (room, created, author; not deleted), never the messages:
  ≈ 0.05 ms per visible room in the worst case, so ~4,000 rooms ≈ 0.2 s. Per-user stored counts weren't needed.
- **Fan-out:** since PERF.md §7 and item 47 a message is serialized once per way of seeing it, not once per listener;
  what is left per listener is the room check and a non-blocking queue (`server/realtime.go`). The 26 ms is mostly
  the test's own 200 Node clients. Live messages' second queue and goroutine per client are gone (`server/live.go`).
