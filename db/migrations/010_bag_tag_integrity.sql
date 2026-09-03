-- One bag, one line, one row.
--
-- Bagging the same line into the same tag twice wrote a second item row. The
-- ledger stayed right — the line's bagged total is its own column — but
-- ISSUE_FROM_BAG reads a single item row, so a crew with 50 ft in one bag was
-- told "Only 30 remains available in this bag" and had to issue it in two
-- goes with no explanation.
--
-- FMRv3 could not reach this: it minted a fresh tag for every bagging
-- (FieldService.gs:869). Letting a crew type a pre-printed tag number is what
-- made a second row against one tag possible.
--
-- Partial, so a closed row from a previous cycle does not block bagging into a
-- tag that has been emptied and reused.

-- Fold any duplicates together before the index refuses them.
WITH folded AS (
  SELECT bag_tag_id, fmr_line_id,
         min(id::text)::uuid          AS keep_id,
         sum(qty_bagged)              AS total_bagged,
         sum(qty_issued_from_bag)     AS total_issued
    FROM bag_tag_items
   WHERE status = 'Active'
   GROUP BY bag_tag_id, fmr_line_id
  HAVING count(*) > 1
)
UPDATE bag_tag_items i
   SET qty_bagged = f.total_bagged,
       qty_issued_from_bag = f.total_issued,
       updated_at = now()
  FROM folded f
 WHERE i.id = f.keep_id;

DELETE FROM bag_tag_items i
 USING (
   SELECT bag_tag_id, fmr_line_id, min(id::text)::uuid AS keep_id
     FROM bag_tag_items
    WHERE status = 'Active'
    GROUP BY bag_tag_id, fmr_line_id
   HAVING count(*) > 1
 ) f
 WHERE i.bag_tag_id = f.bag_tag_id
   AND i.fmr_line_id = f.fmr_line_id
   AND i.status = 'Active'
   AND i.id <> f.keep_id;

CREATE UNIQUE INDEX bag_tag_items_one_per_line
  ON bag_tag_items (bag_tag_id, fmr_line_id)
  WHERE status = 'Active';
