import { describe, expect, it, vi } from "vitest";
import {
  OPS_SIGNAL_CATALOG,
  recordOpsSignal,
  type OpsSignalDb,
} from "@/lib/alerts/signals";

function fakeDb(create = vi.fn(async () => ({}))) {
  return { db: { opsSignal: { create } } as unknown as OpsSignalDb, create };
}

describe("OPS_SIGNAL_CATALOG", () => {
  it("accepts the documented detail for each kind", () => {
    expect(
      OPS_SIGNAL_CATALOG.RATE_LIMIT_FAIL_OPEN.safeParse({
        policy: "sign-in",
        rule: "ip",
        reason: "timeout",
      }).success,
    ).toBe(true);
    expect(
      OPS_SIGNAL_CATALOG.EMAIL_CAP_FAIL_OPEN.safeParse({ reason: "error" })
        .success,
    ).toBe(true);
    expect(
      OPS_SIGNAL_CATALOG.JOB_FAILED.safeParse({ job: "pa-transfer" }).success,
    ).toBe(true);
  });

  it("rejects an unknown key, a bad reason and a bad job name", () => {
    expect(
      OPS_SIGNAL_CATALOG.EMAIL_CAP_FAIL_OPEN.safeParse({
        reason: "error",
        ip: "203.0.113.9",
      }).success,
    ).toBe(false);
    expect(
      OPS_SIGNAL_CATALOG.EMAIL_CAP_FAIL_OPEN.safeParse({ reason: "boom" })
        .success,
    ).toBe(false);
    expect(
      OPS_SIGNAL_CATALOG.JOB_FAILED.safeParse({ job: "Bad Job" }).success,
    ).toBe(false);
  });
});

describe("recordOpsSignal", () => {
  it("inserts one row with the parsed detail", async () => {
    const { db, create } = fakeDb();
    const log = { error: vi.fn() };
    await recordOpsSignal(
      { kind: "JOB_FAILED", detail: { job: "alerts" } },
      { db, log },
    );
    expect(create).toHaveBeenCalledWith({
      data: { kind: "JOB_FAILED", detail: { job: "alerts" } },
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("resolves and logs once, without the detail, when the insert rejects", async () => {
    const { db } = fakeDb(
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED postgres://secret-host");
      }),
    );
    const log = { error: vi.fn() };
    await expect(
      recordOpsSignal(
        { kind: "JOB_FAILED", detail: { job: "alerts" } },
        { db, log },
      ),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("[ALERT] ops signal write failed", {
      kind: "JOB_FAILED",
      errorName: "Error",
    });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-host");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("alerts");
  });

  it("resolves without writing when the detail is invalid", async () => {
    const { db, create } = fakeDb();
    const log = { error: vi.fn() };
    await expect(
      recordOpsSignal(
        {
          kind: "EMAIL_CAP_FAIL_OPEN",
          detail: { reason: "error", extra: 1 } as never,
        },
        { db, log },
      ),
    ).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
