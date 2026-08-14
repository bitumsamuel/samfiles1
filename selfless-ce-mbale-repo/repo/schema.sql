-- Selfless CE Finance Tracker — D1 schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('admin','student','tutor')),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  momo_number TEXT,
  bank_name TEXT,
  bank_account TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('student','tutor')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  method TEXT NOT NULL CHECK(method IN ('momo','bank')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','paid','failed')),
  reference TEXT,
  note TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  FOREIGN KEY(recipient_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_payments_recipient ON payments(recipient_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
