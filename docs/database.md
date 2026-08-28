# Database Setup

The IdP connects to PostgreSQL through `DATABASE_URL`. The management portal is
a separate web process that performs administration **through the IdP's
authenticated internal API** (`INTERNAL_API_TOKEN`); it never connects to
PostgreSQL directly. There is therefore a single database role in practice: the
one used by `DATABASE_URL`.

## Audit immutability

Sign-in and audit history are append-only by construction. The portal has no
code path that mutates history — it can only read it through the internal API —
so a full portal compromise cannot rewrite or delete past events.

## Local development

Use any local PostgreSQL 14+ instance. If you do not have one, install
PostgreSQL locally or use a managed service; Docker is not required.

```bash
# Example using a local PostgreSQL (adjust user/db to match your install)
createdb basis_auth
DATABASE_URL="postgresql://$USER@localhost:5432/basis_auth" npm run db:migrate
```

Point `.env` at your instance:

```text
DATABASE_URL=postgresql://<user>@localhost:5432/basis_auth
```

## Production server

Create the application role and database, then apply migrations:

```sql
CREATE ROLE basis_auth LOGIN PASSWORD 'long-random-password';
CREATE DATABASE basis_auth OWNER basis_auth;
```

```bash
DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

Restrict network access in `pg_hba.conf`, prefer `hostssl`, and schedule
nightly `pg_dump` backups. The IdP uses the role behind `DATABASE_URL` for all
reads and writes; no other role or process touches the database.

## Managed PostgreSQL

Any PostgreSQL 14+ service works. Connect with provider credentials, then run
migrations from any machine that can reach the instance.

## Migrations

```mermaid
flowchart LR
  S[Edit schema.ts] --> G[npm run db:generate]
  G --> R[Review SQL]
  R --> M[npm run db:migrate]
```

`npm run db:generate` produces a new SQL migration from `src/database/schema.ts`;
review it, then apply with `npm run db:migrate`. Startup also applies pending
migrations idempotently (see `src/index.ts`), so rolling deploys are safe.
