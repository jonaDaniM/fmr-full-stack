-- Field notices and owner corrections.

-- ---------------------------------------------------------------- notices
--
-- What the office decided, put in front of the crew who asked. A notice is
-- derived from a backorder request but has its own life: it is raised when a
-- decision is made, reduced as the crew works through it, and resolved when
-- nothing is outstanding.
--
-- One notice per (line, source request, kind), so a decision updates the
-- existing notice rather than stacking duplicates on the card.

CREATE TABLE field_notices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fmr_id            uuid NOT NULL REFERENCES fmr_headers(id) ON DELETE CASCADE,
  fmr_line_id       uuid NOT NULL REFERENCES fmr_lines(id) ON DELETE CASCADE,
  source_request_id uuid REFERENCES backorder_requests(id) ON DELETE CASCADE,

  kind              text NOT NULL,
  severity          text NOT NULL DEFAULT 'info',

  qty_notified      numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_notified >= 0),
  qty_resolved      numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_resolved >= 0),
  qty_outstanding   numeric(14,4) GENERATED ALWAYS AS (qty_notified - qty_resolved) STORED,

  headline          text NOT NULL,
  detail            text,
  admin_notes       text,

  status            text NOT NULL DEFAULT 'Active',
  raised_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_reason   text,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notice_not_over_resolved CHECK (qty_resolved <= qty_notified)
);

-- One live notice per line, source and kind.
CREATE UNIQUE INDEX field_notices_unique_live
  ON field_notices (fmr_line_id, coalesce(source_request_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
  WHERE status = 'Active';

CREATE INDEX field_notices_line_idx ON field_notices (fmr_line_id) WHERE status = 'Active';
CREATE INDEX field_notices_project_idx ON field_notices (project_id, status);

-- ---------------------------------------------------------------- corrections
--
-- Owners fix mistakes by writing compensating entries, never by editing
-- history. The original transactions stay exactly as recorded; a correction
-- adds inverse transactions and moves the ledger back.
--
-- Previewed first, applied second, and the before/after state is kept so the
-- change itself can be audited.

CREATE TABLE corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  fmr_id            uuid NOT NULL REFERENCES fmr_headers(id),
  fmr_line_id       uuid NOT NULL REFERENCES fmr_lines(id),
  correlation_id    uuid NOT NULL,

  reversed_correlation_id uuid NOT NULL,
  transaction_types text[] NOT NULL,

  reason            text NOT NULL,
  state_before      jsonb NOT NULL,
  state_after       jsonb NOT NULL,

  status            text NOT NULL DEFAULT 'Applied',
  applied_by        uuid REFERENCES users(id),
  applied_by_name   text,
  applied_at        timestamptz NOT NULL DEFAULT now()
);

-- A given set of transactions can only be reversed once.
CREATE UNIQUE INDEX corrections_once
  ON corrections (reversed_correlation_id) WHERE status = 'Applied';

CREATE INDEX corrections_line_idx ON corrections (fmr_line_id, applied_at DESC);

-- ---------------------------------------------------------------- controls
--
-- An operational stop. When a project is locked, field actions are refused
-- with the reason the owner gave — used during a cutover, a data problem, or
-- a stock count.

CREATE TABLE project_controls (
  project_id     uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  field_locked   boolean NOT NULL DEFAULT false,
  import_locked  boolean NOT NULL DEFAULT false,
  lock_reason    text,
  locked_by      uuid REFERENCES users(id),
  locked_at      timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
