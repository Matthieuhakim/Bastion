-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "allowed_actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "denied_actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "constraints" JSONB,
    "requires_approval_above" DOUBLE PRECISION,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "agent_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
