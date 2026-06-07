-- scripts/migrations/0010_account_workspace_name.sql
-- Applied by the migration runner: npm run migrate
--
-- Multi-Notion portal UI — give each connected Notion workspace a HUMAN-READABLE
-- display name so the portal can list "Cérebro do Bruno" instead of the opaque
-- workspace UUID. Additive + idempotent: a nullable column on the existing
-- account_workspaces table; nothing is dropped, existing rows keep name NULL
-- (the portal falls back to the id until the next connect/re-auth writes a name).
ALTER TABLE account_workspaces ADD COLUMN IF NOT EXISTS name text;
