CREATE TABLE vault_configs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf jsonb NOT NULL,
  salt text NOT NULL,
  wrapped_key text NOT NULL,
  wrap_nonce text NOT NULL,
  crypto_version integer NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  crypto_version integer NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY(user_id,id)
);
CREATE INDEX vault_items_sync ON vault_items(user_id,updated_at,id);

CREATE TABLE vault_request_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  PRIMARY KEY(user_id,request_id)
);
CREATE INDEX vault_request_receipts_expiry ON vault_request_receipts(expires_at);
