import { PrismaClient } from "@prisma/client";

// Single Prisma client across hot reloads in dev (Next.js re-evaluates modules).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
