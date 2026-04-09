"use server";

import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import type { User } from "@/generated/prisma/client";

/**
 * Creates a new User linked to a pre-existing Supabase auth user
 * @param supabaseUserId Supabase UID
 * @returns The created User
 */
export async function createUser(supabaseUserId: string): Promise<User> {
  const { error } =
    await supabaseAdmin.auth.admin.getUserById(supabaseUserId);

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
  includeEmail?: boolean
): Promise<User & { email?: string }> {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new Error("User not found");
  }

  if (!includeEmail) {
    return user;
  }

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(
    user.supabaseUserId
  );

  if (error) {
    throw new Error(error.message);
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
    where: filters,
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
  data: { isAdmin?: boolean }
): Promise<User> {
  return prisma.user.update({ where: { id }, data });
}

/**
 * Deletes a User by ID. Attempts to delete the linked Supabase auth user first, 
 * then hard deletes all related data in a transaction
 * @param id User UUID to delete
 * @throws If the User is not found, or the Supabase auth user deletion fails
 */
export async function deleteUser(id: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new Error("User not found");
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(
    user.supabaseUserId
  );

  if (error) {
    throw new Error("Failed to delete Supabase auth user");
  }

  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId: id } }),
    prisma.userProject.deleteMany({ where: { userId: id } }),
    prisma.user.delete({ where: { id } }),
  ]);
}
