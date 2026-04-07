"use server";

import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import type { User } from "@/generated/prisma/client";

export async function createUser(supabaseUserId: string): Promise<User> {
  const { error } =
    await supabaseAdmin.auth.admin.getUserById(supabaseUserId);

  if (error) {
    throw new Error("Supabase auth user not found");
  }

  return prisma.user.create({ data: { supabaseUserId } });
}

export async function getUser(
  id: string,
  options?: { includeEmail?: boolean }
): Promise<User & { email?: string }> {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new Error("User not found");
  }

  if (!options?.includeEmail) {
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

export async function getUsers(filters?: {
  isAdmin?: boolean;
}): Promise<User[]> {
  return prisma.user.findMany({
    where: filters,
    orderBy: { createdAt: "desc" },
  });
}

export async function updateUser(
  id: string,
  data: { isAdmin?: boolean }
): Promise<User> {
  return prisma.user.update({ where: { id }, data });
}

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
