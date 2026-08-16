-- Migration: adds the Duty Rota & Accountability system —
-- weekly rotating duty assignments, swap requests, announcements,
-- and a student status tag (active/probation/internship).
--
-- Run this ONCE against your existing database:
--   wrangler d1 execute selfless_finance --file=./migration_004_duty_rota.sql --remote

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS duty_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  checklist_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rota_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_type_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','swap_requested','completed')),
  checklist_state TEXT,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  rated_by INTEGER,
  rated_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(duty_type_id) REFERENCES duty_types(id),
  FOREIGN KEY(student_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_rota_week ON rota_assignments(week_start);
CREATE INDEX IF NOT EXISTS idx_rota_student ON rota_assignments(student_id);

CREATE TABLE IF NOT EXISTS swap_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  requested_by INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','cancelled')),
  accepted_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY(assignment_id) REFERENCES rota_assignments(id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
