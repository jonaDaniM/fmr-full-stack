-- Per-project import profiles.
--
-- Everything that varies between projects is a list of column headings, not
-- logic. Until now those lived as JSON files beside the code, so adding a
-- project meant a developer and a deploy — and on Cloud Run the container
-- filesystem is ephemeral, so a profile saved through a screen would vanish
-- on the next deploy.
--
-- The files remain as the built-in baselines. A row here overrides one for a
-- single project.
--
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS import_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- What a person picks from on the import screen.
  name         text NOT NULL,
  description  text,

  -- The profile itself: headerSearchRows, header aliases, column aliases,
  -- stopPatterns and the rest. Same shape as profiles/default.json, because
  -- it is read by the same engine.
  definition   jsonb NOT NULL,

  -- The baseline this was copied from, so a screen can say what it started as.
  based_on     text NOT NULL DEFAULT 'default',

  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Two profiles with the same name in one project cannot be told apart on a
  -- dropdown.
  CONSTRAINT import_profile_name_unique UNIQUE (project_id, name),
  CONSTRAINT import_profile_name_present CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS import_profiles_project_idx
  ON import_profiles (project_id, name);

-- Which profile an import actually used. Without this, a batch staged months
-- ago cannot be explained once the profile has been edited.
ALTER TABLE import_batches
  ADD COLUMN IF NOT EXISTS profile_definition jsonb;
