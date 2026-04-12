"use server";

import "server-only";

import { prisma } from "@/lib/prisma";

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
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Project name is required");
  }

  const apiKey = generateApiKey();
  const project = await prisma.project.create({
    data: {
      name: trimmed,
      description: description?.trim() || null,
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
  const project = await prisma.project.findUnique({ where: { id } });
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
  const hasName = data.name !== undefined;
  const hasDescription = data.description !== undefined;
  if (!hasName && !hasDescription) {
    throw new Error("No fields to update");
  }

  const updatePayload: { name?: string; description?: string | null } = {};
  if (hasName) {
    const trimmed = data.name!.trim();
    if (!trimmed) {
      throw new Error("Project name cannot be empty");
    }
    updatePayload.name = trimmed;
  }
  if (hasDescription) {
    updatePayload.description =
      data.description === null || data.description === ""
        ? null
        : data.description!.trim() || null;
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data: updatePayload,
    });
    return toMasked(project);
  } catch {
    return null;
  }
}

/**
 * Removes related sessions and user–project links.
 */
export async function deleteProject(id: string): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { projectId: id } });
      await tx.userProject.deleteMany({ where: { projectId: id } });
      await tx.project.delete({ where: { id } });
    });
    return true;
  } catch {
    return false;
  }
}

/** Regenerates the API key; returns the full new key once. */
export async function resetProjectAPIKey(
  id: string,
): Promise<ProjectWithApiKey | null> {
  const apiKey = generateApiKey();
  try {
    const project = await prisma.project.update({
      where: { id },
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
