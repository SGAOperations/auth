// Pure on purpose: no `server-only` and no env reads, so it loads in Vitest.

export interface PostHogSettings {
  key: string;
  host: string;
}

interface PostHogSettingsInput {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_DISABLED?: "true" | "false";
  NODE_ENV?: string;
}

/**
 * The PostHog client settings, or null when capture must stay off: the
 * disable flag is on, the process is a test run (Vitest can never send), or
 * the key or host is unset.
 */
export function resolvePostHogSettings(
  input: PostHogSettingsInput,
): PostHogSettings | null {
  if (input.POSTHOG_DISABLED === "true") return null;
  if (input.NODE_ENV === "test") return null;
  if (!input.POSTHOG_KEY || !input.POSTHOG_HOST) return null;
  return { key: input.POSTHOG_KEY, host: input.POSTHOG_HOST };
}
