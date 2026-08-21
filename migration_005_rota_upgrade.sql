-- Migration: upgrades the Duty Rota system —
-- from one assignment per duty type per week, to a full daily rotation
-- (Mon-Fri, each duty type) generated for a multi-week block in one click.
-- Also adds the student photo-proof → tutor/admin review workflow.
--
-- Run this ONCE against your existing database:
--   wrangler d1 execute selfless_finance --file=./migration_005_rota_upgrade.sql --remote

ALTER TABLE rota_assignments ADD COLUMN assignment_date TEXT NOT NULL DEFAULT '';
ALTER TABLE rota_assignments ADD COLUMN photo_base64 TEXT;
ALTER TABLE rota_assignments ADD COLUMN submitted_at TEXT;
ALTER TABLE rota_assignments ADD COLUMN review_status TEXT;
ALTER TABLE rota_assignments ADD COLUMN review_note TEXT;
ALTER TABLE rota_assignments ADD COLUMN reviewed_by INTEGER;
ALTER TABLE rota_assignments ADD COLUMN reviewed_at TEXT;

-- Backfill assignment_date for any existing rows from your old weekly-only rota
-- (uses the Monday of that week, since we don't know which day it was originally for).
UPDATE rota_assignments SET assignment_date = week_start WHERE assignment_date = '';

CREATE INDEX IF NOT EXISTS idx_rota_date ON rota_assignments(assignment_date);
