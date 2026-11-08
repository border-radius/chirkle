import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, savedTheme, setTheme, startTheme } from "../../web/src/theme.ts";

function memoryStorage(throws = false): Storage {
  const m = new Map<string, string>();
  const fail = () => {
    if (throws) throw new Error("SecurityError");
  };
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => {
      fail();
      return m.get(k) ?? null;
    },
    setItem: (k, v) => {
      fail();
      m.set(k, v);
    },
    removeItem: (k) => {
      fail();
      m.delete(k);
    },
  };
}

describe("theme (§7.8)", () => {
  const metas = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    for (const m of metas()) m.remove();
  });

  it("is auto unless light or dark was saved", () => {
    const s = memoryStorage();
    expect(savedTheme(s)).toBe("auto");
    s.setItem("chat.theme", "purple");
    expect(savedTheme(s)).toBe("auto");
    s.setItem("chat.theme", "dark");
    expect(savedTheme(s)).toBe("dark");
    expect(savedTheme(null)).toBe("auto");
    expect(savedTheme(memoryStorage(true))).toBe("auto");
  });

  it("sets <html data-theme> and gives both theme-color metas the chosen theme's color; auto puts them back", () => {
    for (const [scheme, color] of [
      ["light", "#f1eefc"],
      ["dark", "#111214"],
    ]) {
      document.head.append(
        Object.assign(document.createElement("meta"), { name: "theme-color", content: color, media: `(prefers-color-scheme: ${scheme})` }),
      );
    }
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(metas().map((m) => m.content)).toEqual(["#111214", "#111214"]);
    applyTheme("light");
    expect(metas().map((m) => m.content)).toEqual(["#f1eefc", "#f1eefc"]);
    applyTheme("auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(metas().map((m) => m.content)).toEqual(["#f1eefc", "#111214"]);
  });

  it("saves the choice (auto removes it), and still applies it when storage throws", () => {
    const s = memoryStorage();
    setTheme("light", s);
    expect(s.getItem("chat.theme")).toBe("light");
    setTheme("auto", s);
    expect(s.getItem("chat.theme")).toBeNull();
    setTheme("dark", memoryStorage(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows another tab's choice", () => {
    const s = memoryStorage();
    const stop = startTheme(s);
    s.setItem("chat.theme", "dark");
    dispatchEvent(new StorageEvent("storage", { key: "chat.theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
    s.setItem("chat.theme", "light");
    dispatchEvent(new StorageEvent("storage", { key: "chat.theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
