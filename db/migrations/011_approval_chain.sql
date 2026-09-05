-- The approval chain an FMR passes through before the field can act on it.
--
-- Until now a draft was either waiting or published, and whoever could edit
-- drafts could also publish them. The business process has two decisions
-- between those points, owned by two different people:
--
--   created -> planner review -> material manager numbers it -> published
--
-- The planner checks the request suits the work package. The material manager
-- owns the official FMR number, which is the release identifier — the thing
-- the field searches by and the thing purchasing quotes against. Neither step
-- existed, so a single owner could take a drawing straight to the crews.
--
-- Nothing here changes the ledger. An FMR that reaches Published behaves
-- exactly as before; this governs how it gets there.

-- --------------------------------------------------------------- permissions
-- Two new flags rather than a rank: reviewing a package for constructability
-- and owning the numbering series are different jobs, and a site may well
-- give them to different people. Following the existing convention that ADMIN
-- is not a superset of FIELD.
ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS can_plan_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_assign_number boolean NOT NULL DEFAULT false;

-- Existing owners keep every power they had, including the two being carved
-- out here. Without this the deploy would lock the only people who can
-- publish out of publishing.
UPDATE project_members
   SET can_plan_review = true, can_assign_number = true
 WHERE can_owner_edit;

-- Material Admins own the numbering series from here. This is the change the
-- client asked for directly: numbering should not sit with whoever happens to
-- be able to edit a draft.
UPDATE project_members
   SET can_assign_number = true
 WHERE can_admin_backorder AND NOT can_owner_edit;

-- ------------------------------------------------------------ workflow state
-- On import_items, because that is where a proposed FMR lives before it is
-- published. A published one has an fmr_headers row and has left this table's
-- concern.
ALTER TABLE import_items
  ADD COLUMN IF NOT EXISTS workflow_state text NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS planner_decided_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS planner_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS planner_note text,
  ADD COLUMN IF NOT EXISTS numbered_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS numbered_at timestamptz;

ALTER TABLE import_items
  DROP CONSTRAINT IF EXISTS workflow_state_known,
  ADD CONSTRAINT workflow_state_known CHECK (workflow_state IN (
    'DRAFT',                    -- created, not submitted
    'PENDING_PLANNER_REVIEW',   -- waiting on the planner
    'PLANNER_APPROVED',         -- cleared, ready for the material manager
    'PLANNER_RETURNED',         -- sent back for correction
    'PENDING_MATERIAL_MANAGER', -- waiting on a number
    'NUMBER_ASSIGNED',          -- has its official number, ready to publish
    'PUBLISHED'                 -- released to the field
  ));

-- A planner decision without a decider, or a number without a numberer, would
-- leave the audit question "who approved this" unanswerable — which is the
-- whole point of the chain.
ALTER TABLE import_items
  DROP CONSTRAINT IF EXISTS planner_decision_attributed,
  DROP CONSTRAINT IF EXISTS numbering_attributed,
  ADD CONSTRAINT planner_decision_attributed CHECK (
    (planner_decided_by IS NULL) = (planner_decided_at IS NULL)
  ),
  ADD CONSTRAINT numbering_attributed CHECK (
    (numbered_by IS NULL) = (numbered_at IS NULL)
  );

-- Everything already in the queue predates the chain. Published items are
-- Published; the rest are drafts their owner can now submit.
UPDATE import_items
   SET workflow_state = 'PUBLISHED'
 WHERE published_fmr_id IS NOT NULL AND workflow_state <> 'PUBLISHED';

-- The planner and material-manager queues are both "everything waiting on me
-- in this project", which is this index.
CREATE INDEX IF NOT EXISTS import_items_workflow_idx
  ON import_items (project_id, workflow_state)
  WHERE published_fmr_id IS NULL AND NOT archived;
