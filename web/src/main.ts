import { createApi } from "./api.ts";
import { startApp } from "./app.ts";
import { closeDialogsOnBackdrop } from "./dom.ts";
import { createAuthStore, createClient } from "./pb.ts";
import { startTheme } from "./theme.ts";

// The theme index.html's inline script set, and another tab's changes (§7.8).
startTheme();

// A click beside any modal dialog closes it, as Escape does.
closeDialogsOnBackdrop();

startApp({
  api: createApi(createClient(location.origin, createAuthStore(localStorage))),
  root: document.getElementById("app")!,
});

// The offline shell and installing the app (DESIGN.md §27).
void navigator.serviceWorker?.register("/sw.js");
