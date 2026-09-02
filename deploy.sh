#!/usr/bin/env bash
#
# Put FMR on Google Cloud.
#
#   ./deploy.sh setup    once per project: database, secret, services
#   ./deploy.sh          every time after: build, migrate, release
#
# Safe to re-run. Everything it creates it checks for first, so a half-finished
# setup can be finished by running it again.

set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${GCP_PROJECT:-}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${GCP_SERVICE:-fmr}"
DB_INSTANCE="${GCP_DB_INSTANCE:-fmr-db}"
DB_NAME="${GCP_DB_NAME:-fmr}"
DB_TIER="${GCP_DB_TIER:-db-f1-micro}"
# Postgres 17 defaults to the Enterprise Plus edition, which refuses the
# shared-core tiers and starts around $300/month. Saying Enterprise keeps
# db-f1-micro available, which is what this system actually needs.
DB_EDITION="${GCP_DB_EDITION:-ENTERPRISE}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# The project is never guessed. gcloud has a global default and deploying a
# client's system into whatever it happens to be pointing at is not a mistake
# worth risking.
if [[ -z "$PROJECT" ]]; then
  CURRENT="$(gcloud config get-value project 2>/dev/null || true)"
  fail "Set GCP_PROJECT first. gcloud currently points at: ${CURRENT:-nothing}

  GCP_PROJECT=your-project ./deploy.sh setup"
fi

command -v gcloud >/dev/null || fail "The gcloud CLI is not installed."

# Checked before anything talks to Google, so a missing client id costs a
# second rather than a round trip and a confusing auth error.
if [[ "${1:-}" != "setup" && -z "${GOOGLE_CLIENT_ID:-}" ]]; then
  fail "Set GOOGLE_CLIENT_ID. Without it nobody can sign in to the deployment.

  GOOGLE_CLIENT_ID=…apps.googleusercontent.com ./deploy.sh"
fi

gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q . \
  || fail "Not signed in to gcloud. Run: gcloud auth login"

gcloud config set project "$PROJECT" >/dev/null

CONNECTION="${PROJECT}:${REGION}:${DB_INSTANCE}"

# --- setup -----------------------------------------------------------------

if [[ "${1:-}" == "setup" ]]; then
  say "Enabling the services this needs"
  gcloud services enable \
    run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com \
    secretmanager.googleapis.com artifactregistry.googleapis.com

  if gcloud sql instances describe "$DB_INSTANCE" >/dev/null 2>&1; then
    say "Database instance ${DB_INSTANCE} is already there"
  else
    say "Creating the database instance — this takes several minutes"
    gcloud sql instances create "$DB_INSTANCE" \
      --database-version=POSTGRES_17 --tier="$DB_TIER" --region="$REGION" \
      --edition="$DB_EDITION" \
      --storage-auto-increase --backup
  fi

  gcloud sql databases describe "$DB_NAME" --instance="$DB_INSTANCE" >/dev/null 2>&1 \
    || gcloud sql databases create "$DB_NAME" --instance="$DB_INSTANCE"

  # The application user, with a password nobody ever types or sees.
  if ! gcloud secrets describe fmr-db-password >/dev/null 2>&1; then
    say "Creating the database user"
    DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
    printf '%s' "$DB_PASSWORD" | gcloud secrets create fmr-db-password --data-file=-
    gcloud sql users create fmr --instance="$DB_INSTANCE" --password="$DB_PASSWORD"
  fi

  # Sessions are HMAC-signed with this. Rotating it signs everybody out, which
  # is the correct behaviour and the reason it is generated once and kept.
  gcloud secrets describe fmr-session-secret >/dev/null 2>&1 \
    || printf '%s' "$(openssl rand -hex 32)" \
       | gcloud secrets create fmr-session-secret --data-file=-

  # Cloud Run's service account has to be able to read both.
  NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  for SECRET in fmr-db-password fmr-session-secret; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
      --member="serviceAccount:${NUMBER}-compute@developer.gserviceaccount.com" \
      --role=roles/secretmanager.secretAccessor >/dev/null
  done

  say "Setup done. Now set GOOGLE_CLIENT_ID and run ./deploy.sh"
  cat <<NEXT

  Sign-in is Google only in a deployment, so you need an OAuth client:

    console.cloud.google.com/apis/credentials
      → Create credentials → OAuth client ID → Web application
      → Authorised redirect URI: the service URL this prints after deploying

    GOOGLE_CLIENT_ID=…apps.googleusercontent.com ./deploy.sh

NEXT
  exit 0
fi

# --- deploy ----------------------------------------------------------------

gcloud sql instances describe "$DB_INSTANCE" >/dev/null 2>&1 \
  || fail "No database instance. Run: GCP_PROJECT=$PROJECT ./deploy.sh setup"

say "Checking the tests pass before shipping anything"
npm test

DB_PASSWORD="$(gcloud secrets versions access latest --secret=fmr-db-password)"
DATABASE_URL="postgresql://fmr:${DB_PASSWORD}@localhost/${DB_NAME}?host=/cloudsql/${CONNECTION}"

say "Building the image"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE}"

# Cloud Run creates this repository itself when it builds from source. We hand
# it a built image instead, so on a new project there is nothing to push to.
gcloud artifacts repositories describe cloud-run-source-deploy \
  --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create cloud-run-source-deploy \
       --repository-format=docker --location="$REGION" \
       --description="Images for Cloud Run" >/dev/null

gcloud builds submit --tag "$IMAGE" .

# Migrations run as their own job, before the new code is serving. A migration
# that fails leaves the old release running rather than taking the service down
# with it.
say "Applying migrations"
if gcloud run jobs describe "${SERVICE}-migrate" --region="$REGION" >/dev/null 2>&1; then
  gcloud run jobs update "${SERVICE}-migrate" --region="$REGION" \
    --image="$IMAGE" --command=npm --args=run,migrate \
    --set-cloudsql-instances="$CONNECTION" \
    --set-env-vars="DATABASE_URL=${DATABASE_URL}" >/dev/null
else
  gcloud run jobs create "${SERVICE}-migrate" --region="$REGION" \
    --image="$IMAGE" --command=npm --args=run,migrate \
    --set-cloudsql-instances="$CONNECTION" \
    --set-env-vars="DATABASE_URL=${DATABASE_URL}" >/dev/null
fi
gcloud run jobs execute "${SERVICE}-migrate" --region="$REGION" --wait

say "Releasing"
# Two flags here are not defaults and matter:
#
#   --no-cpu-throttling  Cloud Run takes CPU away when a request ends. Reading
#                        a package deliberately outlives its request, so
#                        without this the reader can freeze mid-package.
#
#   --max-instances=1    A running extraction is a process on one instance.
#                        The one-job-per-project rule is a database index so it
#                        holds regardless, but a second instance cannot see the
#                        work the first is doing.
#
# FMR_DEV_LOGIN is deliberately absent: it lets anyone sign in by picking a
# user from a list, and exists for local development only.
gcloud run deploy "$SERVICE" --region="$REGION" --image="$IMAGE" \
  --allow-unauthenticated \
  --add-cloudsql-instances="$CONNECTION" \
  --set-secrets=SESSION_SECRET=fmr-session-secret:latest \
  --set-env-vars="DATABASE_URL=${DATABASE_URL},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" \
  --memory=1Gi --cpu=1 --timeout=600 \
  --max-instances=1 --min-instances=0 \
  --no-cpu-throttling

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"

say "Live at ${URL}"
cat <<DONE

  Check dev sign-in really is off:
    curl -s ${URL}/api/auth/dev
    → {"enabled":false,...}

  Add ${URL} to the OAuth client's authorised redirect URIs if you have not.

  The first person to sign in needs a row in users already — seed one with:
    gcloud sql connect ${DB_INSTANCE} --user=fmr --database=${DB_NAME}

DONE
