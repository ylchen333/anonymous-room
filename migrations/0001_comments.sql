CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  scene TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('scene', 'segment', 'highlight')),
  scope_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'anonymous',
  message TEXT NOT NULL,
  highlight_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_scope_created
  ON comments (scene, scope_type, scope_id, created_at);
