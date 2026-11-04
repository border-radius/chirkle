// Room view: attachments (§17.4, §17.5).

import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { instrument, intercept, signedUp } from "../../../support/api.ts";
import { pngFile } from "../../../support/files.ts";
import { button, composer, key, me, mount, msgEl, msgEls, newRoom, root, setView, useRoomView, view } from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("attachments (§17.4, §17.5)", () => {
    const pdf = (name = "doc.pdf") => new File(["%PDF"], name, { type: "application/pdf" });
    const tiles = (id: string) => [...msgEl(id)!.querySelectorAll<HTMLElement>(".att-tile")];
    const chips = (id: string) => [...msgEl(id)!.querySelectorAll<HTMLAnchorElement>("a.att-file")];
    let revoked: string[];

    beforeEach(() => {
      let n = 0;
      revoked = [];
      vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:local-${++n}`);
      vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    });

    function paste(files: File[]) {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", { value: { files } });
      composer()!.dispatchEvent(e);
    }

    it("a pending message shows local previews; the server version replaces them and the previews are released", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("send");
      paste([pngFile("a.png"), pdf()]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(2));
      key(composer()!, "Enter");
      const pending = msgEls().at(-1)!;
      expect(pending.classList.contains("pending")).toBe(true);
      const preview = pending.querySelector<HTMLImageElement>(".att-tile img")!;
      expect(preview.getAttribute("src")).toBe("blob:local-1");
      expect(pending.querySelector(".att-file")!.textContent).toBe("doc.pdf");
      Object.defineProperties(preview, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
      preview.dispatchEvent(new Event("load"));
      release();
      const id = pending.dataset.id!;
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      const img = msgEl(id)!.querySelector<HTMLImageElement>(".att-tile img")!;
      expect(img.getAttribute("src")).toMatch(/thumb=800x480f/);
      expect(img.getAttribute("src")).not.toMatch(/token=/); // the URL alone opens it (§37.3)
      // Takes the preview's shape before it loads, so the tile doesn't narrow and widen again.
      expect(img.style.aspectRatio).toBe("600 / 300");
      expect(chips(id).map((a) => a.textContent)).toEqual(["doc.pdf"]);
      // The realtime echo can replace the pending copy before the send itself answers, which releases the previews.
      await vi.waitFor(() => expect(revoked).toEqual(["blob:local-1"]));
    });

    it("an image the server shows as a file is a file while sending too", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("send");
      paste([new File(["BM"], "scan.bmp", { type: "image/bmp" }), pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(2));
      key(composer()!, "Enter");
      const pending = msgEls().at(-1)!;
      expect(pending.querySelector(".att-images")!.classList.contains("one")).toBe(true);
      expect(pending.querySelector(".att-file")!.textContent).toBe("scan.bmp");
      release();
      const id = pending.dataset.id!;
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      expect(tiles(id)).toHaveLength(1);
      expect(chips(id).map((a) => a.textContent)).toEqual(["scan.bmp"]);
    });

    it("a failed send keeps its files; Retry sends the same id with the same files", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("offline", 0));
      // Outside the failure injection, so the failed attempt is recorded too.
      const calls: { id: string; files?: File[] }[] = [];
      intercept(me.api, "send", (original) => (m) => {
        calls.push({ id: m.id, ...(m.files ? { files: m.files } : {}) });
        return original(m);
      });
      await mount(room);
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      await vi.waitFor(() => expect(root.querySelector("li.msg.failed")).not.toBeNull());
      const id = root.querySelector<HTMLElement>("li.msg.failed")!.dataset.id!;
      expect(tiles(id)).toHaveLength(1);
      button(msgEl(id), "Retry")!.click();
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("failed")).toBe(false));
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      expect(calls.map((c) => c.id)).toEqual([id, id]);
      expect(calls[1]!.files![0]).toBe(calls[0]!.files![0]);
      expect((await me.api.getMessage(id)).files).toHaveLength(1);
    });

    it("discarding a failed send with files releases its previews", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("offline", 0));
      await mount(room);
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      await vi.waitFor(() => expect(root.querySelector("li.msg.failed")).not.toBeNull());
      button(root.querySelector("li.msg.failed"), "Discard")!.click();
      expect(revoked).toEqual(["blob:local-1"]);
    });

    it("unmount releases the previews of messages still sending", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      ctl.hold("send");
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      view!.unmount();
      setView(undefined);
      expect(revoked).toEqual(["blob:local-1"]);
    });

    it("one image is a large tile; several are a row of small ones; other files are download chips", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const one = await other.api.send({ id: newId(), room: room.id, text: "one", files: [pngFile("solo.png")] });
      const many = await other.api.send({
        id: newId(),
        room: room.id,
        text: "",
        files: [pngFile("a.png"), pngFile("b.png"), pngFile("c.png"), pdf("report.pdf")],
      });
      await mount(room);
      const [solo] = tiles(one.id);
      expect(solo!.closest(".att-images")!.classList.contains("one")).toBe(true);
      const big = solo!.querySelector("img")!;
      // Uncropped thumbs of any aspect ratio: CSS fixes the height, the image's own ratio sets the width.
      expect([big.hasAttribute("width"), big.hasAttribute("height"), big.getAttribute("loading")]).toEqual([false, false, "lazy"]);
      // The server says its shape, so the tile has its width before the image loads.
      expect(big.style.aspectRatio).toBe("1 / 1");
      expect(big.getAttribute("src")).toMatch(/thumb=800x480f/);
      expect(big.getAttribute("alt")).toBe("solo.png");
      expect(solo!.getAttribute("target")).toBe("_blank");

      const grid = tiles(many.id);
      expect(grid).toHaveLength(3);
      expect(grid[0]!.closest(".att-images")!.classList.contains("row")).toBe(true);
      expect(grid.map((t) => t.querySelector("img")!.getAttribute("src"))).toEqual(Array(3).fill(expect.stringMatching(/thumb=480x240f/)));
      const [chip] = chips(many.id);
      expect(chip!.textContent).toBe("report.pdf");
      expect(chip!.getAttribute("download")).toBe("report.pdf");
      expect(chip!.getAttribute("href")).toBe(`${inject("pbUrl")}/api/files/messages/${many.id}/${many.files!.at(-1)}`);
    });

    it("more than 4 images and videos: 4 tiles, the 4th saying how many more", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const files = Array.from({ length: 7 }, (_, i) => pngFile(`p${i}.png`));
      const m = await other.api.send({ id: newId(), room: room.id, text: "", files: [...files, pdf("notes.pdf")] });
      await mount(room);
      const shown = tiles(m.id);
      expect(shown).toHaveLength(4);
      expect(shown.map((t) => t.querySelector(".att-more")?.textContent ?? "")).toEqual(["", "", "", "+3 more"]);
      expect(chips(m.id).map((a) => a.textContent)).toEqual(["notes.pdf"]);
    });

    it("a video's tile is its poster (§30.1); without one, the video's own first frame", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mp4 = (name: string) => new File([new Uint8Array(8)], name, { type: "video/mp4" });
      const m = await other.api.send({ id: newId(), room: room.id, text: "", files: [mp4("a.mp4"), mp4("b.mp4")] });
      await mount(room);
      const [a, b] = tiles(m.id);
      const poster = (t: HTMLElement) => t.querySelector("img")!;
      [a!, b!].forEach((t, i) => {
        expect(t.querySelector("video")).toBeNull();
        expect(poster(t).getAttribute("src")).toBe(`${inject("pbUrl")}/api/chat/posters/${m.id}/${m.files![i]}`);
        expect(poster(t).loading).toBe("lazy");
        expect(t.getAttribute("aria-label")).toMatch(/^[ab]\.mp4, video$/);
      });
      // a has a poster; b hasn't (not made yet): its tile falls back to the video, at once.
      poster(a!).style.aspectRatio = "4 / 3";
      poster(b!).style.aspectRatio = "4 / 3";
      poster(b!).dispatchEvent(new Event("error"));
      const video = b!.querySelector("video")!;
      expect(b!.querySelector("img")).toBeNull();
      expect(video.getAttribute("src")).toBe(`${inject("pbUrl")}/api/files/messages/${m.id}/${m.files![1]}#t=0.001`);
      expect(video.getAttribute("src")).toMatch(/#t=0\.001$/);
      expect(video.style.aspectRatio).toBe("4 / 3");
      expect(a!.querySelector("img")).not.toBeNull();
      // The video failing too offers Retry.
      video.dispatchEvent(new Event("error"));
      expect(msgEl(m.id)!.querySelector(".att-broken")!.textContent).toContain("Couldn't load video");
    });

    it("a sending message shows how much of its attachments has been uploaded", async () => {
      const room = await newRoom();
      let report: ((fraction: number) => void) | undefined;
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      intercept(me.api, "send", (original) => async (m, onUpload) => {
        report = onUpload;
        await done;
        return original(m, onUpload);
      });
      await mount(room);
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      const id = msgEls().at(-1)!.dataset.id!;
      const bar = () => msgEl(id)!.querySelector<HTMLProgressElement>("progress.att-progress");
      await vi.waitFor(() => expect(report).toBeDefined());
      expect(bar()!.value).toBe(0);
      report!(0.4);
      expect(bar()!.value).toBeCloseTo(0.4);
      finish();
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      expect(bar()).toBeNull();
    });

    it("BUG-28: files show, download and describe themselves under their original names", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({
        id: newId(),
        room: room.id,
        text: "",
        files: [pngFile("Beach Day!.png"), pdf("Quarterly Report (final).pdf")],
      });
      await mount(room);
      expect(tiles(m.id)[0]!.querySelector("img")!.getAttribute("alt")).toBe("Beach Day!.png");
      const [chip] = chips(m.id);
      expect(chip!.textContent).toBe("Quarterly Report (final).pdf");
      expect(chip!.getAttribute("download")).toBe("Quarterly Report (final).pdf");
    });

    it("a deleted message shows no attachments; editing keeps them visible", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "pic", files: [pngFile()] });
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(tiles(m.id)).toHaveLength(1);
      key(root.querySelector("textarea.edit-input")!, "Escape");
      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      await vi.waitFor(() => expect(msgEl(m.id)!.classList.contains("deleted")).toBe(true));
      expect(tiles(m.id)).toHaveLength(0);
    });

    it("audio plays in the message: a player under its download chip, kept across renders, stopped once gone", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await me.api.send({
        id: newId(),
        room: room.id,
        text: "listen",
        files: [new File(["ID3"], "Song.mp3", { type: "audio/mpeg" })],
      });
      await mount(room);
      const audio = () => msgEl(m.id)!.querySelector("audio");
      const player = audio()!;
      expect(player.hasAttribute("controls")).toBe(true);
      expect(player.getAttribute("aria-label")).toBe("Song.mp3");
      expect(player.getAttribute("src")).toBe(`${inject("pbUrl")}/api/files/messages/${m.id}/${m.files![0]}`);
      expect(tiles(m.id)).toHaveLength(0);
      expect(chips(m.id).map((a) => a.getAttribute("download"))).toEqual(["Song.mp3"]);
      const pause = vi.spyOn(player, "pause");
      // A reaction redraws the message; the same player stays, so one that is playing goes on.
      await other.api.react(m.id, "🎉", true);
      await vi.waitFor(() => expect(msgEl(m.id)!.querySelector('.reaction[data-emoji="🎉"]')).not.toBeNull());
      expect(audio()).toBe(player);
      expect(pause).not.toHaveBeenCalled();
      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      await vi.waitFor(() => expect(msgEl(m.id)!.classList.contains("deleted")).toBe(true));
      expect(audio()).toBeNull();
      expect(pause).toHaveBeenCalled();
    });

    it("an image that fails to load offers Retry", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "", files: [pngFile()] });
      await mount(room);
      const img = () => msgEl(m.id)!.querySelector<HTMLImageElement>(".att-tile img");
      img()!.dispatchEvent(new Event("error"));
      expect(img()).toBeNull();
      const broken = msgEl(m.id)!.querySelector(".att-broken")!;
      expect(broken.textContent).toContain("Couldn't load image");
      button(broken, "Retry")!.click();
      expect(img()).not.toBeNull();
    });
  });
});
