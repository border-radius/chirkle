// Media grid (§30): the grid in the room view, newest first, under month headings, a page at a time (GET
// /api/chat/media/{room}: tests/integration/media.test.ts).

import { describe, expect, it, vi } from "vitest";
import { intercept, seedMessages } from "../../../support/api.ts";
import { captureHandler, io, me, mount, newRoom, root, useRoomView } from "./harness.ts";

describe("room view: media grid (§30)", () => {
  useRoomView();

  const DAY = 86_400_000;
  const toggle = () => root.querySelector<HTMLButtonElement>("header.room-header button[aria-label='Media']")!;
  const grid = () => document.querySelector<HTMLDialogElement>("dialog.media");
  const tiles = () => [...grid()!.querySelectorAll<HTMLButtonElement>("button.media-tile")];
  const status = () => grid()!.querySelector(".media-status")!;
  const names = () => tiles().map((t) => t.getAttribute("aria-label")!.split(",")[0]);
  const open = async () => {
    toggle().click();
    await vi.waitFor(() => expect(grid()?.open).toBe(true));
    // A real observer reports the end of the (empty) grid as soon as it observes it; the fake one doesn't.
    expect(io.intersect(status())).toBe(true);
  };

  it("shows images and videos newest first under month headings, and fetches older ones at the end", async () => {
    const room = await newRoom();
    // 70 days from June 1, one message a day, each with an image but every 10th (a PDF); the newest has an image and a video.
    await seedMessages(room.id, me.user.id, 70, {
      startAt: Date.UTC(2026, 5, 1, 12),
      stepMs: DAY,
      files: (i) =>
        i === 69 ? ["a_abcdefghij.png", "b_abcdefghij.mp4"] : i % 10 === 9 ? ["notes_abcdefghij.pdf"] : [`p${i}_abcdefghij.png`],
    });
    // The server says p68 is a video whose poster is made; b.mp4 has none yet.
    intercept(me.api, "media", (media) => async (r, after, sig) => {
      const page = await media(r, after, sig);
      return { ...page, items: page.items.map((i) => (i.file.startsWith("p68_") ? { ...i, video: true, poster: true } : i)) };
    });
    await mount(room);
    await open();
    await vi.waitFor(() => expect(tiles()).toHaveLength(60)); // a page: 65 tiles in all (63 messages with an image, one with 2)
    // A message's files in their own order once reversed for the viewer: newest first, last to first.
    expect(names().slice(0, 3)).toEqual(["b.mp4", "a.png", "p68.png"]);
    // A video is never loaded in the grid: its poster, or a plain tile until there is one.
    expect(grid()!.querySelector("video")).toBeNull();
    expect(tiles()[0]!.querySelector("img")).toBeNull();
    expect(tiles()[0]!.querySelector("span.att-play")).not.toBeNull(); // a drawn triangle, not "▶" (QA BUG-242)
    expect(tiles()[2]!.querySelector("img")!.getAttribute("src")).toMatch(/\/api\/chat\/posters\/[a-z0-9]+\/p68_abcdefghij\.png$/);
    expect(tiles()[1]!.querySelector("img")!.getAttribute("src")).toMatch(/\/api\/files\/messages\/.*thumb=240x240/);
    expect(tiles()[0]!.getAttribute("aria-label")).toMatch(/^b\.mp4, video, Me, /);
    const months = () => [...grid()!.querySelectorAll("h3")].map((h) => h.textContent);
    expect(months()).toEqual(["August 2026", "July 2026", "June 2026"]);

    expect(io.intersect(status())).toBe(true);
    await vi.waitFor(() => expect(tiles()).toHaveLength(65));
    expect(names().at(-1)).toBe("p0.png");
    expect(months()).toEqual(["August 2026", "July 2026", "June 2026"]); // June goes on under its heading
    // All there: nothing more to fetch.
    expect(io.observing(status())).toBe(false);
    expect(status().textContent).toBe("");
  });

  it("drops the tiles of a message deleted while it is open (or a forward whose original was), and an emptied month (QA BUG-244)", async () => {
    const room = await newRoom();
    const handlers = captureHandler(me.api);
    const [keep, gone] = await seedMessages(room.id, me.user.id, 2, {
      startAt: Date.UTC(2026, 5, 30, 12),
      stepMs: 2 * DAY,
      files: (i) => (i ? ["b_abcdefghij.png", "c_abcdefghij.mp4"] : ["a_abcdefghij.png"]),
    });
    await mount(room);
    await open();
    await vi.waitFor(() => expect(names()).toEqual(["c.mp4", "b.png", "a.png"]));
    handlers[0]!("update", { ...gone!, deleted: true, files: [] });
    await vi.waitFor(() => expect(names()).toEqual(["a.png"]));
    expect([...grid()!.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["June 2026"]);
    // An edit keeps them; a forward whose original was deleted has no files left, and goes as a deleted one does.
    handlers[0]!("update", { ...keep!, text: "edited" });
    await new Promise((r) => setTimeout(r, 50));
    expect(names()).toEqual(["a.png"]);
    handlers[0]!("update", { ...keep!, files: [] });
    await vi.waitFor(() => expect(tiles()).toHaveLength(0));
    expect(status().textContent).toBe("No photos or videos here yet.");
  });

  it("says when there are none, and offers Retry when a page fails", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 3);
    let fail = true;
    intercept(me.api, "media", (media) => (r, after, sig) => (fail ? Promise.reject(new Error("offline")) : media(r, after, sig)));
    await mount(room);
    await open();
    await vi.waitFor(() => expect(status().textContent).toBe("Couldn't load media. Retry"));
    // Not observed until Retry: a real observer reports the end at once when observed again, which asked again,
    // ~60 times a second while it failed (QA BUG-116).
    expect(io.observing(status())).toBe(false);
    fail = false;
    status().querySelector("button")!.click();
    await vi.waitFor(() => expect(status().textContent).toBe("No photos or videos here yet."));
  });

  it("Escape closes it and focus goes back to the button; one grid at a time", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 1, { files: () => ["x_abcdefghij.png"] });
    await mount(room);
    toggle().focus();
    await open();
    toggle().click();
    await vi.waitFor(() => expect(tiles()).toHaveLength(1));
    expect(document.querySelectorAll("dialog.media")).toHaveLength(1);
    grid()!.dispatchEvent(new Event("close"));
    expect(grid()!.open).toBe(false);
    // Removed once Back has left its entry: the router passes over a grid entry with no grid (QA BUG-118).
    await vi.waitFor(() => expect(grid()).toBeNull());
    expect(document.activeElement).toBe(toggle());
  });
});
