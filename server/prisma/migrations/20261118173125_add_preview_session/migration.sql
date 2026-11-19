-- CreateEnum
CREATE TYPE "PreviewStatus" AS ENUM ('PENDING', 'FETCHING', 'BUILDING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FrameworkType" AS ENUM ('STATIC', 'VITE_REACT', 'REACT', 'UNKNOWN');

-- CreateTable
CREATE TABLE "PreviewSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "status" "PreviewStatus" NOT NULL DEFAULT 'PENDING',
    "framework" "FrameworkType" NOT NULL DEFAULT 'UNKNOWN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenHash" TEXT NOT NULL,
    "previewTokenEnc" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "runnerContainerId" TEXT,
    "proxyContainerId" TEXT,
    "proxyPort" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "PreviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewSession_tokenHash_key" ON "PreviewSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PreviewSession_userId_idx" ON "PreviewSession"("userId");

-- CreateIndex
CREATE INDEX "PreviewSession_repositoryId_idx" ON "PreviewSession"("repositoryId");

-- CreateIndex
CREATE INDEX "PreviewSession_status_idx" ON "PreviewSession"("status");

-- CreateIndex
CREATE INDEX "PreviewSession_isActive_expiresAt_idx" ON "PreviewSession"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "PreviewSession_isActive_lastActiveAt_idx" ON "PreviewSession"("isActive", "lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "PreviewSession_userId_key" ON "PreviewSession"("userId") WHERE ("isActive" = true);

-- AddForeignKey
ALTER TABLE "PreviewSession" ADD CONSTRAINT "PreviewSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreviewSession" ADD CONSTRAINT "PreviewSession_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
-- Enforces absolute database consistency: isActive must be true for active statuses and false for terminal statuses.
ALTER TABLE "PreviewSession" ADD CONSTRAINT "preview_session_status_is_active_check" CHECK (
    ("isActive" = true AND "status" IN ('PENDING', 'FETCHING', 'BUILDING', 'STARTING', 'RUNNING', 'STOPPING'))
    OR
    ("isActive" = false AND "status" IN ('STOPPED', 'FAILED', 'EXPIRED'))
);

