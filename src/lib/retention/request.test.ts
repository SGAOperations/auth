import { describe, expect, it } from "vitest";
import { JobInputError } from "@/lib/jobs/handler";
import { parseDryRun } from "@/lib/retention/request";

const at = (query: string) =>
  new Request(`https://auth.example.test/api/jobs/retention${query}`, {
    method: "POST",
  });

describe("parseDryRun", () => {
  it.each([["?dryRun=1"], ["?dryRun=true"], ["?other=x&dryRun=1"]])(
    "is a dry run for %s",
    (query) => {
      expect(parseDryRun(at(query))).toBe(true);
    },
  );

  it.each([[""], ["?other=x"]])("is a real run for %s", (query) => {
    expect(parseDryRun(at(query))).toBe(false);
  });

  it.each([["?dryRun=maybe"], ["?dryRun=0"], ["?dryRun="], ["?dryRun=TRUE"]])(
    "refuses %s instead of running for real",
    (query) => {
      expect(() => parseDryRun(at(query))).toThrow(JobInputError);
    },
  );
});
