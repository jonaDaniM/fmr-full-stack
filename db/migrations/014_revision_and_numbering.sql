-- Drawing revision, and FMR numbers the database issues.
--
-- Two corrections from the client, and they are not the same kind of problem.
--
-- The revision is what a crew works to. Engineers reissue a drawing as they
-- change it — rev 0 is the original, rev 1 the first revision — and the yard
-- always works to the latest. The extractor has been reading it off the title
-- block correctly all along (verified against 20 real drawings: the REV field
-- is its own cell, holding 0, 1 or 2) and it was then dropped: no column,
-- nothing on screen. A crew could not tell whether a requisition was raised
-- against the current drawing or a superseded one.
--
-- Note the trailing -02 / -03 on a drawing number is NOT a sheet and not a
-- revision. LP1Y-CHWR-033047-02 and LP1Y-CHWR-033047-03 are two drawings of
-- the same line, each carrying its own REV. The title block's own SHEET field
-- reads "1 OF 1" — a page counter, which is why nothing here uses it.
--
-- The FMR number is the other correction. Importing a drawing package was
-- proposing the drawing number as the FMR number, so every imported FMR was
-- "numbered" LP131-CIPS-171045-03. An FMR number is not a drawing number: it
-- counts from 1 upward and the office issues it. Hence a sequence per project.

-- --------------------------------------------------------------- revision

-- On the line, beside iso_number, because it belongs to the drawing that line
-- was read from rather than to the requisition as a whole.
ALTER TABLE fmr_lines ADD COLUMN iso_revision text;

-- And on the staged item, so it survives the trip through the drafts queue.
ALTER TABLE import_items ADD COLUMN iso_revision text;

COMMENT ON COLUMN fmr_lines.iso_revision IS
  'Drawing revision from the title block. Rev 0 is the original issue; crews '
  'work to the latest. Null where the drawing was typed rather than read.';

-- Deliberately NOT part of iso_key. That key is what the field searches by,
-- and a crew looking for a drawing wants every revision of it, not just the
-- one whose requisition they happen to remember.

-- ---------------------------------------------------------- fmr numbering

-- One counter per project. A shared counter would leak one project's volume
-- into another's numbering and make both look arbitrary.
CREATE TABLE fmr_number_sequences (
  project_id  uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_value  bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE fmr_number_sequences IS
  'Where each project''s next FMR number comes from. A table rather than a '
  'Postgres sequence because it must start above whatever numbers arrived '
  'with the migrated spreadsheet, and because a sequence cannot be corrected '
  'transactionally if a project is ever renumbered.';

-- Seed every project past its highest numeric FMR number, so an issued number
-- cannot collide with one that migrated in. Numbers that are not plain
-- integers are ignored rather than guessed at: this counts from 1 upward, and
-- a number like "FMR-2026-0417" is not on that line.
INSERT INTO fmr_number_sequences (project_id, next_value)
SELECT p.id,
       coalesce(max(h.fmr_number::bigint), 0) + 1
  FROM projects p
  LEFT JOIN fmr_headers h
    ON h.project_id = p.id AND h.fmr_number ~ '^[0-9]+$'
 GROUP BY p.id
ON CONFLICT (project_id) DO NOTHING;
