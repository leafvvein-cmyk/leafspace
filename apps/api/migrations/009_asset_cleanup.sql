ALTER TABLE assets ADD COLUMN orphaned_at timestamptz DEFAULT now();
UPDATE assets a SET orphaned_at=NULL
WHERE EXISTS (SELECT 1 FROM entry_assets ea WHERE ea.user_id=a.user_id AND ea.asset_id=a.id);
CREATE INDEX assets_orphan_cleanup ON assets(orphaned_at,id) WHERE orphaned_at IS NOT NULL;
