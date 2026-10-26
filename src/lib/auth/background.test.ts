import { beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after }));

import { runAfterResponse } from "@/lib/auth/background";

describe("runAfterResponse", () => {
  beforeEach(() => {
    after.mockReset();
  });

  it("hands the task to after()", () => {
    const task = Promise.resolve();
    runAfterResponse(task);
    expect(after).toHaveBeenCalledWith(task);
  });

  it("does not throw outside a request scope", () => {
    after.mockImplementation(() => {
      throw new Error("after was called outside a request scope");
    });
    expect(() => runAfterResponse(Promise.resolve())).not.toThrow();
  });
});
