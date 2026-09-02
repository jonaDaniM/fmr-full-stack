-- A finished job and its batch stand or fall together.
--
-- extraction_jobs.batch_id was ON DELETE SET NULL, which contradicts the
-- done_jobs_have_a_batch check: removing a batch tried to null the column on a
-- job that had already succeeded, and the constraint refused it. Nothing in
-- the app deletes a batch, so this only bit a person clearing test data — but
-- two rules that cannot both hold is a trap either way.
--
-- Cascading is the honest reading: a job records that a batch was produced,
-- and once the batch is gone that record has nothing left to point at.
ALTER TABLE extraction_jobs
  DROP CONSTRAINT extraction_jobs_batch_id_fkey,
  ADD CONSTRAINT extraction_jobs_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE;
