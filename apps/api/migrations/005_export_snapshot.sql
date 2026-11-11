ALTER TABLE export_jobs ADD COLUMN record_count bigint NOT NULL DEFAULT 0;
CREATE TABLE export_records (
  job_id uuid NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  ordinal bigint NOT NULL,
  entry_id uuid NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY(job_id, ordinal),
  UNIQUE(job_id, entry_id)
);
