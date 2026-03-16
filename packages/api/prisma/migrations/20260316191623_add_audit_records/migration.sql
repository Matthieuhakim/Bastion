-- CreateTable
CREATE TABLE "audit_records" (
    "id" BIGSERIAL NOT NULL,
    "agent_id" TEXT NOT NULL,
    "record_json" JSONB NOT NULL,
    "record_hash" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "signer_key_fingerprint" TEXT NOT NULL,
    "previous_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_records_agent_id_created_at_idx" ON "audit_records"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_records_agent_id_id_idx" ON "audit_records"("agent_id", "id");
