import { disconnect, seedUsers } from "./support/db";

export default async function globalSetup(): Promise<void> {
  if (process.env.SGAUTH_ENV !== "local") {
    throw new Error('Refusing to run e2e fixtures: SGAUTH_ENV must be "local"');
  }
  try {
    await seedUsers();
  } finally {
    await disconnect();
  }
}
