PRAGMA foreign_keys = ON;

-- Every table uses text UUID ids + updated_at + device_id + deleted_at,
-- so a future cloud sync can merge records from several PCs without redesign.

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  doc_no TEXT,
  title TEXT NOT NULL,
  project TEXT,
  category TEXT,
  description TEXT,
  tags TEXT,
  current_rev TEXT,
  status TEXT,              -- last routing action, e.g. 'For Approval', 'Approved'
  location TEXT,            -- who/where the document is now, e.g. 'Mr. Sabanal', 'Accounting'
  location_since TEXT,      -- 'YYYY-MM-DD HH:MM' when it arrived there
  due_date TEXT,            -- expected back / action due date (red flag when passed)
  expiry_date TEXT,         -- optional: permits, certificates, plans that expire
  created_at TEXT,
  updated_at TEXT,
  device_id TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  rev TEXT,
  file_name TEXT,
  rel_path TEXT NOT NULL,   -- vault/ab/<sha256>.pdf inside the data folder
  sha256 TEXT NOT NULL,
  size INTEGER,
  notes TEXT,
  added_at TEXT,
  updated_at TEXT,
  device_id TEXT,
  deleted_at TEXT
);

-- The tracking history: every routing step plus system events.
CREATE TABLE IF NOT EXISTS movements (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT DEFAULT 'route', -- route | created | revision | edit
  at TEXT,                   -- 'YYYY-MM-DD HH:MM'
  action TEXT,
  from_loc TEXT,
  to_loc TEXT,
  due_date TEXT,
  remarks TEXT,
  by_user TEXT,
  updated_at TEXT,
  device_id TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_doc_loc ON documents(location);
CREATE INDEX IF NOT EXISTS idx_doc_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_doc_due ON documents(due_date);
CREATE INDEX IF NOT EXISTS idx_files_doc ON files(document_id);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_mov_doc ON movements(document_id, at);
