import { describe, it, expect } from "vitest";
import { THINKING_LEVELS } from "./models";

describe("thinking levels", () => {
  it("includes xhigh and max for teammate configuration", () => {
    expect(THINKING_LEVELS).toContain("xhigh");
    expect(THINKING_LEVELS).toContain("max");
  });
});
