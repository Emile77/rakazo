-- Additive: a defaulted column the previous release never reads or writes.
ALTER TABLE "user_voice_credentials" ADD COLUMN IF NOT EXISTS "liveCalls" BOOLEAN NOT NULL DEFAULT false;
