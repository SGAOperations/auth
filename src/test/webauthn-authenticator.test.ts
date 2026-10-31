import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { hasUserVerification } from "@/lib/auth/passkey-policy";
import { createSoftwareAuthenticator } from "@/test/webauthn-authenticator";

// The DB tests lean on this authenticator, so it is held to the same verifier
// the passkey plugin uses.

const ORIGIN = "http://localhost:3000";
const RP_ID = "localhost";

async function enroll(uv: boolean) {
  const authenticator = createSoftwareAuthenticator();
  const options = await generateRegistrationOptions({
    rpName: "Test",
    rpID: RP_ID,
    userName: "a@northeastern.edu",
    attestationType: "none",
  });
  const { credential, response } = authenticator.register(options, {
    origin: ORIGIN,
    uv,
  });
  const verification = await verifyRegistrationResponse({
    response: response as Parameters<
      typeof verifyRegistrationResponse
    >[0]["response"],
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: uv,
  });
  return { authenticator, credential, verification };
}

describe("software WebAuthn authenticator", () => {
  it("registers a credential the verifier accepts", async () => {
    const { credential, verification } = await enroll(true);
    expect(verification.verified).toBe(true);
    expect(verification.registrationInfo?.credential.id).toBe(credential.id);
    expect(verification.registrationInfo?.userVerified).toBe(true);
  });

  it("signs assertions with an increasing counter", async () => {
    const { authenticator, credential, verification } = await enroll(true);
    const stored = verification.registrationInfo!.credential;
    for (const expectedCounter of [1, 2]) {
      const options = await generateAuthenticationOptions({ rpID: RP_ID });
      const response = authenticator.authenticate(options, {
        origin: ORIGIN,
        uv: true,
        credential,
      });
      const result = await verifyAuthenticationResponse({
        response: response as Parameters<
          typeof verifyAuthenticationResponse
        >[0]["response"],
        expectedChallenge: options.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: stored,
        requireUserVerification: true,
      });
      expect(result.verified).toBe(true);
      expect(result.authenticationInfo.newCounter).toBe(expectedCounter);
      stored.counter = result.authenticationInfo.newCounter;
    }
  });

  it("clears the user-verified flag when asked", async () => {
    const { authenticator, credential } = await enroll(true);
    const options = await generateAuthenticationOptions({ rpID: RP_ID });
    const withUv = authenticator.authenticate(options, {
      origin: ORIGIN,
      uv: true,
      credential,
    });
    const withoutUv = authenticator.authenticate(options, {
      origin: ORIGIN,
      uv: false,
      credential,
    });
    expect(hasUserVerification(withUv.response.authenticatorData)).toBe(true);
    expect(hasUserVerification(withoutUv.response.authenticatorData)).toBe(
      false,
    );
  });

  it("fails verification with a bad signature", async () => {
    const { authenticator, credential, verification } = await enroll(true);
    const options = await generateAuthenticationOptions({ rpID: RP_ID });
    const response = authenticator.authenticate(options, {
      origin: ORIGIN,
      uv: true,
      credential,
      badSignature: true,
    });
    await expect(
      verifyAuthenticationResponse({
        response: response as Parameters<
          typeof verifyAuthenticationResponse
        >[0]["response"],
        expectedChallenge: options.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: verification.registrationInfo!.credential,
      })
        .then((result) => result.verified)
        .catch(() => false),
    ).resolves.toBe(false);
  });
});
