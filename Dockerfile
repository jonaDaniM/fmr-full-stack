# One image, two runtimes.
#
# The app is Node. Reading a drawing PDF is Python, because it needs every
# word's position on the page and PyMuPDF is the library that gives that well.
# The two only meet in packages/import/src/runner.js, which spawns the reader
# and parses its JSON — so Python is an install step here and nowhere else.

FROM node:23-slim

# python3-venv keeps the reader's dependencies out of the system interpreter.
# PyMuPDF and openpyxl both ship wheels, so no compiler is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY package*.json ./
RUN npm ci --omit=dev

COPY packages/extract-iso/pyproject.toml packages/extract-iso/
COPY packages/extract-iso/src packages/extract-iso/src
COPY packages/extract-iso/templates packages/extract-iso/templates
RUN python3 -m venv /opt/reader \
 && /opt/reader/bin/pip install --no-cache-dir ./packages/extract-iso

COPY . .

ENV NODE_ENV=production \
    FMR_PYTHON=/opt/reader/bin/python \
    FMR_EXTRACT_HOME=/app/packages/extract-iso \
    PORT=8080

# FMR_DEV_LOGIN is deliberately unset: without it, sign-in is Google only and
# an account must already exist. Setting it in a deployment would let anyone
# pick a user from a list.

# Not root. The reader writes uploaded PDFs to a temp directory and runs a
# parser over them; if either is ever made to misbehave it should not be
# holding root in the container.
RUN chown -R node:node /app /opt/reader
USER node

EXPOSE 8080
CMD ["node", "packages/api/src/server.js"]
