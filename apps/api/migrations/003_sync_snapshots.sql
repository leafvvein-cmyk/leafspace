CREATE TABLE snapshots (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  generation uuid,
  baseline_seq bigint,
  record_count bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot_at timestamptz,
  expires_at timestamptz,
  UNIQUE(user_id,request_id)
);
CREATE INDEX snapshots_queue ON snapshots(status,created_at);
CREATE INDEX snapshots_expiry ON snapshots(expires_at);
CREATE TABLE snapshot_records (
  snapshot_id uuid NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY(snapshot_id,ordinal)
);
