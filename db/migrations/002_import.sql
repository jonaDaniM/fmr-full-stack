-- Import staging.
--
-- Parsed sheets land here first and are reviewed before anything becomes a
-- real FMR. Nothing in this schema touches fmr_headers or fmr_lines until
-- someone presses publish.

CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_name       text NOT NULL,
  source_fingerprint text,
  profile_name      text NOT NULL,
  sheet_count       integer NOT NULL DEFAULT 0,
  line_count        integer NOT NULL DEFAULT 0,
  error_count       integer NOT NULL DEFAULT 0,
  warning_count     integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'Parsed',
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  notes             text
);

CREATE INDEX import_batches_project_idx ON import_batches (project_id, created_at DESC);

-- One proposed FMR, from one worksheet.
CREATE TABLE import_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  sheet_name     text NOT NULL,
  fmr_number     text,
  iwp_number     text,
  iso_number     text,
  iso_sheet      text,
  requested_by   text,
  date_required  date,
  priority       text,
  header_json    jsonb,
  line_count     integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'Ready',
  selected       boolean NOT NULL DEFAULT true,
  existing_fmr_id uuid REFERENCES fmr_headers(id),
  published_fmr_id uuid REFERENCES fmr_headers(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_items_batch_idx ON import_items (batch_id);

CREATE TABLE import_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES import_items(id) ON DELETE CASCADE,
  line_number     integer NOT NULL,
  source_row      integer,
  commodity_code  text,
  size            text,
  description     text,
  quantity        numeric(14,4),
  uom             text,
  uom_rule        text,
  storage_location text,
  status          text NOT NULL DEFAULT 'Ready',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_lines_item_idx ON import_lines (item_id, line_number);

-- Everything the parser could not resolve, kept against its source row so a
-- person can see exactly which cell to fix.
CREATE TABLE import_issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  item_id      uuid REFERENCES import_items(id) ON DELETE CASCADE,
  sheet_name   text,
  severity     text NOT NULL,
  code         text NOT NULL,
  message      text NOT NULL,
  field_name   text,
  source_row   integer,
  source_value text,
  resolved     boolean NOT NULL DEFAULT false,
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_issues_batch_idx ON import_issues (batch_id, severity);
