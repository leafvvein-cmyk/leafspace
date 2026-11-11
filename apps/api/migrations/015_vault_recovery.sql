ALTER TABLE vault_configs
  ADD COLUMN recovery_wrapped_key text,
  ADD COLUMN recovery_nonce text,
  ADD COLUMN recovery_version integer;

ALTER TABLE vault_configs ADD CONSTRAINT vault_recovery_complete CHECK (
  (recovery_wrapped_key IS NULL AND recovery_nonce IS NULL AND recovery_version IS NULL)
  OR (recovery_wrapped_key IS NOT NULL AND recovery_nonce IS NOT NULL AND recovery_version = 1)
);
