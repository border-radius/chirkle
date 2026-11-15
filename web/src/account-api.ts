// Your data and deleting your account (DESIGN.md §43): the part of the API (api.ts) only Settings uses, split out so it
// loads with that page (a lazy chunk, `Api.account()`), not on the app's critical path (§7.7).

import type { PbClient } from "./pb.ts";

/** Where your newest export is (§43.2, GET /api/chat/export). */
export interface ExportStatus {
  id: string;
  state: "none" | "queued" | "done" | "failed";
  created: string;
  finished: string;
  /** Until when it can be downloaded ("done" only). */
  expires: string;
  /** Its size in bytes ("done" only). */
  size: number;
}

export interface AccountApi {
  /** Where your newest export is (§43.2): none, being made, made (to download until `expires`), or failed. */
  exportStatus(signal?: AbortSignal): Promise<ExportStatus>;
  /** Ask for your data as a file (§43.2): the server makes it in the background. Asked again soon, the same one. */
  startExport(): Promise<ExportStatus>;
  /**
   * A link that downloads your made export (with a fresh file token: a plain link sends no session). Relative: the app
   * is served by its server (main.ts uses location.origin).
   */
  exportFileUrl(): Promise<string>;
  /**
   * Delete your account (§43.3), checked by your password: your messages stay under "Deleted account" ("keep") or are
   * deleted too ("delete"). Every session ends, this one included (log out after). Rejects with field errors on
   * `password` or `messages`.
   */
  deleteAccount(password: string, messages: "keep" | "delete"): Promise<void>;
}

/** Built by api.ts with its client (which tells onRejected listeners) and its error wrapping. */
export function createAccountApi(pb: PbClient, wrap: <T>(p: Promise<T>) => Promise<T>): AccountApi {
  return {
    exportStatus: (signal) => wrap(pb.send<ExportStatus>("/api/chat/export", { signal })),
    startExport: () => wrap(pb.send<ExportStatus>("/api/chat/export", { method: "POST" })),
    async exportFileUrl() {
      const { token } = await wrap(pb.send<{ token: string }>("/api/files/token", { method: "POST" }));
      return `/api/chat/export/file?token=${encodeURIComponent(token)}`;
    },
    async deleteAccount(password, messages) {
      await wrap(pb.send("/api/chat/account/delete", { method: "POST", body: { password, messages } }));
    },
  };
}
