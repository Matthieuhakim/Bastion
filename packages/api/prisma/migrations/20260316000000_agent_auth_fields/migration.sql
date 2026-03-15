-- DropIndex
DROP INDEX "agents_api_key_key";

-- AlterTable
ALTER TABLE "agents" DROP COLUMN "api_key",
ADD COLUMN     "api_key_hash" TEXT NOT NULL,
ADD COLUMN     "callback_url" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "encrypted_private_key" TEXT NOT NULL,
ADD COLUMN     "key_fingerprint" TEXT NOT NULL,
ADD COLUMN     "public_key" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "agents_api_key_hash_key" ON "agents"("api_key_hash");
