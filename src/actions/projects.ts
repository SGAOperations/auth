"use server";

import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

const idSchema = z.uuid("Invalid project id");

const nameSchema = z
  .string()
  .trim()
  .min(1, "Project name is required")
  .max(
    NAME_MAX_LENGTH,
    `Project name must be ${NAME_MAX_LENGTH} characters or fewer`,
  );

/** Trims, then collapses empty strings to null so blank input clears the field. */
const descriptionSchema = z
  .string()
  .trim()
  .max(
    DESCRIPTION_MAX_LENGTH,
    `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`,
  )
  .nullable()
  .transform((value) => value || null);

const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: "No fields to update",
  });

function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(result.error.issues[0].message);
  }
  return result.data;
}

/** True only for Prisma's "record does not exist" error, so real failures stay loud. */
function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  apiKey: string;
  createdAt: Date;
  updatedAt: Date;
};

function generateApiKey(): string {
  return crypto.randomUUID();
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return "•".repeat(apiKey.length);
  }
  return `•••••••••••••••••••••••••••••••••${apiKey.slice(-4)}`;
}

function toMasked(project: ProjectRow): ProjectMasked {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    apiKeyMasked: maskApiKey(project.apiKey),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export type ProjectMasked = {
  id: string;
  name: string;
  description: string | null;
  apiKeyMasked: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectWithApiKey = {
  id: string;
  name: string;
  description: string | null;
  apiKey: string;
  createdAt: Date;
  updatedAt: Date;
};

export type UpdateProjectData = {
  name?: string;
  description?: string | null;
};

/** Registers an external app; returns the full API key once. */
export async function createProject(
  name: string,
  description: string | null,
): Promise<ProjectWithApiKey> {
  const parsedName = parseOrThrow(nameSchema, name);
  const parsedDescription = parseOrThrow(
    descriptionSchema,
    description ?? null,
  );

  const apiKey = generateApiKey();
  const project = await prisma.project.create({
    data: {
      name: parsedName,
      description: parsedDescription,
      apiKey,
    },
  });

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    apiKey: project.apiKey,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/** Single project; API key is masked. */
export async function getProject(id: string): Promise<ProjectMasked | null> {
  const parsedId = parseOrThrow(idSchema, id);
  const project = await prisma.project.findUnique({ where: { id: parsedId } });
  if (!project) return null;
  return toMasked(project);
}

/** All projects; API keys masked. */
export async function getProjects(): Promise<ProjectMasked[]> {
  const projects = await prisma.project.findMany({
    orderBy: { name: "asc" },
  });
  return projects.map(toMasked);
}

/** Updates name and/or description only. */
export async function updateProject(
  id: string,
  data: UpdateProjectData,
): Promise<ProjectMasked | null> {
  const parsedId = parseOrThrow(idSchema, id);
  const parsed = parseOrThrow(updateProjectSchema, data);

  const updatePayload: { name?: string; description?: string | null } = {};
  if (parsed.name !== undefined) {
    updatePayload.name = parsed.name;
  }
  if (parsed.description !== undefined) {
    updatePayload.description = parsed.description;
  }

  try {
    const project = await prisma.project.update({
      where: { id: parsedId },
      data: updatePayload,
    });
    return toMasked(project);
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}

/**
 * Removes related sessions and user–project links.
 */
export async function deleteProject(id: string): Promise<boolean> {
  const parsedId = parseOrThrow(idSchema, id);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { projectId: parsedId } });
      await tx.userProject.deleteMany({ where: { projectId: parsedId } });
      await tx.project.delete({ where: { id: parsedId } });
    });
    return true;
  } catch (error) {
    if (isRecordNotFound(error)) return false;
    throw error;
  }
}

/** Regenerates the API key; returns the full new key once. */
export async function resetProjectAPIKey(
  id: string,
): Promise<ProjectWithApiKey | null> {
  const parsedId = parseOrThrow(idSchema, id);
  const apiKey = generateApiKey();
  try {
    const project = await prisma.project.update({
      where: { id: parsedId },
      data: { apiKey },
    });
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      apiKey: project.apiKey,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  } catch {
    return null;
  }
}
