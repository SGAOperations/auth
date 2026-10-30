import type { SgauthEnv } from "@/lib/env-schema";

// `dev` and `preview` share one text on purpose: the preview gate page must
// not reveal which pre-production environment it is.
export function EnvironmentBanner({ sgauthEnv }: { sgauthEnv: SgauthEnv }) {
  if (sgauthEnv === "production") return null;

  const isLocal = sgauthEnv === "local";
  return (
    <div
      role="note"
      aria-label="Environment notice"
      className="shrink-0 bg-warning px-4 py-2 text-center text-sm text-warning-foreground"
    >
      <span className="font-semibold tracking-wide">
        {isLocal ? "LOCAL ENVIRONMENT" : "DEVELOPMENT ENVIRONMENT"}
      </span>{" "}
      {isLocal
        ? "Test accounts only."
        : "Test accounts only. Real SGA accounts are at auth.northeasternsga.com."}
    </div>
  );
}
