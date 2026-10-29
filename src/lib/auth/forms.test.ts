import { describe, expect, it } from "vitest";
import {
  AUTH_COPY,
  emailCodeMessage,
  emailCodeRequestSchema,
  emailCodeVerifySchema,
  emailStepSchema,
  forgotPasswordSchema,
  mapEmailCodeError,
  mapEmailStepResponse,
  mapRequestError,
  mapSignInError,
  mapSignUpError,
  passwordLengthState,
  signInMessage,
  signInSchema,
  signUpSchema,
} from "@/lib/auth/forms";
import { AUTH_ERROR_CODES } from "@/lib/auth/policy";

const STRONG = "correct horse battery";

describe("emailStepSchema", () => {
  it("trims, and accepts a non-northeastern address", () => {
    expect(emailStepSchema.parse({ email: " X@Northeastern.edu " }).email).toBe(
      "X@Northeastern.edu",
    );
    expect(emailStepSchema.safeParse({ email: "x@gmail.com" }).success).toBe(
      true,
    );
  });

  it("rejects a non-address and an over-long one", () => {
    expect(emailStepSchema.safeParse({ email: "x" }).success).toBe(false);
    const long = `${"a".repeat(321 - "@northeastern.edu".length)}@northeastern.edu`;
    expect(long).toHaveLength(321);
    expect(emailStepSchema.safeParse({ email: long }).success).toBe(false);
  });
});

describe("forgotPasswordSchema", () => {
  it("takes any well-formed address", () => {
    expect(
      forgotPasswordSchema.safeParse({ email: "x@gmail.com" }).success,
    ).toBe(true);
    expect(forgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(
      false,
    );
  });
});

describe("signInSchema", () => {
  it("never checks the minimum length", () => {
    expect(signInSchema.safeParse({ password: "x" }).success).toBe(true);
    expect(signInSchema.safeParse({ password: "" }).success).toBe(false);
    expect(signInSchema.safeParse({ password: "x".repeat(129) }).success).toBe(
      false,
    );
  });
});

describe("signUpSchema", () => {
  const valid = {
    name: "Husky Dog",
    email: "x@northeastern.edu",
    password: STRONG,
  };

  it("accepts a padded, mixed-case northeastern address", () => {
    expect(
      signUpSchema.safeParse({ ...valid, email: " X@Northeastern.edu " })
        .success,
    ).toBe(true);
  });

  it.each(["x@gmail.com", "x@sub.northeastern.edu"])("rejects %s", (email) => {
    const result = signUpSchema.safeParse({ ...valid, email });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      AUTH_ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED.message,
    );
  });

  it("rejects an empty name", () => {
    expect(signUpSchema.safeParse({ ...valid, name: "  " }).success).toBe(
      false,
    );
  });

  it("enforces 12 to 128 characters", () => {
    for (const length of [11, 129]) {
      expect(
        signUpSchema.safeParse({ ...valid, password: "x".repeat(length) })
          .success,
      ).toBe(false);
    }
    for (const length of [12, 128]) {
      expect(
        signUpSchema.safeParse({ ...valid, password: "x".repeat(length) })
          .success,
      ).toBe(true);
    }
  });
});

describe("passwordLengthState", () => {
  it.each([
    [0, "short"],
    [11, "short"],
    [12, "ok"],
    [128, "ok"],
    [129, "long"],
  ] as const)("%i characters is %s", (length, state) => {
    expect(passwordLengthState(length)).toBe(state);
  });
});

describe("mapEmailStepResponse", () => {
  it("shows the hint only on a 200", () => {
    expect(mapEmailStepResponse({ status: 200 })).toEqual({
      kind: "password",
      hint: true,
    });
  });

  it("carries the body message of a 400, or the default", () => {
    expect(
      mapEmailStepResponse({ status: 400, body: { message: "Bad one." } }),
    ).toEqual({ kind: "field-error", message: "Bad one." });
    expect(mapEmailStepResponse({ status: 400 })).toEqual({
      kind: "field-error",
      message: AUTH_COPY.invalidEmail,
    });
    expect(mapEmailStepResponse({ status: 400, body: { message: 3 } })).toEqual(
      { kind: "field-error", message: AUTH_COPY.invalidEmail },
    );
  });

  it("maps a 429 to rate-limited", () => {
    expect(mapEmailStepResponse({ status: 429 })).toEqual({
      kind: "rate-limited",
    });
  });

  it.each([404, 403, 500, 0])(
    "moves on to the password step without the hint on %i",
    (status) => {
      expect(mapEmailStepResponse({ status })).toEqual({
        kind: "password",
        hint: false,
      });
    },
  );
});

describe("mapSignInError", () => {
  it("gives a wrong password and a bare 401 the same state and copy", () => {
    const wrong = mapSignInError({
      status: 401,
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
    const bare = mapSignInError({ status: 401 });
    expect(wrong).toBe("invalid");
    expect(bare).toBe(wrong);
    expect(signInMessage(bare)).toBe(AUTH_COPY.signInInvalid);
  });

  it("maps the account states and limits", () => {
    expect(mapSignInError({ status: 403, code: "EMAIL_NOT_VERIFIED" })).toBe(
      "unverified",
    );
    expect(mapSignInError({ status: 403, code: "ACCOUNT_DEACTIVATED" })).toBe(
      "deactivated",
    );
    expect(mapSignInError({ status: 429 })).toBe("rate-limited");
    expect(mapSignInError({ status: 500, code: "WHAT" })).toBe("unexpected");
    expect(mapSignInError({ status: 0 })).toBe("unexpected");
  });
});

describe("mapSignUpError", () => {
  it("routes the domain and length codes to their fields", () => {
    expect(
      mapSignUpError({ status: 400, code: "EMAIL_DOMAIN_NOT_ALLOWED" }),
    ).toEqual({
      field: "email",
      message: AUTH_ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED.message,
    });
    expect(mapSignUpError({ status: 400, code: "PASSWORD_TOO_SHORT" })).toEqual(
      { field: "password", message: AUTH_COPY.passwordTooShort },
    );
    expect(mapSignUpError({ status: 400, code: "PASSWORD_TOO_LONG" })).toEqual({
      field: "password",
      message: AUTH_COPY.passwordTooLong,
    });
  });

  it("keeps the server message of a 403", () => {
    expect(
      mapSignUpError({ status: 403, message: "Sign-up is invite-only." }),
    ).toEqual({ field: null, message: "Sign-up is invite-only." });
  });

  it("maps a 429 and anything else", () => {
    expect(mapSignUpError({ status: 429 })).toEqual({
      field: null,
      message: AUTH_COPY.signUpRateLimited,
    });
    expect(mapSignUpError({ status: 500 })).toEqual({
      field: null,
      message: AUTH_COPY.unexpected,
    });
    expect(mapSignUpError({ status: 403 })).toEqual({
      field: null,
      message: AUTH_COPY.unexpected,
    });
  });
});

describe("emailCodeRequestSchema and emailCodeVerifySchema", () => {
  it("trims the address", () => {
    expect(
      emailCodeRequestSchema.parse({ email: "  a@northeastern.edu " }).email,
    ).toBe("a@northeastern.edu");
  });

  it.each(["123456", "000000"])("accepts the code %s", (otp) => {
    expect(
      emailCodeVerifySchema.safeParse({ email: "a@northeastern.edu", otp })
        .success,
    ).toBe(true);
  });

  it.each(["12345", "1234567", "12345a", "", " 12345", "١٢٣٤٥٦"])(
    "rejects the code %j",
    (otp) => {
      expect(
        emailCodeVerifySchema.safeParse({ email: "a@northeastern.edu", otp })
          .success,
      ).toBe(false);
    },
  );
});

describe("mapEmailCodeError", () => {
  it.each([
    [{ status: 429 }, "rate-limited"],
    [{ status: 503, code: "EMAIL_OTP_UNAVAILABLE" }, "unavailable"],
    [{ status: 403, code: "TOO_MANY_ATTEMPTS" }, "too-many-attempts"],
    [{ status: 400, code: "INVALID_OTP" }, "invalid"],
    [{ status: 400, code: "OTP_EXPIRED" }, "invalid"],
    [{ status: 400, code: "INVALID_REQUEST" }, "invalid"],
    [{ status: 500 }, "unexpected"],
    [{ status: 0 }, "unexpected"],
  ] as const)("maps %j to %s", (error, state) => {
    expect(mapEmailCodeError(error)).toBe(state);
  });

  it("writes the copy for each state", () => {
    expect(emailCodeMessage("invalid")).toBe(
      "That code didn't work. Check it, or send a new code.",
    );
    expect(emailCodeMessage("too-many-attempts")).toBe(
      "Too many attempts. Send a new code.",
    );
    expect(emailCodeMessage("rate-limited", 1)).toBe(
      "Too many requests. Try again in 1 minute.",
    );
    expect(emailCodeMessage("rate-limited", 12)).toBe(
      "Too many requests. Try again in 12 minutes.",
    );
    expect(emailCodeMessage("unavailable")).toBe(
      "Email codes are unavailable right now. Sign in with your password, or reset it.",
    );
    expect(emailCodeMessage("unexpected")).toBe(
      "Something went wrong. Try again.",
    );
  });
});

describe("mapRequestError", () => {
  it("separates a 429 from everything else", () => {
    expect(mapRequestError({ status: 429 })).toBe("rate-limited");
    expect(mapRequestError({ status: 500 })).toBe("unexpected");
  });
});
