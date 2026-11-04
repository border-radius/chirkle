// What PocketBase's JSVM has besides types/pocketbase.d.ts (which is generated).

/** goja's console: prints to the process's output (`dokku logs`), not to the admin UI's Logs. */
declare const console: { log(...args: unknown[]): void };
