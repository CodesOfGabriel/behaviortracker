import { describe, expect, it } from "vitest";
import { nearestFrame } from "./ForcedSwimLocalPanel";

describe("sincronização do resultado FST local", () => {
  it("usa timestamps reais quando os intervalos entre frames variam", () => {
    const times = [0, 0.04, 0.08, 0.2, 0.24];
    expect(nearestFrame(times, 0.16)).toBe(3);
    expect(nearestFrame(times, 0.09)).toBe(2);
    expect(nearestFrame(times, 9)).toBe(4);
  });
});
