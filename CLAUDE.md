# Instructions for Claude

## The Android app (`android/`)

The app was frozen from 2026-10-21 and unfrozen on 2026-10-23. It is in active development again: web features and
fixes that the app lacks should be ported, and server/API changes should keep the app working (update
`docs/ANDROID.md` and `android/PARITY.md` with the work).

## The console client (`cli/`)

A third client of the API (docs/CLI.md): server/API changes must keep it working too (its tests run against a real
server in CI's `cli` job). Its copy of the contract lives in `cli/internal/contract`; update it with the other two.
A change to `web/src/lib/emoji-names.ts` needs `go generate ./internal/emoji` in `cli/` (its test fails until then).
