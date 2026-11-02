// happy-dom has no layout engine and no working IntersectionObserver. These stand-ins let view tests
// drive scrolling and sentinels deterministically. Real scrolling is covered by the e2e suite.

/**
 * Give a scroll container fake geometry: children are `rowHeight` tall, stacked in DOM order.
 * scrollTop is clamped like a browser's. Returns setters for tests to "scroll".
 */
export function fakeLayout(list: HTMLElement, opts: { rowHeight: number; clientHeight: number; scrollTop?: number }) {
  const { rowHeight } = opts;
  let clientHeight = opts.clientHeight;
  let scrollTop = opts.scrollTop ?? 0;
  const scrollHeight = () => list.children.length * rowHeight;
  const clamp = (v: number) => Math.max(0, Math.min(v, Math.max(0, scrollHeight() - clientHeight)));
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = clamp(v);
        relayout();
      },
    },
  });
  // offsetTop of each child = its index × rowHeight (children are looked up live).
  const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
  if (!(HTMLElement.prototype as { __fakeOffsetTop?: boolean }).__fakeOffsetTop) {
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        const parent = this.parentElement as (HTMLElement & { __rowHeight?: number }) | null;
        if (parent?.__rowHeight) return [...parent.children].indexOf(this) * parent.__rowHeight;
        return proto?.get?.call(this) ?? 0;
      },
    });
    (HTMLElement.prototype as { __fakeOffsetTop?: boolean }).__fakeOffsetTop = true;
    // Rects too: the list is the viewport from 0 to its clientHeight, its children rows scrolled by its scrollTop.
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const self = this as HTMLElement & { __rowHeight?: number };
      const parent = this.parentElement as (HTMLElement & { __rowHeight?: number }) | null;
      if (self.__rowHeight) return new DOMRect(0, 0, 0, this.clientHeight);
      if (parent?.__rowHeight) return new DOMRect(0, this.offsetTop - parent.scrollTop, 0, parent.__rowHeight);
      return rect.call(this);
    };
  }
  (list as HTMLElement & { __rowHeight?: number }).__rowHeight = rowHeight;
  return {
    /** The visible height changes (e.g. the composer grew); scrollTop stays, as in a browser. */
    setClientHeight(h: number) {
      clientHeight = h;
      relayout();
    },
    scrollTo(v: number) {
      list.scrollTop = v;
      list.dispatchEvent(new Event("scroll"));
    },
    scrollToBottom() {
      this.scrollTo(scrollHeight());
    },
  };
}

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;

/** Set by installIntersectionObserver: the fake layout changed (a scroll, rows added), so whole-row observers look again. */
let relayout = () => {};

/**
 * Replace IntersectionObserver with a controllable fake. Returns `intersect(el)` to fire it. Observers watching for
 * whole rows (`threshold: 1`) of a list with fakeLayout follow it on their own, after the change, as a browser's do
 * (with `rootMargin`'s top); the others fire only by `intersect()`.
 */
export function installIntersectionObserver() {
  const observers = new Set<FakeIO>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  relayout = () => {
    pending ??= setTimeout(() => {
      pending = undefined;
      for (const o of [...observers]) o.look();
    });
  };

  class FakeIO {
    readonly targets = new Set<Element>();
    readonly callback: IOCallback;
    readonly root: HTMLElement | null;
    readonly whole: boolean;
    readonly marginTop: number;
    /** The ratio last told, by target. */
    readonly told = new Map<Element, number>();
    constructor(callback: IOCallback, opts: IntersectionObserverInit = {}) {
      this.callback = callback;
      this.root = (opts.root as HTMLElement | null) ?? null;
      this.whole = opts.threshold === 1;
      this.marginTop = Number.parseFloat(opts.rootMargin ?? "0") || 0;
      observers.add(this);
    }
    /** Tell the targets whose ratio changed (a new one always), as the fake layout places them. */
    look() {
      const root = this.root as (HTMLElement & { __rowHeight?: number }) | null;
      if (!this.whole || !root?.__rowHeight) return;
      const entries = [];
      for (const target of this.targets) {
        if (!target.isConnected) continue;
        const r = target.getBoundingClientRect();
        const top = Math.max(r.top, -this.marginTop);
        const bottom = Math.min(r.bottom, root.clientHeight);
        const ratio = r.height ? Math.max(0, bottom - top) / r.height : 0;
        if (this.told.get(target) === ratio) continue;
        this.told.set(target, ratio);
        entries.push({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 } as unknown as IntersectionObserverEntry);
      }
      if (entries.length) this.callback(entries, this as unknown as IntersectionObserver);
    }
    observe(el: Element) {
      this.targets.add(el);
      relayout();
    }
    unobserve(el: Element) {
      this.targets.delete(el);
      this.told.delete(el);
    }
    disconnect() {
      this.targets.clear();
      this.told.clear();
      observers.delete(this);
    }
    takeRecords() {
      return [];
    }
  }

  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;

  return {
    /** Fire every observer watching an element matching `el` (must be connected). Returns whether any fired. */
    intersect(el: Element | null): boolean {
      if (!el) return false;
      let fired = false;
      for (const o of [...observers]) {
        if (!o.targets.has(el)) continue;
        fired = true;
        o.callback([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver);
      }
      return fired;
    },
    observing: (el: Element | null) => !!el && [...observers].some((o) => o.targets.has(el)),
    restore() {
      globalThis.IntersectionObserver = original;
      clearTimeout(pending);
      relayout = () => {};
    },
  };
}

/** Go to `path` the way Back and Forward do: a history entry, then `popstate` (what the router follows, §7.1). */
export function visit(path: string): void {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
