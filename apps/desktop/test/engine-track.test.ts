import { describe, expect, test } from "bun:test";
import { enginePhase, trackEngine } from "../src/renderer/engine";

describe("trackEngine", () => {
  test("the first start is not a restart and has not been ready yet", () => {
    const track = trackEngine(null, "starting", 10);
    expect(track).toMatchObject({ restarting: false, wasReady: false, back: false, since: 10 });
    expect(enginePhase(track)).toBe("starting");
  });

  test("failing before ever being ready is 'stopped while starting'", () => {
    const failed = trackEngine(trackEngine(null, "starting", 0), "failed", 5);
    expect(failed.wasReady).toBe(false);
    expect(enginePhase(failed)).toBe("failed");
  });

  test("starting again after a failure is a restart, and coming up from it is 'back'", () => {
    const ready = trackEngine(trackEngine(null, "starting", 0), "ready", 1);
    const failed = trackEngine(ready, "failed", 2);
    expect(failed.wasReady).toBe(true);
    const restarting = trackEngine(failed, "starting", 3);
    expect(enginePhase(restarting)).toBe("restarting");
    const back = trackEngine(restarting, "ready", 4);
    expect(back.back).toBe(true);
  });

  test("the first start reaching ready is not announced as 'back'", () => {
    const ready = trackEngine(trackEngine(null, "starting", 0), "ready", 1);
    expect(ready.back).toBe(false);
  });

  test("the same state keeps its timestamp", () => {
    const track = trackEngine(null, "starting", 10);
    expect(trackEngine(track, "starting", 99)).toBe(track);
  });
});
