// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelSourceTiles, type ModelSource } from "./ModelSourceTiles";

/**
 * The connect step's row of model sources is a radiogroup, and a radiogroup
 * whose arrows moved the selection without moving the caret would be announced
 * and then not behave — worse than three plain buttons.
 *
 * The caret lands a frame late on purpose. `onSelect` re-renders the row, the
 * row moves under `AnimatePresence`'s `popLayout` mode, and the tile that was
 * looked up before that commit is not necessarily the tile the commit leaves
 * standing. Answering inside the handler puts the keyboard on a node the commit
 * has left behind, which reads as a tile chosen with nobody holding it. So the
 * focus is posed from a `requestAnimationFrame` instead, after the commit.
 *
 * These tests pin that from the outside: what the keyboard user is holding once
 * the row has settled, not which frame did the posing.
 */

const SOURCES: ModelSource[] = [
  { id: "claude", label: "Claude Code", icon: null },
  { id: "codex", label: "OpenAI", icon: null },
  { id: "gemini", label: "Gemini", icon: null },
];

/** The row's caller, which owns the answer — as the step does. */
function Harness({
  initialSelectedId = null,
  collapsed = false,
}: {
  initialSelectedId?: string | null;
  collapsed?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  return (
    <ModelSourceTiles
      sources={SOURCES}
      mode="subscription"
      selectedId={selectedId}
      onSelect={setSelectedId}
      label="Connect a model"
      collapsed={collapsed}
    />
  );
}

let root: Root;
let host: HTMLDivElement;

/**
 * The frame queue the caret is posed from, held rather than borrowed.
 *
 * jsdom does run `requestAnimationFrame`, but React's async `act` flushes it
 * along with its own work: with the real timer a test that awaited a frame
 * would leave the caret already posed, and could not tell a focus set inside
 * the handler from one set a frame later. Holding the queue here separates the
 * two beats and takes jsdom's frame timer out of the result.
 */
let frames: Map<number, FrameRequestCallback>;
let frameIds: number;

beforeEach(() => {
  frames = new Map();
  frameIds = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameIds, callback);
    return frameIds;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  // Motion reads the reduced-motion query, and jsdom implements neither
  // `matchMedia` nor a layout to animate against. Pinned to "no preference" so
  // the token layer resolves the repo's real durations rather than none.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const row = () => host.querySelector<HTMLElement>('[role="radiogroup"]')!;
const tiles = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
/** The tile the row currently answers with, by its accessible name. */
const picked = () =>
  tiles()
    .find((tile) => tile.getAttribute("aria-checked") === "true")
    ?.getAttribute("aria-label") ?? null;

async function render(initialSelectedId: string | null = null, collapsed = false) {
  await act(async () => {
    root.render(<Harness initialSelectedId={initialSelectedId} collapsed={collapsed} />);
  });
}

async function pressArrow(key: "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp") {
  await act(async () => {
    row().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/**
 * Run the held frames, and the microtasks behind them.
 *
 * The row's focus is posed from one of these. Motion's own frame loop drains
 * with it — harmless here, and the reason the drain is inside `act`: whatever
 * a frame sets in flight commits before the assertion that follows.
 */
async function flushFrame() {
  await act(async () => {
    for (const callback of [...frames.values()]) callback(performance.now());
    frames.clear();
    await Promise.resolve();
  });
}

describe("ModelSourceTiles keyboard navigation", () => {
  it("moves the caret onto the tile an arrow just picked, from an unanswered row", async () => {
    await render();
    expect(picked(), "the row opens unanswered").toBeNull();

    await pressArrow("ArrowRight");

    expect(picked(), "either arrow enters the row from its near end").toBe(
      "Claude Code Subscription",
    );
    // The caret is not there yet: it is posed from the frame after the commit
    // above, so that `popLayout` cannot leave it on a tile the row replaced.
    // Posed inside the handler, this is where a keyboard user would be left
    // holding a node that commit has already moved out from under them.
    expect(document.activeElement).not.toBe(tiles()[0]);

    await flushFrame();

    expect(document.activeElement).toBe(tiles()[0]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Claude Code Subscription",
    );
  });

  it("takes the caret with the selection when the arrows move along the row", async () => {
    await render("claude");
    await flushFrame();

    await pressArrow("ArrowRight");
    await flushFrame();

    expect(document.activeElement).toBe(tiles()[1]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("OpenAI Subscription");

    await pressArrow("ArrowRight");
    await flushFrame();

    expect(document.activeElement).toBe(tiles()[2]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Gemini Subscription");
  });

  it("wraps at the end of the row and keeps the caret on the wrapped-to tile", async () => {
    await render();
    // Untouched by the arrows, so entering from the far end is the only way in.
    await pressArrow("ArrowLeft");
    await flushFrame();

    expect(
      document.activeElement?.getAttribute("aria-label"),
      "three tiles is short enough that stopping at the edges just reads as the key having failed",
    ).toBe("Gemini Subscription");

    await pressArrow("ArrowRight");
    await flushFrame();

    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Claude Code Subscription",
    );
    expect(document.activeElement).toBe(tiles()[0]);
  });

  it.each(["ArrowDown", "ArrowUp"] as const)(
    "treats %s as the same step along the row",
    async (key) => {
      await render();
      await pressArrow(key);
      await flushFrame();

      expect(picked()).toBe(
        key === "ArrowDown" ? "Claude Code Subscription" : "Gemini Subscription",
      );
      expect(document.activeElement).toBe(
        tiles().find((tile) => tile.getAttribute("aria-checked") === "true"),
      );
    },
  );

  it("leaves both the selection and the caret alone once the row is collapsed", async () => {
    await render("codex", true);
    const pickedTile = tiles().find((tile) => tile.getAttribute("aria-checked") === "true")!;
    await act(async () => pickedTile.focus());

    await pressArrow("ArrowRight");
    await flushFrame();

    expect(
      picked(),
      "collapsed, the row is a statement rather than a choice, so there is nothing to move",
    ).toBe("OpenAI Subscription");
    expect(document.activeElement).toBe(pickedTile);
  });
});
