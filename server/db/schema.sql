-- db/schema.sql — PostgreSQL schema for Collaborative Editor
-- Run: psql $POSTGRES_URL -f db/schema.sql

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url    VARCHAR(500),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Rooms ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(200) NOT NULL,
  language    VARCHAR(50)  NOT NULL DEFAULT 'python',
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Room Members ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_members (
  room_id     UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(20) DEFAULT 'editor',  -- owner | editor | viewer
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- ── Documents ────────────────────────────────────────────────
-- Stores current document state (latest snapshot).
-- Full op history is in MongoDB for efficient append.
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id     UUID UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  content     TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_rooms_owner       ON rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_room    ON documents(room_id);
