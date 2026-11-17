---
title: Development
description: Work on Chirkle itself. Set up a development environment, run the dev server and the tests, find your way around the code, and release a new version.
section: Reference
order: 6
---

This page is for people changing Chirkle itself. Contributions are welcome:
[open an issue](https://github.com/border-radius/chirkle/issues) to talk about a change first.

## Set up

You need Node.js 22+ and npm 11+, Go 1.27+ (to build the server), and Linux or macOS.

```sh
git clone https://github.com/border-radius/chirkle && cd chirkle
npm ci
npm run setup      # builds the server into bin/chirkle-server
npm run dev        # rebuilds the web app as you edit, and runs the server on http://127.0.0.1:8090
```

Open <http://127.0.0.1:8090> and sign up. The development database is in `pb_data/`: delete it to start over. The admin
UI is at <http://127.0.0.1:8090/_/>; create an admin account with
`bin/chirkle-server superuser upsert you@example.com <password> --dir=pb_data`.

`npm run doctor` checks that the machine is ready for the tests.

## Scripts

| Script | What it does |
|---|---|
| `npm start` | A production build, then the server. |
| `npm run dev` | The dev server: an unminified build that rebuilds on every change. |
| `npm run build` | A production build into `pb_public/`. Fails if it grows past the size budget. |
| `npm run typecheck` | TypeScript, strict, for the web app, the tests, the scripts and the server's hooks. |
| `npm run lint` | Biome: formatting, lint rules, import order. `npm run format` fixes what it can. |
| `npm test` | Unit tests (no server) and component tests (against a real, throwaway server). |
| `npm run test:int` | Integration tests: the schema, access rules, hooks, live updates. |
| `npm run test:e2e` | End-to-end tests in real browsers. Needs `npx playwright install chromium`. |
| `npm run check` | Everything the CI runs before the end-to-end tests. |

Every test run starts its own server on a free port with its own data, so there's nothing to clean up and nothing is
faked but Telegram.

## Find your way around

```
pb_migrations/   the schema and access rules: the source of truth for who can do what
pb_hooks/        the server's logic in JavaScript (Telegram bridge and linked servers in their own folders)
server/          the server binary: PocketBase plus the busiest paths in Go
web/src/         the web app: api.ts talks to the server, views/ draws the screens, lib/ holds the pure logic
web/styles/      the CSS, one file per part
shared/          what the server and both apps must agree on: field lists, limits, test cases
android/         the Android app (Kotlin, Jetpack Compose)
tests/           unit/, integration/, e2e/, perf/
docs/            the design notes, the performance log and these pages (docs/site/)
```

How each feature works, and why, is in the design notes,
[`docs/DESIGN.md`](https://github.com/border-radius/chirkle/blob/master/docs/DESIGN.md).

## The Android app

It needs JDK 17+ (21 recommended) and the Android SDK. Its tests start the server from `bin/`, so run `npm run setup`
first.

```sh
cd android
./gradlew assembleDebug   # a debug build that offers the dev server (http://10.0.2.2:8090 from the emulator)
./gradlew check           # lint, unit tests, API tests against a real server, UI tests
```

`-Pchirkle.devServer=http://192.168.1.20:8090` makes a debug build for a phone on your network. Web features and fixes
are brought over to the app: [`android/PARITY.md`](https://github.com/border-radius/chirkle/blob/master/android/PARITY.md)
tracks what the app has.

## Changing the API

The Android app updates on its users' schedule, so the server must keep working with apps already installed. Read
[Client API → Stability](api.md#stability) before renaming or removing anything a client uses.

## Releasing

The npm package and the Android app share one version.

1. `npm run release -- 0.5.0` sets it in `package.json` and the Android app (its version code goes up by one), and
   creates the app's changelog file to fill in.
2. Commit and push, then publish a GitHub Release with the tag `v0.5.0`.
3. The release workflow checks the versions, attaches the signed APK to the release, and stages `chirkle@0.5.0` on npm.
   Approve it on npmjs.com to publish it.

## Documentation

These pages are Markdown files in `docs/site/`. When a change affects what people see or set up, change its page in
the same commit. [`docs/site/README.md`](https://github.com/border-radius/chirkle/blob/master/docs/site/README.md) says
how the files become pages.
