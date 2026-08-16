-- Selfless CE — D1 schema (login, duty tracking, attendance)
-- Payments/finance tables have been removed as of this version.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('admin','student','tutor')),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','probation','internship')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS duties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'standard' CHECK(priority IN ('standard','urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  photo_base64 TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY(student_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_duties_student ON duties(student_id);
CREATE INDEX IF NOT EXISTS idx_duties_status ON duties(status);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
  note TEXT,
  marked_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(student_id) REFERENCES users(id),
  UNIQUE(student_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);

CREATE TABLE IF NOT EXISTS duty_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  checklist_json TEXT, -- JSON array of checklist item strings, e.g. ["Wash dishes","Wipe counters"]
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rota_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_type_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  week_start TEXT NOT NULL, -- ISO date, Monday of the assigned week
  status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','swap_requested','completed')),
  checklist_state TEXT, -- JSON array of booleans matching duty_types.checklist_json order
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

