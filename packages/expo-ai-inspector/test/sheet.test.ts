import { describe, expect, it } from "vitest";
import { DEFAULT_DETENT, detentHeight, dragHeight, settle, stepDetent } from "../src/ui/sheet";

const H = 800; // detents: 200 / 400 / 600

describe("sheet detents", () => {
  it("defaults to half height", () => {
    expect(DEFAULT_DETENT).toBe(0.5);
    expect(detentHeight(DEFAULT_DETENT, H)).toBe(400);
  });
  it("settles on the nearest detent when released slowly", () => {
    expect(settle(410, 0, H)).toBe(0.5);
    expect(settle(320, 0, H)).toBe(0.5);
    expect(settle(560, 0, H)).toBe(0.75);
    expect(settle(230, 0, H)).toBe(0.25);
  });
  it("projects flings so a quick flick moves one detent", () => {
    expect(settle(400, -1.5, H)).toBe(0.75); // fast upward
    expect(settle(400, 1.2, H)).toBe(0.25); // fast downward
  });
  it("dismisses only on a decisive downward fling below a quarter", () => {
    expect(settle(180, 1.2, H)).toBe("dismiss");
    expect(settle(220, 1.2, H)).toBe(0.25); // still above ¼ when released
    expect(settle(700, 3, H)).toBe(0.25); // long fast fling from ¾ lands on ¼
    expect(settle(200, 0.2, H)).toBe(0.25);
    expect(settle(150, 0, H)).toBe(0.25);
  });
  it("rubber-bands past the top and bottom detents", () => {
    expect(dragHeight(600, -100, H)).toBe(625);
    expect(dragHeight(200, 100, H)).toBe(150);
    expect(dragHeight(400, -50, H)).toBe(450);
  });
  it("steps between detents and stops at the ends", () => {
    expect(stepDetent(0.5, 1)).toBe(0.75);
    expect(stepDetent(0.75, 1)).toBe(0.75);
    expect(stepDetent(0.5, -1)).toBe(0.25);
    expect(stepDetent(0.25, -1)).toBe(0.25);
  });
});
