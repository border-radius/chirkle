// Attachment helpers (§17.4, §17.5). Pure, so the naming and limit rules are unit-tested.

import * as S from "../strings/lib-files.ts";
import { LIMITS } from "./limits.ts";

/** Extensions shown inline as images (through server thumbnails, except GIFs and WebPs: see showsItself). */
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);

const ext = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export const isImage = (name: string): boolean => name.includes(".") && IMAGE_EXT.has(ext(name));

/**
 * A GIF's or a WebP's tile shows the file itself: PocketBase thumbnails them from their first frame only, so an animated
 * one wouldn't play. The clients turn a still WebP into JPEG (PNG if transparent) before upload (§15.3), so a WebP is mostly an animated one;
 * and a still WebP's thumbnail would be a PNG, often bigger than the file itself (QA BUG-26).
 */
export const showsItself = (name: string): boolean => name.includes(".") && (ext(name) === "gif" || ext(name) === "webp");

/** Extensions shown inline as videos: the browser draws their first frame and plays them (there are no server thumbnails). */
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);

export const isVideo = (name: string): boolean => name.includes(".") && VIDEO_EXT.has(ext(name));

/** Extensions played inline with an audio player (§17.5). */
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"]);

export const isAudio = (name: string): boolean => name.includes(".") && AUDIO_EXT.has(ext(name));

/** Shown inline (as an image or a video) rather than as a download chip. */
export const isMedia = (name: string): boolean => isImage(name) || isVideo(name);

/** "report_k3j2h1g0f9.pdf" → "report.pdf": PocketBase adds "_" + 10 random characters to stored names. */
export function displayName(stored: string): string {
  return stored.replace(/_[a-z0-9]{10}(\.[^.]*)?$/i, "$1");
}

/** What to call a message's attachment: its original upload name when the server recorded it (QA BUG-28). */
export function attachmentName(m: { file_names?: Record<string, string> }, stored: string): string {
  return m.file_names?.[stored] || displayName(stored);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

export interface FileCheck {
  accepted: File[];
  rejected: { name: string; reason: string }[];
}

/** Which of `added` fit next to `existing`: at most 10 files per message, each at most 20 MB (LIMITS). */
export function checkFiles(existing: readonly File[], added: readonly File[]): FileCheck {
  const out: FileCheck = { accepted: [], rejected: [] };
  for (const f of added) {
    if (f.size > LIMITS.attachmentBytes) {
      out.rejected.push({ name: f.name, reason: S.largerThan(formatBytes(LIMITS.attachmentBytes)) });
    } else if (existing.length + out.accepted.length >= LIMITS.attachments) {
      out.rejected.push({ name: f.name, reason: S.atMostFilesPerMessage(LIMITS.attachments) });
    } else {
      out.accepted.push(f);
    }
  }
  return out;
}
