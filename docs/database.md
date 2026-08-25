# Database Setup

Both processes share one PostgreSQL database. The IdP connects through
`DATABASE_URL`; the portal uses `ADMIN_DATABASE_URL` with a dedicated
least-privilege role.

## Role model

```mermaid
flowchart TD
  OWNER[Owner / migration role<br/>basis_auth]
  ADMIN[Portal role<br/>basis_admin]

  OWNER -->|full control| T1[users]
  OWNER -->|full control| T2[clients, resources]
  OWNER -->|full control| T3[sessions, tokens]
  ADMIN -->|read + write| T1
  ADMIN -->|read + write| T2
  ADMIN -->|append only| H1[audit_events]
  ADMIN -->|append only| H2[auth_events]
```

Audit tables accept `INSERT` and `SELECT` only for the portal role. Even a
full portal compromise cannot edit or delete history.

## Local development

```bash
docker run -d --name basis-postgres \
  -e POSTGRES_USER=basis_auth \
  -e POSTGRES_PASSWORD=basis_auth \
  -e POSTGRES_DB=basis_auth \
  -p 5432:5432 postgres:17
npm run db:migrate
psql "postgresql://basis_auth:basis_auth@localhost:5432/basis_auth" \
  -v admin_password=basis_admin_dev \
  -f scripts/create-admin-role.sql
```

Point `.env` at both roles:

```text
DATABASE_URL=postgresql://basis_auth:basis_auth@localhost:5432/basis_auth
ADMIN_DATABASE_URL=postgresql://basis_admin:basis_admin_dev@localhost:5432/basis_auth
```

## Production server

Create the application role and database, then run the admin-role script:

```sql
CREATE ROLE basis_auth LOGIN PASSWORD 'long-random-password';
CREATE DATABASE basis_auth OWNER basis_auth;
```

```bash
psql "$DATABASE_URL" -f scripts/create-admin-role.sql
DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

Restrict network access in `pg_hba.conf`, prefer `hostssl`, and schedule
nightly `pg_dump` backups.

## Managed PostgreSQL

Any PostgreSQL 14+ service works. Connect with provider credentials once to
create `basis_admin` (apply the GRANT statements if `CREATE ROLE` is
restricted), then run migrations from any machine that can reach the instance.

## Migrations

```mermaid
flowchart LR
  S[Edit schema.ts] --> G[npm run db:generate]
  G --> R[Review SQL]
  R --> D{dupes?}
  D -- users change --> C[db:check-dupes]
  C --> M[npm run db:migrate]
  D -- clean --> M
```

Startup always applies pending migrations idempotently, so rolling deploys are
safe.
