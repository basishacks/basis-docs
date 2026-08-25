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

See `.env.example` in the repository — every variable is documented there,
including hardening knobs (`TRUST_PROXY`, `RATE_LIMIT_*`,
`PURGE_INTERVAL_MS`, body limits) and all `ADMIN_*` portal settings.

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
| 14407 | unknown_resource | Resource not found |
| 14501 | invalid_target | Resource not registered for this application |
| 2400 | invalid_request | Interaction cookie missing or expired |
| 50040 | server_error | Internal failure during login flow |
