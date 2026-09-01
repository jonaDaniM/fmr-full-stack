-- Manual FMR drafts.
--
-- An FMR can arrive two ways: parsed from a workbook, or typed in by hand.
-- Both need the same thing — somewhere to sit and be corrected before the
-- crews can see it — so a manual draft is a batch of one rather than its own
-- set of tables. One publish path, one review screen.

ALTER TABLE import_batches
  ADD COLUMN source         text NOT NULL DEFAULT 'import',
  ADD COLUMN archived       boolean NOT NULL DEFAULT false,
  ADD COLUMN archive_reason text,
  ADD COLUMN archived_by    uuid REFERENCES users(id),
  ADD COLUMN archived_at    timestamptz;

ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_source
    CHECK (source IN ('import', 'manual'));

-- A manual draft has no file behind it.
ALTER TABLE import_batches ALTER COLUMN source_name DROP NOT NULL;

-- Archiving is a status, never a delete: the record and its history stay.
ALTER TABLE import_batches
  ADD CONSTRAINT archive_has_reason
    CHECK (NOT archived OR archive_reason IS NOT NULL);

-- Denormalised from the batch so the uniqueness rule below can be an index.
ALTER TABLE import_items
  ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN archived   boolean NOT NULL DEFAULT false;

UPDATE import_items i
   SET project_id = b.project_id
  FROM import_batches b
 WHERE b.id = i.batch_id AND i.project_id IS NULL;

ALTER TABLE import_items ALTER COLUMN project_id SET NOT NULL;

-- At most one unpublished draft per FMR number per project.
--
-- FMRv3 checked this procedurally on restore, which left a hole: two freshly
-- created drafts could share a number and only collide at publish. As an index
-- it holds everywhere, including on create.
CREATE UNIQUE INDEX one_active_draft_per_number
  ON import_items (project_id, upper(fmr_number))
  WHERE fmr_number IS NOT NULL
    AND published_fmr_id IS NULL
    AND NOT archived;

CREATE INDEX import_batches_drafts_idx
  ON import_batches (project_id, source, archived, created_at DESC)
  WHERE published_at IS NULL;

CREATE INDEX import_items_project_idx ON import_items (project_id);
