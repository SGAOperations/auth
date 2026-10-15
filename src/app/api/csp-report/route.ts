import { parseCspReports } from "@/lib/security/csp-report";

export const runtime = "nodejs";

const ACCEPTED_TYPES = [
  "application/csp-report",
  "application/reports+json",
  "application/json",
];
const MAX_BYTES = 16 * 1024;

// Reads the body as a stream and gives up once it passes MAX_BYTES, so a
// chunked request with no Content-Length cannot be buffered whole.
async function readBounded(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Unauthenticated on purpose: browsers send reports without credentials and
// no reliable Origin. This is the sanctioned exception to the Origin rule in
// docs/ENGINEERING.md section 3. The only effect is a redacted log line.
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES.includes(mediaType)) {
    return new Response(null, { status: 415 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return new Response(null, { status: 413 });
  }

  const text = await readBounded(request);
  if (text === null) return new Response(null, { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  const violations = parseCspReports(json);
  if (violations === null) return new Response(null, { status: 400 });

  for (const violation of violations) {
    console.warn(JSON.stringify({ event: "csp_violation", ...violation }));
  }
  return new Response(null, { status: 204 });
}
