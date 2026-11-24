// A new collection (§31), from the sidebar's inline form (views/rooms.ts): made, and the list asked for again.

import { calls } from "./calls.ts";
import type { Base } from "./shared.ts";

/** Makes a collection of yours; resolves to its id. */
export async function createCollection(o: Pick<Base, "api" | "service" | "me">, name: string, isPublic: boolean): Promise<string> {
  const { id } = await calls(o.api).create(o.me()?.id ?? "", name, isPublic);
  o.service.refresh();
  return id;
}
