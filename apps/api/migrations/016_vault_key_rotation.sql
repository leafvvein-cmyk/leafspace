CREATE TABLE vault_key_rotations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  base_config_revision bigint NOT NULL,
  expected_item_count integer NOT NULL CHECK (expected_item_count BETWEEN 0 AND 10000),
  new_config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id,id)
);
CREATE INDEX vault_key_rotations_expiry ON vault_key_rotations(expires_at);

CREATE TABLE vault_key_rotation_items (
  user_id uuid NOT NULL,
  rotation_id uuid NOT NULL,
  item_id uuid NOT NULL,
  base_revision bigint NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  crypto_version integer NOT NULL,
  PRIMARY KEY (user_id,rotation_id,item_id),
  FOREIGN KEY (user_id,rotation_id) REFERENCES vault_key_rotations(user_id,id) ON DELETE CASCADE
);
