"use server";

// TODO(auth): none of these actions check caller identity/authority yet.
// Add an authorization check (self-access or User.isAdmin) once session
// infra lands (see #3 / auth-11's createServerSupabaseClient) — track in
// a follow-up ticket before this is wired into any client component.

import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { User } from "@/generated/prisma/client";

/**
 * Creates a new User linked to a pre-existing Supabase auth user
 * @param supabaseUserId Supabase UID
 * @returns The created User
 */
export async function createUser(supabaseUserId: string): Promise<User> {
  const { error } = await supabaseAdmin.auth.admin.getUserById(supabaseUserId);

  if (error) {
    throw new Error("Supabase auth user not found");
  }

  return prisma.user.create({ data: { supabaseUserId } });
}

/**
 * Gets a User by ID, optionally including their Supabase auth email
 * @param id User UUID to lookup
 * @param includeEmail Whether to include the user's auth email
 * @returns The fetched User, with email if requested
 * @throws If the User is not found or if there's an error fetching the email
 */
export async function getUser(
  id: string,
  includeEmail?: boolean,
): Promise<User & { email?: string }> {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new Error("User not found");
  }

  if (!includeEmail) {
    return user;
  }

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(
    user.supabaseUserId,
  );

  if (error) {
    console.error("Failed to fetch Supabase auth user email", error);
    throw new Error("Failed to fetch user email");
  }

  return { ...user, email: data.user.email };
}

/**
 * Gets all users with filters
 * @param filters An optional filter by isAdmin status
 * @returns The list of Users
 */
export async function getUsers(filters?: {
  isAdmin?: boolean;
}): Promise<User[]> {
  return prisma.user.findMany({
    where: { isAdmin: filters?.isAdmin },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Updates User fields by ID
 * @param id User UUID to update
 * @param data The data to update (e.g. isAdmin status)
 * @returns The updated User
 */
export async function updateUser(
  id: string,
  data: { isAdmin?: boolean },
): Promise<User> {
  const { isAdmin } = data;
  return prisma.user.update({ where: { id }, data: { isAdmin } });
}

/**
 * Deletes a User by ID. Hard deletes all related data in a transaction first,
 * then deletes the linked Supabase auth user.
 * @param id User UUID to delete
 * @throws If the User is not found, or the Supabase auth user deletion fails
 */
export async function deleteUser(id: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new Error("User not found");
  }

  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId: id } }),
    prisma.userProject.deleteMany({ where: { userId: id } }),
    prisma.user.delete({ where: { id } }),
  ]);

  const { error } = await supabaseAdmin.auth.admin.deleteUser(
    user.supabaseUserId,
  );

  if (error) {
    console.error("Failed to delete Supabase auth user", error);
    throw new Error("Failed to delete Supabase auth user");
  }
}
