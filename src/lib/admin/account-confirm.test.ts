import { describe, expect, it } from "vitest";
import {
  adminTarget,
  CONFIRM_CLOSED,
  confirmCopy,
  confirmReducer,
  type ConfirmEvent,
  type ConfirmState,
} from "./account-confirm";

function play(events: ConfirmEvent[]): ConfirmState[] {
  const states: ConfirmState[] = [];
  let state = CONFIRM_CLOSED;
  for (const event of events) {
    state = confirmReducer(state, event);
    states.push(state);
  }
  return states;
}

describe("adminTarget", () => {
  it("grants when the user is not an admin and revokes when they are", () => {
    expect(adminTarget(false)).toBe("grantAdmin");
    expect(adminTarget(true)).toBe("revokeAdmin");
  });
});

describe("confirmReducer", () => {
  it("closes after a grant and never reopens as the revoke dialog", () => {
    const target = adminTarget(false);
    const states = play([{ type: "open", target }, { type: "confirm" }]);
    const confirmed = states[1];
    expect(confirmed).toEqual({ open: false, target: "grantAdmin" });
    // The refresh flips isAdmin; the frozen target keeps the grant copy.
    expect(adminTarget(true)).toBe("revokeAdmin");
    expect(confirmCopy(confirmed.target!, "Ada").title).toBe(
      "Grant admin access to Ada?",
    );
    const settled = confirmReducer(confirmed, { type: "settled" });
    expect(settled).toEqual(CONFIRM_CLOSED);
    expect([...states, settled].slice(1).every((s) => !s.open)).toBe(true);
  });

  it("closes after a revoke and never reopens as the grant dialog", () => {
    const target = adminTarget(true);
    const states = play([
      { type: "open", target },
      { type: "confirm" },
      { type: "settled" },
    ]);
    expect(states[1]).toEqual({ open: false, target: "revokeAdmin" });
    expect(confirmCopy(states[1].target!, "Ada").title).toBe(
      "Remove admin access from Ada?",
    );
    expect(states[2]).toEqual(CONFIRM_CLOSED);
    expect(states.slice(1).every((s) => !s.open)).toBe(true);
  });

  it("dismisses without clearing the target, and settled then clears it", () => {
    const states = play([
      { type: "open", target: "deactivate" },
      { type: "dismiss" },
      { type: "settled" },
    ]);
    expect(states[1]).toEqual({ open: false, target: "deactivate" });
    expect(states[2]).toEqual(CONFIRM_CLOSED);
  });

  it("leaves a dialog opened after a confirm alone when the earlier action settles", () => {
    const states = play([
      { type: "open", target: "grantAdmin" },
      { type: "confirm" },
      { type: "open", target: "deactivate" },
      { type: "settled" },
    ]);
    expect(states[3]).toEqual({ open: true, target: "deactivate" });
  });
});

describe("confirmCopy", () => {
  it("returns the copy for each target", () => {
    expect(confirmCopy("grantAdmin", "Ada")).toEqual({
      title: "Grant admin access to Ada?",
      description: "They'll be able to manage users, positions, and products.",
      label: "Grant admin access",
      destructive: false,
    });
    expect(confirmCopy("revokeAdmin", "Ada")).toEqual({
      title: "Remove admin access from Ada?",
      description: "They'll no longer be able to manage SGAuth.",
      label: "Remove admin access",
      destructive: true,
    });
    expect(confirmCopy("deactivate", "Ada")).toEqual({
      title: "Deactivate Ada?",
      description:
        "They'll be signed out everywhere immediately and can't sign in until reactivated.",
      label: "Deactivate",
      destructive: true,
    });
  });
});
