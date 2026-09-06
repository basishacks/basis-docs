# Reference

## Protocol endpoints

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/openid-configuration` | OIDC discovery |
| `/.well-known/oauth-authorization-server` | OAuth metadata |
| `/oauth/authorize` | Authorization code flow (PKCE S256 required) |
| `/oauth/token` | Code and refresh-token exchange |
| `/oauth/jwks` | RS256 public signing keys |
| `/oauth/userinfo` | Identity claims (bearer access token) |
| `/oauth/revoke` | Refresh-token revocation |
| `/oauth/logout` | Session logout |
| `/api/me` | Current SSO identity (requires SSO session) |
| `/api/picture/:userId` | Avatar bytes; requires the SSO session of the requested user (self only) |

## Portal API

All routes live under `/api` and require an authenticated administrator
session; mutations additionally require the `x-csrf-token` header.

| Route | Permission(s) | Notes |
| --- | --- | --- |
| `GET /api/me` | any portal role | Current identity, CSRF token, auth time |
| `GET /api/users` | users.read | Keyset-paginated, searchable |
| `PUT /api/users/:id/permissions` | users.write + admins.manage for portal grants | Self-edit blocked; last-admin protected |
| `POST /api/users/:id/disable` | users.write + step-up | Kills sessions, revokes tokens |
| `POST /api/users/local` | users.write | Creates local account, returns temp password once |
| `POST /api/users/:id/credentials/reset` | users.write + step-up | New show-once password, clears MFA |
| `POST /api/users/:id/mfa/reset` | users.write + step-up | Removes TOTP and recovery codes |
| `DELETE /api/users/:id` | users.write + step-up | Permanent, cascades, audited |
| `GET/POST /api/clients` | clients.read / clients.write | Registration; confidential apps get a secret once |
| `POST /api/clients/:id/secrets` | clients.write + step-up | Rotation with overlap windows |
| `PUT /api/clients/:id/logo` | clients.write + step-up | ≤ 512 KB, png/jpeg/webp/svg |
| `PUT/DELETE /api/resources/:audience` | resources.write | Deletion refused while referenced |
| `POST /api/sessions/:id/revoke` | tokens.revoke | SSO session revocation |
| `POST /api/tokens/family/:id/revoke` | tokens.revoke | Revokes an entire refresh family |
| `DELETE /api/consents/:user/:client` | consents.revoke | Drops remembered consent |
| `GET /api/audit`, `GET /api/signins` | audit.read / signins.read | Filterable, keyset-paginated |
| `GET /api/dashboard/summary` | any portal role | Single-statement aggregate |
| `PUT /api/settings/lockout` | settings.write + step-up | Requires typed `LOCK` confirmation |

## Environment variables

All variables are declared and validated in `src/config.ts`; see `.env.example`
for the canonical list. Required and commonly set variables:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development` (default), `test`, or `production` — must be `production` on any public host; `development` with a non-localhost issuer fails at startup |
| `PORT` | HTTP port for the IdP (default 3000) |
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `INTERNAL_API_HOST` / `INTERNAL_API_PORT` / `INTERNAL_API_TOKEN` | How the management portal reaches the IdP's internal API |
| `OIDC_ISSUER` | Public issuer URL (origin only, no path) |
| `OIDC_COOKIE_KEYS` | Comma-separated ≥ 32-char session cookie keys; placeholder values are rejected at startup |
| `OIDC_JWKS_JSON` / `OIDC_JWKS_FILE` | RS256 signing keys; auto-generated in non-production when unset |
| `OIDC_CLIENTS_JSON` / `OIDC_RESOURCES_JSON` | Seeded clients and resource servers (JSON) |
| `DEFAULT_PERMISSION` | Permission granted to every signed-in user (default `participant`) |
| `BOOTSTRAP_PERMISSION_GRANTS_JSON` | Email → permissions grants applied on first boot |
| `MICROSOFT_ISSUER` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Upstream Microsoft Entra OIDC (required in production) |
| `DEVCONNECT_PORTAL_URL` | Where `/` redirects (default `https://devconnect.biszweb.club/me`) |

Optional hardening and tuning:

| Variable | Purpose |
| --- | --- |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins allowed CORS on `/oauth/token` and `/oauth/userinfo` (default deny) |
| `SESSION_IDLE_TIMEOUT_MS` | Idle session lifetime (default 12h) |
| `SESSION_ABSOLUTE_MAX_MS` | Absolute session cap regardless of activity (default 30d) |
| `DATABASE_POOL_MAX` | Connection pool size (default 10) |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | Idle connection timeout (default 10000) |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Connect timeout (default 5000) |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Per-statement `statement_timeout` (optional) |

When `CORS_ALLOWED_ORIGINS` is set, matching `Origin` requests on
`/oauth/token` and `/oauth/userinfo` receive `Access-Control-Allow-Origin`;
all other origins are denied.

## Error codes

These codes are **not** HTTP status codes.

| Code | Namespace | Meaning |
| --- | --- | --- |
| 14001 | invalid_client | Client unknown or unregistered |
| 14002 | invalid_client | Client disabled |
| 14003 | invalid_client | Public client sent a secret |
| 14004 | invalid_client | Bad client secret |
| 14100 | invalid_request | redirect_uri missing or unregistered |
| 14401 | invalid_scope | Scope not permitted for this client or resource |
| 14407 | unknown_resource | Resource audience not registered (named in the error); re-save the client via `bun run clients` or add it to `OIDC_RESOURCES_JSON` |
| 14501 | invalid_target | Resource not registered for this application |
| 2400 | invalid_request | Interaction cookie missing or expired |
| 50040 | server_error | Internal failure during login flow |
