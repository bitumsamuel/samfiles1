-- Migration: removes the finance/payments feature entirely, including all
-- existing payment records and the momo/bank columns on users.
--
-- Run this ONCE against your existing database:
--   wrangler d1 execute selfless_finance --file=./migration_003_remove_payments.sql --remote
--
-- This permanently deletes payment history. Make sure that's really what you want
-- before running it — there's no undo.

DROP TABLE IF EXISTS payments;

ALTER TABLE users DROP COLUMN momo_number;
ALTER TABLE users DROP COLUMN bank_name;
ALTER TABLE users DROP COLUMN bank_account;
