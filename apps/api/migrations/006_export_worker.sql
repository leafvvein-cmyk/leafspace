ALTER TABLE export_jobs ADD COLUMN lease_token uuid;
ALTER TABLE export_jobs ADD COLUMN lease_until timestamptz;
ALTER TABLE export_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE export_jobs ADD COLUMN output_key text;
