CREATE TABLE account_deletion_ledger (
  user_id uuid PRIMARY KEY,
  deletion_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('requested','completed')),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX account_deletion_ledger_completed ON account_deletion_ledger(completed_at) WHERE status='completed';
