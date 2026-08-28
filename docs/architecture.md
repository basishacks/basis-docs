# Architecture

basis-auth is a compact OpenID Connect provider. One Hono process serves the
protocol and the login UI; an optional second process runs the management
portal. Both share one PostgreSQL database through separate roles.

## System components

```mermaid
flowchart LR
  subgraph Clients
    APP[Downstream app]
    API[Resource API]
    ADM[Admin browser]
  end
  subgraph Server
    IDP[basis-auth IdP]
    PORTAL[Admin portal]
  end
  subgraph Upstream
    MSFT[Microsoft Entra]
  end
  DB[(PostgreSQL)]

  APP -->|OIDC redirect| IDP
  IDP -->|MS OIDC| MSFT
  ADM -->|session| PORTAL
  PORTAL -->|OIDC login| IDP
  IDP --> SQL1[(reads / writes)]
  PORTAL --> SQL2[(least privilege)]
```

The IdP is the only component that talks to Microsoft Entra. The portal never
sees upstream credentials: it authenticates its operators *through* the IdP
itself using authorization code flow with PKCE.

```mermaid
flowchart TD
  U[Browser] --> A[GET /auth/start]
  A --> B[Portal builds<br/>PKCE + state cookie]
  B --> C[Redirect to IdP<br/>/oauth/authorize]
  C --> D{SSO session?}
  D -- yes --> E[Consent or auto-approve]
  D -- no --> F[Login UI]
  F --> G[Microsoft]
  G --> H[Callback attaches user]
  H --> E
  E --> I[Code to portal callback]
  I --> J[Token exchange +<br/>permission check]
  J --> K[Admin session cookie]
```

## Token model

Access tokens are ten-minute RS256 JWTs (`typ=at+jwt`) whose audience names a
resource API. Refresh tokens rotate on every use; reusing a rotated token
revokes the entire token family.

```mermaid
sequenceDiagram
  autonumber
  participant App as Application BFF
  participant IdP as basis-auth
  participant API as Resource API
  App->>IdP: POST /oauth/token (code, verifier)
  IdP-->>App: access_token + refresh_token
  App->>API: Authorization: Bearer access_token
  API-->>App: 200 (JWT validated locally)
  Note over App,IdP: Later, near expiry
   App->>IdP: POST /oauth/token (refresh_token)
   IdP-->>App: new refresh token family entry

## Performance and caching

The hot path is built for throughput on a single instance:

- **Client metadata cache** (`src/oauth/clientCache.ts`) — clients and resource
  servers are loaded once and cached in an LRU; `redirectUriSet` and
  `filterContentSet` make per-request checks O(1).
- **Single-query identity assembly** — token and userinfo responses are built
  from one query plus memoized key/permission lookups, so user and permission
  data are computed once per token issue.
- **Atomic refresh rotation** — refresh-token families rotate in a single
  transaction; reuse revokes the whole family.
- **Rate limiting** (`src/middleware/rateLimit.ts`) — a fixed-window,
  process-local limiter (120 req/min per IP+route) guards the token, revoke,
  authorize, consent, Microsoft callback, and `/api/me` endpoints.
- **Discovery and JWKS caching** — `/.well-known/*` and `/oauth/jwks` send
  `Cache-Control: public, max-age=300`.
- **Session idle timeout** — SSO sessions expire after `SESSION_IDLE_TIMEOUT_MS`
  of inactivity (default 12h) and absolutely after `SESSION_ABSOLUTE_MAX_MS`
  (default 30d); last-seen time is refreshed at most every five minutes.

Avatar bytes are served from `/api/picture/:userId` and are only available to
the signed-in user themselves (SSO session required, self-only). The
`permissions` claim is only emitted when the issued token's scope includes
`permissions`.
```
