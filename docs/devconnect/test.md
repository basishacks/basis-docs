# DevConnect Test Guide

This page describes how to run the basis-auth test suite, what the tests
cover, and how to run the optional PostgreSQL integration tests **without
Docker**.

## Running the unit and route tests

The default suite needs no database and no Docker:

```bash
bun install
bun run test
```

`bun run test` runs Vitest (`vitest run`). It covers:

- Protocol behavior (authorize, token, refresh rotation, revocation, userinfo).
- Identity assembly, client caching, and scope coverage.
- Key issuance/verification and the in-memory rate limiter.
- Session idle and absolute timeouts.
- Configuration loading and validation (including the placeholder
  `OIDC_COOKIE_KEYS` rejection).
- Microsoft upstream mapping and email-verified resolution.
- Web UI helpers (for example `scope-description`).

Watch mode:

```bash
bun run test:watch
```

## Coverage

Coverage uses `@vitest/coverage-v8` and is configured in `vitest.config.ts`.
A small set of files (logging, rate limiting, scopes, client cache, and key
handling) are gated at 100% line, branch, function, and statement coverage so
security-sensitive paths stay fully exercised.

## PostgreSQL integration tests (no Docker required)

The end-to-end OAuth flow lives in `src/oauth/service.integration.test.ts`.
It no longer spins up a container — instead it connects to a PostgreSQL
instance you already have.

To run it:

1. Point `DATABASE_URL` at any reachable PostgreSQL 14+ database.
2. Set `RUN_POSTGRES_TESTS=1`.
3. Run `bun run test`.

```bash
RUN_POSTGRES_TESTS=1 \
DATABASE_URL="postgresql://basis_auth:basis_auth@localhost:5432/basis_auth" \
bun run test
```

The suite is **skipped** unless both `RUN_POSTGRES_TESTS=1` and a non-empty
`DATABASE_URL` are present, so CI that does not configure a database stays
green without Docker. The integration test applies its own migrations to the
target database on startup.

## Adding tests

Tests are colocated with the module they exercise (`*.test.ts`). Name tests as
behavior statements, for example:

```ts
it("rejects code replay after a token has been issued", async () => {
  // ...
});
```

Keep new security-sensitive logic covered, and add or update tests whenever
you change authorization, token, identity, configuration, or migration behavior.
