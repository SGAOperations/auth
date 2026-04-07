"use server";
import { prisma } from "@/lib/prisma";

async function createUserProject(userId: string, projectId: string) {
    const existing = await prisma.userProject.findUnique({
        where: { userId_projectId: { userId, projectId } }
    });
    if (existing) {
        throw new Error("User project already exists");
    }
    return await prisma.userProject.create({ data: { userId, projectId } });
}

async function getUserProject(userId: string, projectId: string) {
    return await prisma.userProject.findUnique({
        where: { userId_projectId: { userId, projectId } }
    });
}

async function getUserProjects(filters?: { userId?: string, projectId?: string }) {
    return await prisma.userProject.findMany({
        where: filters ,
    });
}

async function deleteUserProject(userId: string, projectId: string) {
    return await prisma.userProject.delete({
        where: { userId_projectId: { userId, projectId } }
    });
}