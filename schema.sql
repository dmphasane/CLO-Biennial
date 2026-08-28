-- NEDLO Biennial 2027 Stokvel Fund — Database Schema

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  conference_code TEXT NOT NULL,
  local_church TEXT,
  email TEXT,
  phone TEXT,
  accommodation_option TEXT NOT NULL,
  expected_monthly_total NUMERIC(12,2) DEFAULT 0,
  expected_accom NUMERIC(12,2) DEFAULT 0,
  expected_reg NUMERIC(12,2) DEFAULT 0,
  payment_ref TEXT NOT NULL,
  registration_date DATE DEFAULT CURRENT_DATE,
  room_number TEXT,
  hotel_room TEXT,
  room_partner TEXT,
  ledger JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_members_ref ON members(payment_ref);
CREATE INDEX IF NOT EXISTS idx_members_conf ON members(conference_code);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  txn_date TEXT,
  val_date TEXT,
  description TEXT,
  reference_raw TEXT,
  reference_norm TEXT,
  credit_amount NUMERIC(12,2) DEFAULT 0,
  contrib_month TEXT,
  match_status TEXT DEFAULT 'UNMATCHED',
  linked_member_id TEXT,
  allocated_accom NUMERIC(12,2) DEFAULT 0,
  allocated_reg NUMERIC(12,2) DEFAULT 0,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_member ON entries(linked_member_id);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(match_status);
CREATE INDEX IF NOT EXISTS idx_entries_dedup ON entries(txn_date, credit_amount, reference_norm);

CREATE TABLE IF NOT EXISTS ref_aliases (
  ref_norm TEXT PRIMARY KEY,
  member_id TEXT,
  member_ids JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  user_name TEXT,
  role TEXT,
  action TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
