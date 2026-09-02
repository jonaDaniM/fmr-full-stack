# Deploying

One container holding both runtimes: the app is Node, and reading a drawing
PDF is Python. They meet in one file, `packages/import/src/runner.js`, which
spawns the reader and parses its JSON — so Python is an install step in the
`Dockerfile` and appears nowhere else.

## What it needs

| | |
|---|---|
| Postgres 17 | Cloud SQL, smallest tier is enough to start |
| `DATABASE_URL` | the connection string |
| `SESSION_SECRET` | `openssl rand -hex 32`, from a secret store — not an env literal |
| `GOOGLE_CLIENT_ID` | sign-in is Google only in a deployment |

**Never set `FMR_DEV_LOGIN` in a deployment.** It exists so local development
can sign in by picking a seeded user. Without it the server refuses that route,
and an account must already exist in `users` — an owner adds people from the
owner screen.

## First deploy

```bash
gcloud sql instances create fmr \
  --database-version=POSTGRES_17 --tier=db-f1-micro --region=us-central1
gcloud sql databases create fmr --instance=fmr

printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create fmr-session-secret --data-file=-

gcloud run deploy fmr --source . --region=us-central1 \
  --add-cloudsql-instances=PROJECT:us-central1:fmr \
  --set-secrets=SESSION_SECRET=fmr-session-secret:latest \
  --set-env-vars=DATABASE_URL=...,GOOGLE_CLIENT_ID=... \
  --max-instances=1 --no-cpu-throttling
```

Migrations are separate from the deploy, so a bad migration does not take the
service with it:

```bash
DATABASE_URL=... npm run migrate
```

## Two settings that matter, and why

**`--no-cpu-throttling`.** Cloud Run stops giving a container CPU when its
request ends. Reading a package outlives its request by design — the upload
answers with a job id and the work carries on — so without this the reader can
be frozen mid-package. If it happens anyway, the next boot marks the job failed
and the person is told to try again, rather than watching a spinner forever.

**`--max-instances=1`.** One extraction at a time per project is enforced by a
database index, so correctness holds at any scale. But a job started on one
instance is a process on that instance, and a second instance polling for it
sees only the row. One instance is the honest configuration for one client, and
the setting to revisit before that changes.

## Sizing

The reader needs about 150 MB while it works, so give the service 1 GB. It runs
only when somebody uploads drawings — an 85-page package takes about 1.6
seconds — so the cost of it is not the memory, it is having Postgres at all.

## Checking a deployment

```bash
curl -s https://YOUR-URL/api/auth/dev    # {"enabled":false,...} — dev login is off
```

Then sign in with Google, open Import, and drop a package of drawings. If the
reader is missing the upload says so plainly rather than failing quietly.
