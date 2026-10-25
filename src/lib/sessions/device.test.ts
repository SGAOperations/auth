import { describe, expect, it } from "vitest";
import { describeDevice } from "@/lib/sessions/device";

const CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Chrome on macOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari on iPhone",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Safari on macOS",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Firefox on Windows",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    "Edge on Windows",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    "Chrome on Android",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Firefox on Linux",
  ],
  [
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Chrome on ChromeOS",
  ],
  [
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1",
    "Chrome on iPad",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0",
    "Opera on Windows",
  ],
  ["curl (Linux)", "Unknown browser on Linux"],
  ["SGAuthTest/1.0", "Unknown device"],
];

describe("describeDevice", () => {
  it.each(CASES)("describes %s", (userAgent, expected) => {
    expect(describeDevice(userAgent)).toBe(expected);
  });

  it("handles null, empty and oversized input without throwing", () => {
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice(undefined)).toBe("Unknown device");
    expect(describeDevice("")).toBe("Unknown device");
    expect(describeDevice("x".repeat(10_000))).toBe("Unknown device");
  });

  it("only reads the first 512 characters", () => {
    const padded = `${"x".repeat(600)} Firefox/127.0 Windows`;
    expect(describeDevice(padded)).toBe("Unknown device");
  });
});
