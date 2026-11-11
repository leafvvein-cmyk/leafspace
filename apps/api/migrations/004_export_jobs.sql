CREATE TABLE export_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  options jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','cancelled','expired')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot_at timestamptz,
  expires_at timestamptz,
  error_code text,
  UNIQUE(user_id, request_id)
);
CREATE INDEX export_jobs_user_status ON export_jobs(user_id, status);
