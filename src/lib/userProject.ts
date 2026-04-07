"use server";
import { prisma } from "@/lib/prisma";

async function createUserProject(userId: string, projectId: string) {
    const existing = await prisma.userProject.findUnique({ where: { userId_projectId: { userId, projectId, deletedAt: null } }});
    if (existing) {
        throw new Error("User project already exists");
    }
    return await prisma.userProject.upsert({
        where: { userId_projectId: { userId, projectId } },
        update: {deletedAt: null},
        create: { userId, projectId } });
}

async function getUserProject(userId: string, projectId: string) { 
    return await prisma.userProject.findUnique({
        where: { userId_projectId: { userId, projectId, deletedAt: null } } }
    );
}
    

async function getUserProjects({userId, projectId}: { userId?: string, projectId?: string }) {
    return await prisma.userProject.findMany({
        where: { userId, projectId, deletedAt: null },
    });
}

async function removeUserFromProject(userId: string, projectId: string) {
    return await prisma.userProject.update({
        where: { userId_projectId: { userId, projectId, deletedAt: null } },
        data: { deletedAt: new Date() }
    });
}
