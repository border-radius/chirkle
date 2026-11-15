# §1. Summary

Part of the design document: [index](../DESIGN.md).

Chirkle (called Chat until 2026-10-27) is a small, fast, real-time group chat web app. Users sign up, see a list of public rooms, join one, and talk. New messages show up live without a page reload.

The whole system is **one PocketBase binary**. It handles auth, data, realtime and serving the static frontend. The frontend is **vanilla TypeScript** with no UI framework, bundled by **esbuild** into one small JS file and one CSS file.
