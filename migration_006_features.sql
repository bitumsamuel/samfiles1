-- Migration 006: Grade & Progress Tracker, Student Alarms, Review Notifications,
-- Profile Photos, and archivable duty/rota history.
--
-- Run this ONCE against your existing database:
--   wrangler d1 execute selfless_finance --file=./migration_006_features.sql --remote

ALTER TABLE users ADD COLUMN profile_photo TEXT;
ALTER TABLE duties ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rota_assignments ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_name TEXT NOT NULL,
  grade TEXT,                    -- e.g. "A", "88%", "Pass"
  progress_percent INTEGER CHECK(progress_percent BETWEEN 0 AND 100),
  updated_by INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(student_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);

CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  time TEXT NOT NULL,                -- "HH:MM", 24hr
  days_json TEXT NOT NULL DEFAULT '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(student_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_alarms_student ON alarms(student_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,          -- recipient: an admin or tutor
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  related_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
