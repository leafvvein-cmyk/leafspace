CREATE TABLE account_deletions (
  id uuid PRIMARY KEY,
  user_id uuid,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  receipt_digest text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  receipt_expires_at timestamptz,
  UNIQUE(user_id,request_id)
);
CREATE INDEX account_deletions_queue ON account_deletions(status,requested_at);
CREATE INDEX account_deletions_receipt_expiry ON account_deletions(receipt_expires_at) WHERE receipt_expires_at IS NOT NULL;
