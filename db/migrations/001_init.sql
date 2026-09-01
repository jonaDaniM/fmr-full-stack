-- FMR platform: initial schema
-- Ported from FMRv3 Apps Script (Google Sheets backed).
-- Every operational table carries project_id: one deployment, many job sites.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- projects

CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'America/Indiana/Indianapolis',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Permissions are per project, mirroring the Users sheet's capability flags.
CREATE TABLE project_members (
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                text NOT NULL,
  can_search          boolean NOT NULL DEFAULT false,
  can_field_transact  boolean NOT NULL DEFAULT false,
  can_admin_backorder boolean NOT NULL DEFAULT false,
  can_owner_edit      boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- ---------------------------------------------------------------- fmr headers

CREATE TABLE fmr_headers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  fmr_number        text NOT NULL,
  iwp_number        text,
  requested_by      text,
  date_required     date,
  priority          text,
  current_status    text NOT NULL DEFAULT 'Open',
  notes             text,
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz,
  UNIQUE (project_id, fmr_number)
);

-- ---------------------------------------------------------------- fmr lines
-- The quantity ledger. Derived columns are generated, never hand-written,
-- so the invariants that IntegrityService.gs enforced in code are now
-- enforced by the database itself.

CREATE TABLE fmr_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  fmr_id                    uuid NOT NULL REFERENCES fmr_headers(id) ON DELETE CASCADE,
  line_number               integer NOT NULL,

  iso_number                text NOT NULL,
  iso_sheet                 text NOT NULL,
  iso_key                   text GENERATED ALWAYS AS
                              (upper(iso_number) || '|' || upper(iso_sheet)) STORED,
  commodity_code            text,
  size                      text,
  material_description      text,
  uom                       text,
  storage_location          text,

  qty_requested             numeric(14,4) NOT NULL CHECK (qty_requested >= 0),
  qty_confirmed_located     numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_confirmed_located >= 0),
  qty_active_bagged         numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_active_bagged >= 0),
  qty_available             numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_available >= 0),
  qty_issued                numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
  qty_pending_backorder     numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_pending_backorder >= 0),
  qty_confirmed_backorder   numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_confirmed_backorder >= 0),

  -- Derived: what is left to find, and what is left to satisfy.
  qty_not_yet_located       numeric(14,4) GENERATED ALWAYS AS
                              (GREATEST(0, qty_requested - qty_confirmed_located)) STORED,
  qty_remaining_requirement numeric(14,4) GENERATED ALWAYS AS
                              (GREATEST(0, qty_requested - qty_issued)) STORED,

  line_status               text NOT NULL DEFAULT 'Open',
  notes                     text,
  active                    boolean NOT NULL DEFAULT true,
  created_by                uuid REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  UNIQUE (fmr_id, line_number),

  -- A located quantity is either sitting available, bagged, or already issued.
  CONSTRAINT located_accounted_for
    CHECK (qty_confirmed_located = qty_available + qty_active_bagged + qty_issued),
  -- Never issue more than was asked for.
  CONSTRAINT issued_within_requested
    CHECK (qty_issued <= qty_requested)
);

CREATE INDEX fmr_lines_fmr_idx      ON fmr_lines (fmr_id);
CREATE INDEX fmr_lines_iso_idx      ON fmr_lines (project_id, iso_key);
CREATE INDEX fmr_lines_status_idx   ON fmr_lines (project_id, line_status) WHERE active;
CREATE INDEX fmr_headers_number_idx ON fmr_headers (project_id, upper(fmr_number));

-- ---------------------------------------------------------------- bag tags

CREATE TABLE bag_tags (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  tag_number         text NOT NULL,
  fmr_id             uuid NOT NULL REFERENCES fmr_headers(id) ON DELETE CASCADE,
  iso_key            text,
  storage_location   text,
  bagged_by          uuid REFERENCES users(id),
  bagged_by_name     text,
  bagged_at          timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'Active',
  notes              text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, tag_number)
);

CREATE TABLE bag_tag_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_tag_id            uuid NOT NULL REFERENCES bag_tags(id) ON DELETE CASCADE,
  fmr_line_id           uuid NOT NULL REFERENCES fmr_lines(id) ON DELETE CASCADE,
  qty_bagged            numeric(14,4) NOT NULL CHECK (qty_bagged > 0),
  qty_issued_from_bag   numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_issued_from_bag >= 0),
  qty_remaining_in_bag  numeric(14,4) GENERATED ALWAYS AS (qty_bagged - qty_issued_from_bag) STORED,
  status                text NOT NULL DEFAULT 'Active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT not_over_issued CHECK (qty_issued_from_bag <= qty_bagged)
);

CREATE INDEX bag_tag_items_line_idx ON bag_tag_items (fmr_line_id) WHERE status = 'Active';
CREATE INDEX bag_tag_items_tag_idx  ON bag_tag_items (bag_tag_id);

-- ---------------------------------------------------------------- backorders
-- A partial RETURN splits a request: the confirmed part stays on the original
-- row, the returned remainder becomes a new row pointing back via split_from_id.

CREATE TABLE backorder_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  fmr_id                  uuid NOT NULL REFERENCES fmr_headers(id) ON DELETE CASCADE,
  fmr_line_id             uuid NOT NULL REFERENCES fmr_lines(id) ON DELETE CASCADE,
  split_from_id           uuid REFERENCES backorder_requests(id),

  qty_requested           numeric(14,4) NOT NULL CHECK (qty_requested > 0),
  qty_confirmed           numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_confirmed >= 0),
  qty_pending             numeric(14,4) NOT NULL DEFAULT 0 CHECK (qty_pending >= 0),

  reason                  text NOT NULL,
  field_notes             text,
  reported_by             uuid REFERENCES users(id),
  reported_by_name        text,
  reported_at             timestamptz NOT NULL DEFAULT now(),

  status                  text NOT NULL DEFAULT 'Pending',
  admin_decision          text,
  admin_notes             text,
  decided_by              uuid REFERENCES users(id),
  decided_by_name         text,
  decided_at              timestamptz,
  returned_review_reason  text,

  active                  boolean NOT NULL DEFAULT true,
  correlation_id          uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT backorder_qty_split CHECK (qty_confirmed + qty_pending <= qty_requested)
);

CREATE INDEX backorder_line_idx    ON backorder_requests (fmr_line_id) WHERE active;
CREATE INDEX backorder_pending_idx ON backorder_requests (project_id, status) WHERE active;

-- ---------------------------------------------------------------- transactions
-- Append-only. No UPDATE, no DELETE: this is the record of what happened.

CREATE TABLE material_transactions (
  id                   bigserial PRIMARY KEY,
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  correlation_id       uuid NOT NULL,
  fmr_id               uuid NOT NULL REFERENCES fmr_headers(id),
  fmr_line_id          uuid NOT NULL REFERENCES fmr_lines(id),
  transaction_type     text NOT NULL,
  quantity             numeric(14,4) NOT NULL,
  uom                  text,
  performed_by         uuid REFERENCES users(id),
  performed_by_name    text,
  issued_to_name       text,
  source_bag_tag_id    uuid REFERENCES bag_tags(id),
  target_bag_tag_id    uuid REFERENCES bag_tags(id),
  storage_location     text,
  backorder_request_id uuid REFERENCES backorder_requests(id),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX txn_line_idx  ON material_transactions (fmr_line_id, created_at DESC);
CREATE INDEX txn_corr_idx  ON material_transactions (correlation_id);
CREATE INDEX txn_recent_idx ON material_transactions (project_id, created_at DESC);

-- ---------------------------------------------------------------- audit log

CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  project_id       uuid REFERENCES projects(id) ON DELETE RESTRICT,
  entity_type      text NOT NULL,
  entity_id        text NOT NULL,
  action           text NOT NULL,
  payload          jsonb,
  user_id          uuid REFERENCES users(id),
  user_email       text,
  source_interface text,
  correlation_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_corr_idx   ON audit_log (correlation_id);

-- ---------------------------------------------------------------- idempotency
-- Field crews work on bad connections. A repeated submission returns the
-- original result instead of moving material twice.

CREATE TABLE idempotency_keys (
  key            text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  request_hash   text NOT NULL,
  response       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------- lists

CREATE TABLE lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  list_name  text NOT NULL,
  value      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (project_id, list_name, value)
);
