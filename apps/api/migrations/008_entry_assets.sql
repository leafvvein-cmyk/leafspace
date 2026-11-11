CREATE TABLE entry_assets (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  PRIMARY KEY(user_id,entry_id,asset_id),
  FOREIGN KEY(user_id,entry_id) REFERENCES entries(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,asset_id) REFERENCES assets(user_id,id) ON DELETE RESTRICT
);
CREATE INDEX entry_assets_asset ON entry_assets(user_id,asset_id);
