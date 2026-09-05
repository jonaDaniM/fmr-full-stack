-- Line swap: borrowing material from another line.
--
-- Two facts, kept deliberately apart. The physical movement is recorded in
-- material_transactions like any other issue (SWAP_LENT / SWAP_BORROWED,
-- sharing one correlation_id). The obligation lives here.
--
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS line_swaps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,

  -- Who gave the material up. Owed replacement until qty_repaid catches up.
  donor_fmr_id       uuid NOT NULL REFERENCES fmr_headers(id) ON DELETE CASCADE,
  donor_line_id      uuid NOT NULL REFERENCES fmr_lines(id)   ON DELETE CASCADE,

  -- Who received it. Credited in full; owes nothing.
  receiver_fmr_id    uuid NOT NULL REFERENCES fmr_headers(id) ON DELETE CASCADE,
  receiver_line_id   uuid NOT NULL REFERENCES fmr_lines(id)   ON DELETE CASCADE,

  -- What moved, captured at the time. The lines can be edited later; what was
  -- borrowed cannot change retrospectively.
  commodity_code     text,
  size               text,
  uom                text,
  qty_borrowed       numeric(14,4) NOT NULL CHECK (qty_borrowed > 0),
  qty_repaid         numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_repaid >= 0),
  qty_outstanding    numeric(14,4) GENERATED ALWAYS AS
                       (GREATEST(0, qty_borrowed - qty_repaid)) STORED,

  status             text NOT NULL DEFAULT 'Open',
  reason             text,

  borrowed_by        uuid REFERENCES users(id),
  borrowed_by_name   text,
  issued_to_name     text,
  correlation_id     uuid NOT NULL,

  cancelled_by       uuid REFERENCES users(id),
  cancelled_at       timestamptz,
  cancelled_reason   text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT swap_not_over_repaid CHECK (qty_repaid <= qty_borrowed),
  CONSTRAINT swap_distinct_lines  CHECK (donor_line_id <> receiver_line_id),
  CONSTRAINT swap_status_known
    CHECK (status IN ('Open', 'Partially Repaid', 'Repaid', 'Cancelled'))
);

-- The admin queue: open obligations, oldest first.
CREATE INDEX IF NOT EXISTS line_swaps_open_idx
  ON line_swaps (project_id, created_at)
  WHERE status IN ('Open', 'Partially Repaid');

-- "What does this line owe, or what is it owed?" from either side.
CREATE INDEX IF NOT EXISTS line_swaps_donor_idx    ON line_swaps (donor_line_id);
CREATE INDEX IF NOT EXISTS line_swaps_receiver_idx ON line_swaps (receiver_line_id);

-- Repayments are append-only, like every other movement of material.
CREATE TABLE IF NOT EXISTS line_swap_repayments (
  id             bigserial PRIMARY KEY,
  swap_id        uuid NOT NULL REFERENCES line_swaps(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  quantity       numeric(14,4) NOT NULL CHECK (quantity > 0),
  notes          text,
  recorded_by    uuid REFERENCES users(id),
  recorded_by_name text,
  correlation_id uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS swap_repayment_idx ON line_swap_repayments (swap_id, created_at);
