-- User administration and editable lists.

-- Deactivation flags a user, never deletes them: their name still has to
-- resolve on every transaction they ever performed.
ALTER TABLE users
  ADD COLUMN deactivated_by     uuid REFERENCES users(id),
  ADD COLUMN deactivated_at     timestamptz,
  ADD COLUMN deactivated_reason text;

-- Lists drive the dropdowns the crews see. In FMRv3 these could only be
-- changed by editing the spreadsheet, so adding a backorder reason meant
-- finding someone with access; here they are editable from the owner screen.
--
-- project_id NULL means the value applies to every project.
CREATE INDEX lists_lookup_idx ON lists (list_name, sort_order) WHERE active;

INSERT INTO lists (project_id, list_name, value, sort_order) VALUES
  (NULL, 'BACKORDER_REASON', 'Not in stock',         0),
  (NULL, 'BACKORDER_REASON', 'Short shipped',        1),
  (NULL, 'BACKORDER_REASON', 'Wrong size received',  2),
  (NULL, 'BACKORDER_REASON', 'Damaged',              3),
  (NULL, 'BACKORDER_REASON', 'Cannot locate',        4),
  (NULL, 'UOM', 'EA',  0),
  (NULL, 'UOM', 'FT',  1),
  (NULL, 'UOM', 'LB',  2),
  (NULL, 'UOM', 'GAL', 3),
  (NULL, 'PRIORITY', 'Routine', 0),
  (NULL, 'PRIORITY', 'High',    1),
  (NULL, 'PRIORITY', 'Urgent',  2)
ON CONFLICT DO NOTHING;
