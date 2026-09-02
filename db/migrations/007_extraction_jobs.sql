-- Reading drawings takes longer than a request should wait.
--
-- A package of ISO PDFs is handed to the extractor, which reads it and stages
-- the result as an import batch. The web request cannot hold open while that
-- happens, so it records the work here and answers with an id the browser
-- polls. This is the only asynchronous work in the system.

CREATE TABLE extraction_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by   uuid NOT NULL REFERENCES users(id),
  status       text NOT NULL DEFAULT 'Running'
               CHECK (status IN ('Running', 'Done', 'Failed')),
  source_name  text NOT NULL,
  file_count   integer NOT NULL CHECK (file_count > 0),
  iwp_number   text,
  batch_id     uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  -- What to tell the person waiting. On a failure this is the whole
  -- explanation they get, so it is written for them and not for a log.
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,

  -- A job that has stopped says when, and one that succeeded has something to
  -- show for it. Enforced here so a service that gets it wrong fails at the
  -- write rather than leaving the browser polling a job that will never move.
  CONSTRAINT finished_jobs_say_when
    CHECK (status = 'Running' OR finished_at IS NOT NULL),
  CONSTRAINT done_jobs_have_a_batch
    CHECK (status <> 'Done' OR batch_id IS NOT NULL),
  CONSTRAINT failed_jobs_say_why
    CHECK (status <> 'Failed' OR message IS NOT NULL)
);

CREATE INDEX extraction_jobs_project_idx
  ON extraction_jobs (project_id, created_at DESC);

-- One extraction at a time per project. Two at once would race for memory on
-- the host and produce two batches nobody asked to compare.
CREATE UNIQUE INDEX extraction_jobs_one_running
  ON extraction_jobs (project_id) WHERE status = 'Running';
