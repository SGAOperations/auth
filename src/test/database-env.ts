export type TestDatabase = { databaseUrl: string; directUrl: string };

const MISSING =
  'TEST_DATABASE_URL and TEST_DIRECT_URL must point at a personal Neon branch (see CONTRIBUTING.md "Running tests"), or run npm run test:unit';
const SAME_AS_APP =
  "TEST_* must not equal the app's DATABASE_URL/DIRECT_URL: the test run deletes rows from every table";
const DIFFERENT_ENDPOINTS =
  "TEST_DATABASE_URL and TEST_DIRECT_URL point at different endpoints";

/** Host with `-pooler` removed from the first label, so a pooled and a direct URL of one endpoint compare equal. */
function endpointHost(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const [first, ...rest] = hostname.split(".");
    return [first.replace(/-pooler$/, ""), ...rest].join(".");
  } catch {
    return null;
  }
}

/**
 * Resolves the database the db test project runs against. Throws on a missing,
 * app-shared or mismatched pair. Messages name variables only, never values.
 */
export function resolveTestDatabase(
  env: Record<string, string | undefined>,
): TestDatabase {
  const databaseUrl = env.TEST_DATABASE_URL;
  const directUrl = env.TEST_DIRECT_URL;
  if (!databaseUrl || !directUrl) throw new Error(MISSING);

  if (databaseUrl === env.DATABASE_URL || directUrl === env.DIRECT_URL) {
    throw new Error(SAME_AS_APP);
  }

  const pooledHost = endpointHost(databaseUrl);
  const directHost = endpointHost(directUrl);
  if (pooledHost === null || directHost === null) {
    throw new Error(
      "TEST_DATABASE_URL and TEST_DIRECT_URL must both be valid URLs",
    );
  }
  if (pooledHost !== directHost) throw new Error(DIFFERENT_ENDPOINTS);

  return { databaseUrl, directUrl };
}
