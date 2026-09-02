-- An idempotency key belongs to the person who sent it.
--
-- The key was the primary key on its own, so it was global: two people whose
-- clients generated the same key collided with each other. The lookup ignored
-- user_id entirely, which meant the second person was handed back the first
-- person's stored response — someone else's material movement, reported as
-- their own — or a 409 refusing an action they were entitled to take.
--
-- Client-generated UUIDs make that unlikely rather than impossible, and
-- "unlikely" is the wrong guarantee for a ledger. Scoping the key to its user
-- makes the collision impossible instead, and costs nothing: every lookup
-- already knows who is asking.
--
-- Any key already stored keeps working — the pair is still unique for it.
ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_pkey,
  ADD PRIMARY KEY (user_id, key);

-- A key is now claimed before the work runs and filled in afterwards, so
-- between those two moments it has no response. That in-flight state is the
-- point: a retry arriving mid-flight is told to wait rather than being handed
-- an empty response that looks like success.
ALTER TABLE idempotency_keys
  ALTER COLUMN response DROP NOT NULL;

-- ------------------------------------------------------------------ sessions

-- Signing out did nothing a stolen cookie would notice.
--
-- Sessions are stateless HMAC tokens, so signing out cleared the browser's
-- cookie and nothing else: a cookie copied beforehand stayed valid for the
-- rest of its twelve hours. issueSession already minted a session id for
-- exactly this purpose and then never used it.
--
-- Deactivating a user was always caught — authenticate() re-reads the user on
-- every request — so this closes the narrower case that remained: a shared
-- warehouse terminal, where signing out has to mean something.
CREATE TABLE revoked_sessions (
  sid        uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  -- When the token would have expired anyway. Past that there is nothing left
  -- to revoke, so the row can be dropped.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX revoked_sessions_expiry_idx ON revoked_sessions (expires_at);
