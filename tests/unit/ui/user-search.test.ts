import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room, User } from "../../../web/src/lib/types.ts";
import { createUserSearch, SEARCH_DEBOUNCE_MS } from "../../../web/src/ui/user-search.ts";
import { createForwardDialog } from "../../../web/src/views/room/forward.ts";

const user = (id: string, name: string) => ({ id, name, avatar: "" }) as unknown as User;
const enter = (el: Element) => {
  const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe("people search (QA BUG-272, BUG-273)", () => {
  let ac: AbortController;
  beforeEach(() => {
    ac = new AbortController();
  });
  afterEach(() => {
    ac.abort();
    document.body.replaceChildren();
  });

  function mount(found: User[], label?: string) {
    const search = vi.fn(async (_q: string) => found);
    const onPick = vi.fn();
    const ui = createUserSearch({ search, avatarUrl: () => "", onPick, onClose: () => {}, signal: ac.signal, ...(label ? { label } : {}) });
    document.body.append(ui.el);
    const input = ui.el.querySelector("input")!;
    const type = (q: string) => {
      input.value = q;
      input.dispatchEvent(new Event("input"));
    };
    return { ui, input, type, search, onPick };
  }

  it("Enter right after typing searches at once and picks the first person found", async () => {
    const { input, type, search, onPick } = mount([user("b1", "Bob"), user("b2", "Bobby")]);
    type("bo");
    expect(enter(input).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledOnce());
    expect(onPick.mock.calls[0]![0].id).toBe("b1");
    // The debounced search doesn't run a second time.
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(search).toHaveBeenCalledOnce();
  });

  it("Enter once the results show picks the first; nothing found or nothing typed picks nobody", async () => {
    const some = mount([user("c1", "Cat")]);
    some.type("ca");
    await vi.waitFor(() => expect(some.ui.el.querySelectorAll("button.person")).toHaveLength(1));
    enter(some.input);
    expect(some.onPick).toHaveBeenCalledOnce();

    const none = mount([]);
    none.type("zz");
    enter(none.input);
    await vi.waitFor(() => expect(none.ui.el.textContent).toContain("No one found."));
    enter(none.input);
    none.type("");
    enter(none.input);
    expect(none.onPick).not.toHaveBeenCalled();
  });

  it("is named for what it is for", () => {
    const dm = mount([]);
    expect(dm.ui.el.querySelector("label")!.textContent).toBe("Find someone to message");
    const add = mount([], "Find someone to add as a member");
    expect(add.ui.el.querySelector("label")!.textContent).toBe("Find someone to add as a member");
  });
});

describe("forward dialog: Enter forwards to the first match (QA BUG-272)", () => {
  it("picks the first room matching what is typed, and nothing with nothing typed", async () => {
    const ac = new AbortController();
    const rooms = [
      { id: "r1", name: "general", kind: "" },
      { id: "r2", name: "games", kind: "" },
    ] as unknown as Room[];
    const onPick = vi.fn(async () => null);
    const d = createForwardDialog({
      rooms: () => rooms,
      me: () => null,
      searchUsers: async () => [],
      avatarUrl: () => "",
      onPick,
      signal: ac.signal,
    });
    document.body.append(d.el);
    d.open(1);
    const input = d.el.querySelector("input")!;
    enter(input);
    expect(onPick).not.toHaveBeenCalled();
    input.value = "gam";
    input.dispatchEvent(new Event("input"));
    enter(input);
    expect(onPick).toHaveBeenCalledWith({ room: rooms[1] });
    ac.abort();
    document.body.replaceChildren();
  });
});
