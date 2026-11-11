CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username_normalized varchar(32) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  profile_revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleting','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_state (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  generation uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  installation_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web','android','ios')),
  name varchar(80) NOT NULL,
  refresh_hash text NOT NULL UNIQUE,
  refresh_family uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE used_refresh_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  code_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE TABLE reauth_tokens (
  token_digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  scope text NOT NULL,
  target_key text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('daily','moment')),
  entry_date date NOT NULL,
  timezone text NOT NULL,
  occurred_at timestamptz,
  title text NOT NULL,
  content_schema_version integer NOT NULL CHECK (content_schema_version=1),
  content jsonb NOT NULL,
  plain_text text NOT NULL,
  mood smallint CHECK (mood BETWEEN 1 AND 5),
  revision bigint NOT NULL DEFAULT 1,
  sort_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  UNIQUE(user_id,id),
  CHECK (kind='daily' OR occurred_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_daily_per_date ON entries(user_id,entry_date) WHERE kind='daily' AND deleted_at IS NULL;
CREATE INDEX entries_timeline ON entries(user_id,entry_date DESC,sort_at DESC,id DESC);
CREATE INDEX entries_trash_expiry ON entries(purge_after) WHERE deleted_at IS NOT NULL;
CREATE INDEX entries_plain_search ON entries USING gin(plain_text gin_trgm_ops);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  normalized_name text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  UNIQUE(user_id,id),
  UNIQUE(user_id,normalized_name)
);
CREATE TABLE entry_tags (
  user_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  PRIMARY KEY(user_id,entry_id,tag_id),
  FOREIGN KEY(user_id,entry_id) REFERENCES entries(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,tag_id) REFERENCES tags(user_id,id) ON DELETE CASCADE
);
CREATE INDEX entry_tags_by_tag ON entry_tags(user_id,tag_id,entry_id);

CREATE TABLE sync_events (
  user_id uuid NOT NULL REFERENCES users(id),
  seq bigint NOT NULL,
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,seq)
);
CREATE INDEX sync_events_retention ON sync_events(created_at);

CREATE TABLE mutation_receipts (
  user_id uuid NOT NULL REFERENCES users(id),
  mutation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  PRIMARY KEY(user_id,mutation_id)
);

CREATE TABLE entry_tombstones (
  user_id uuid NOT NULL REFERENCES users(id),
  entry_id uuid NOT NULL,
  final_revision bigint NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,entry_id)
);

CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  value jsonb NOT NULL DEFAULT '{"theme":"system","fontFamily":"sans","fontSize":18,"editorWidth":760}'::jsonb,
  revision bigint NOT NULL DEFAULT 1
);

CREATE TABLE auth_rate_limits (
  bucket text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
