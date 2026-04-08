"use server";
import { prisma } from "./prisma";
import crypto from "crypto";


function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex"); // 64-char token
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export type GetSessionsFilters = {
  userId?: string;
  projectId?: string;
};

export type UpdateSessionData = {
  expiresAt?: Date;
};

/**
 * Creates a new session with a userId and projectId
 * @param userId The userId of the user for the session
 * @param projectId The projectId of the project for the session
 * @returns The created session
 */
export async function createSession(userId: string, projectId: string) {
  const rawToken = generateSessionToken();
  const hashedToken = hashToken(rawToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 1); // 1 day
  const session = prisma.session.create({
    data: {
      userId,
      projectId,
      token: hashedToken,
      expiresAt,
    }
  })
  return {
    ...session,
    token: rawToken,
  }
}

/**
 * Gets a session based on a session id
 * @param id The session id
 * @returns The session
 */
export const getSession = async (id: string) =>
  prisma.session.findUnique({ where: { id, expiresAt: { gt: new Date() }, } });

/**
 * Gets all sessions by filter
 * @param filters userId and projectId
 * @returns All sessions associated with the filters
 */
export async function getSessions(filters: {
  userId: string;
  projectId: string;
}) {
  const sessions = await prisma.session.findMany({
    where: { ...(filters?.userId &&  { userId: filters.userId }),
             ...(filters?.projectId &&  { projectId: filters.projectId }),
             expiresAt: {
                gt: new Date(), // only active sessions
            },
        },
        orderBy: {
      createdAt: "desc",
    },
  });

  if (!sessions) return null;

  return sessions;
}

/**
 * Updates a session to extend the expireAt
 * @param id The session id
 * @param data When the new expireAt should be
 * @returns The updated session
 */
export async function updateSession(id: string, data: { expiresAt: Date }) {
  const newExpiry = data.expiresAt;

  const session = await prisma.session.findUnique({
    where: { id },
  });

  if (!session) return null;

  // don't extend expired sessions
  if (session.expiresAt < new Date()) {
    return null;
  }
  return prisma.session.update({
    where: { id },
    data: {
      expiresAt: newExpiry,
    },
  });
}

/**
 * Deletes a session
 * @param id The session id
 * @returns If the delete was successful
 */
export const deleteSession = async (id: string) =>
  prisma.session.delete({ where: { id } });

/**
 * Validates a session based on a token and project
 * @param token The token associated with the session
 * @param projectId The projectId associated with a project
 * @returns a session
 */
export async function validateSession(token: string, projectId: string){
  const hashedToken = hashToken(token);
  return prisma.session.findFirst({
    where: {
      token: hashedToken,
      projectId,
      expiresAt: {
        gt: new Date(),
      },
    },
  });
}
