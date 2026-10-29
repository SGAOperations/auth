import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

// A minimal software WebAuthn authenticator for the DB tests: an ES256 key,
// `fmt: "none"` attestation, and the JSON a browser would post, so the real
// plugin endpoints and their verification run end to end. Not for production
// use: it keeps no secret anywhere but memory.

// The flags byte of the authenticator data.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
  }
  throw new Error("CBOR value too large for this encoder");
}

type Cbor =
  | number
  | string
  | Uint8Array
  | Map<Cbor, Cbor>
  | { [key: string]: Cbor };

// Maps, byte strings, text and integers: all a `none` attestation needs.
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), value]);
  }
  const entries =
    value instanceof Map ? [...value] : Object.entries(value as object);
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([key, entry]) => [
      cbor(key as Cbor),
      cbor(entry as Cbor),
    ]),
  ]);
}

function counterBytes(counter: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
}

function clientData(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
  );
}

export interface SoftwareCredential {
  /** The credential id, base64url, as the server stores it. */
  id: string;
  privateKey: KeyObject;
  counter: number;
}

interface CeremonyOptions {
  origin: string;
  /** Sets the user-verified flag. */
  uv: boolean;
}

export function createSoftwareAuthenticator() {
  function register(
    options: { challenge: string; rp: { id?: string } },
    { origin, uv }: CeremonyOptions,
  ) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = publicKey.export({ format: "jwk" });
    const id = randomBytes(32);
    const credential: SoftwareCredential = {
      id: b64url(id),
      privateKey,
      counter: 0,
    };

    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(Buffer.from(options.rp.id ?? "")),
      Buffer.from([FLAG_UP | FLAG_AT | (uv ? FLAG_UV : 0)]),
      counterBytes(0),
      Buffer.alloc(16),
      idLength,
      id,
      coseKey,
    ]);
    const attestationObject = cbor({
      fmt: "none",
      attStmt: {},
      authData,
    });

    return {
      credential,
      // What @simplewebauthn/browser posts as `response`.
      response: {
        id: credential.id,
        rawId: credential.id,
        type: "public-key",
        response: {
          clientDataJSON: b64url(
            clientData("webauthn.create", options.challenge, origin),
          ),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
      },
    };
  }

  function authenticate(
    options: { challenge: string; rpId?: string },
    {
      origin,
      uv,
      credential,
      badSignature = false,
    }: CeremonyOptions & {
      credential: SoftwareCredential;
      /** Signs the wrong bytes, as a different key would. */
      badSignature?: boolean;
    },
  ) {
    credential.counter += 1;
    const authData = Buffer.concat([
      sha256(Buffer.from(options.rpId ?? "")),
      Buffer.from([FLAG_UP | (uv ? FLAG_UV : 0)]),
      counterBytes(credential.counter),
    ]);
    const clientDataJSON = clientData(
      "webauthn.get",
      options.challenge,
      origin,
    );
    const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
    const signature = sign("sha256", signed, {
      key: credential.privateKey,
      dsaEncoding: "der",
    });
    if (badSignature) signature[signature.length - 1] ^= 0xff;

    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
    };
  }

  return { register, authenticate };
}
