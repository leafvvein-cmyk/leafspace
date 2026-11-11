ALTER TABLE sessions ADD COLUMN recovery_onboarding BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE auth_operation_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id, request_id)
);
CREATE INDEX idx_auth_receipts_created ON auth_operation_receipts(created_at);
