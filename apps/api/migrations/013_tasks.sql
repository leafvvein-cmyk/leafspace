CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 5000),
  due_at timestamptz,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  recurrence jsonb,
  reminder_minutes_before integer CHECK (reminder_minutes_before BETWEEN 0 AND 40320),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  linked_entry_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','trash')),
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE(user_id,id)
);
CREATE INDEX tasks_list ON tasks(user_id,status,due_at NULLS LAST,created_at,id);
CREATE INDEX tasks_series ON tasks(user_id,series_id,created_at);

CREATE TABLE task_actions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  task_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('internal','https','external_app')),
  action_key text NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  UNIQUE(user_id,task_id,id),
  UNIQUE(user_id,task_id,position),
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id) ON DELETE CASCADE
);

CREATE TABLE task_request_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  PRIMARY KEY(user_id,request_id)
);
CREATE INDEX task_request_receipts_expiry ON task_request_receipts(expires_at);
