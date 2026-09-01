-- Bag tag numbering.
--
-- FMRv3 allocated tag numbers itself (FieldService.gs:731) from a
-- NEXT_TAG_SEQUENCE counter in the Configuration sheet, formatted
-- BT-2025-00001. The crew never typed one. Requiring it by hand is worse in
-- gloves and invites the collisions the UNIQUE constraint then rejects, so the
-- counter comes back — per project, since two projects number independently.
--
-- Manual entry still works: a crew bagging into a pre-printed tag types that
-- number instead. The sequence only supplies the default.

ALTER TABLE project_controls
  ADD COLUMN tag_prefix        text    NOT NULL DEFAULT 'BT',
  ADD COLUMN tag_sequence      integer NOT NULL DEFAULT 1,
  ADD COLUMN tag_sequence_year integer;

-- The prefix goes into a tag number, so keep it to what stencils on a bag.
ALTER TABLE project_controls
  ADD CONSTRAINT tag_prefix_shape CHECK (tag_prefix ~ '^[A-Z][A-Z0-9-]{0,7}$'),
  ADD CONSTRAINT tag_sequence_positive CHECK (tag_sequence >= 1);

-- Every project needs a row for the counter to live in. getControls() creates
-- one lazily, but a project that has never had its controls read would have
-- none, and the first bagging would find nothing to increment.
INSERT INTO project_controls (project_id)
  SELECT id FROM projects
  ON CONFLICT (project_id) DO NOTHING;

-- Numbers already in use set the starting point, so a migrated project does not
-- reissue numbers its own history already contains. Matches BT-2025-00007 and
-- takes the highest counter seen for the current prefix and year.
WITH used AS (
  SELECT t.project_id,
         max((regexp_match(t.tag_number, '^([A-Z][A-Z0-9-]*)-(\d{4})-(\d+)$'))[3]::integer) AS highest,
         (regexp_match(t.tag_number, '^([A-Z][A-Z0-9-]*)-(\d{4})-(\d+)$'))[2]::integer      AS year
    FROM bag_tags t
   WHERE t.tag_number ~ '^([A-Z][A-Z0-9-]*)-(\d{4})-(\d+)$'
   GROUP BY t.project_id, year
)
UPDATE project_controls c
   SET tag_sequence      = used.highest + 1,
       tag_sequence_year = used.year
  FROM used
 WHERE used.project_id = c.project_id
   AND used.year = EXTRACT(YEAR FROM now())::integer;
