# §12. Milestones

Part of the design document: [index](../DESIGN.md).

| # | Deliverable | Done when |
|---|---|---|
| M1 | Skeleton: repo layout, fetch script, esbuild build and dev scripts, empty app served by PB | `npm run dev` serves "hello" and `npm run build` passes the budget |
| M2 | Schema, rules and hooks, plus the integration test suite | all §9.2 tests green |
| M3 | Auth screens, router, store, DOM helpers, with unit tests | log in and out works and unit tests are green |
| M4 | Rooms list: create, hide/unhide, archive/unarchive, realtime room list | §9.1 rooms tests green |
| M5 | Room view: windowed history to the beginning, realtime, optimistic send, edit, soft delete with placeholder, archived read-only mode | §9.1 room tests green |
| M6 | Polish: styles, dark mode, mobile, accessibility, CSP and cache headers | axe clean |
| M7 | E2E suite, CI pipeline, deploy notes | CI green on main |
