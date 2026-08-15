-- Migration: adds account-approval support for self-signup.
-- Run this ONCE against your existing database (schema.sql alone won't add this
-- column to a table that already exists — ALTER TABLE isn't safely re-runnable).
--
--   wrangler d1 execute selfless_finance --file=./migration_002_approved.sql --remote
--
-- Existing accounts (created by an admin) are marked approved=1 automatically,
-- so nobody who already has a working login gets locked out.

ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
