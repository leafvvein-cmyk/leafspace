CREATE TABLE entry_purge_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('purge_entry','purge_entries')),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  PRIMARY KEY(user_id,session_id,request_id)
);
CREATE INDEX entry_purge_receipts_expiry ON entry_purge_receipts(expires_at);
