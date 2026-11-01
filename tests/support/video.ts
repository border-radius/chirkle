// A real video for upload tests, made with ffmpeg (FFMPEG names the binary). Node only: not for the happy-dom projects.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A one-second MP4 (64×48 unless asked), or null when there is no ffmpeg here. */
export function makeMp4(width = 64, height = 48): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), "media-test-"));
  try {
    const out = join(dir, "clip.mp4");
    execFileSync(process.env.FFMPEG || "ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=red:s=${width}x${height}:d=1`,
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
