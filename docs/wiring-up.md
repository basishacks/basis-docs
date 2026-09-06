# Wiring Up: Porting Apps to basis-auth / DevConnect, and Writing New DevConnect Apps

This guide shows how to connect an application to `basis-auth` (user-facing name: **DevConnect**)
as its OpenID Connect Provider, and how to protect a resource API with DevConnect access tokens.
It covers two paths:

- **Path A — new application:** you are writing a fresh app or API that uses DevConnect from day one.
- **Path B — port:** you have an existing app (passwords, direct Microsoft MSAL, shared sessions,
  self-issued JWTs, or a third-party IdP) and you want to move it onto DevConnect.

It is written against the actual implementation in this repo (`src/app.ts`, `src/config.ts`,
`src/oauth/service.ts`, `src/oauth/scopes.ts`, `src/microsoft.ts`, `src/database/schema.ts`,
`src/internal/`, `examples/hono-resource-server/`). Where behavior is stated as a fact
(endpoints, token lifetimes, required parameters), it matches that code.

## 0. Terminology: basis-auth vs DevConnect

- **basis-auth** is the repository / service name: the Hono-based OpenID Connect Provider,
  the PostgreSQL store, the React login/consent UI, and the management portal backend.
- **DevConnect** is the user-facing product name for the same service: the shared sign-in
  students see ("Sign in with DevConnect"), which itself delegates human login to Microsoft Entra ID.

When this guide says "the IdP", it means `basis-auth` / DevConnect interchangeably.
`OIDC_ISSUER` (e.g. `http://localhost:3000` locally, `https://auth.bisz.dev`-style in production)
is the IdP origin. Everything below hangs off that origin.

## 1. The mental model (read this first)

```
Browser --> Your App (BFF) --> DevConnect IdP --> Microsoft Entra
                |                      |
                +--> Resource API <----+
                     (validates JWT locally via /oauth/jwks)
```

There are exactly four parties:

1. **Browser** — untrusted. Never give it a refresh token in readable storage.
2. **Your application BFF (backend-for-frontend)** — owns the browser session. This is *your*
   server process (Hono, Express, FastAPI, Next.js route handlers, etc.). It holds the client
   secret (confidential clients), the PKCE verifier, and the refresh token.
3. **DevConnect IdP** — authenticates the human (via Microsoft Entra), runs the
   authorization-code flow, issues ID tokens (login proof for your BFF), access tokens
   (for resource APIs), and refresh tokens (for your BFF only).
4. **Resource API** — a separately deployed HTTP API that accepts DevConnect access tokens.
   It validates JWTs locally with the published JWKS and never calls the IdP per request.

### The five rules that prevent 90% of integration bugs

1. **Your app owns its browser session.** DevConnect sets its own SSO cookie (`basis_sso`)
   on the IdP origin only. You must not forward, inspect, or share that cookie. After login,
   create your *own* HTTP-only session cookie on *your* origin.
2. **ID tokens authenticate the login; access tokens authorize API calls.** Validate the ID
   token in your BFF to establish who just logged in. Send only the access token as
   `Authorization: Bearer ...` to resource APIs. Resource APIs must never accept ID tokens.
3. **UserInfo is for intentional profile reads, not per-request auth.** Call
   `/oauth/userinfo` with an access token when you want profile claims. Do not use it as
   a per-request token-validation mechanism — validate the JWT locally instead.
4. **Refresh tokens live server-side, encrypted.** The browser never sees them. Store them
   in your BFF session store (database, Redis, encrypted store), never in `localStorage`.
5. **One `resource` audience per authorization request.** The `resource` parameter names the
   API the access token is for (e.g. `urn:basis:api:example`). The issued access token's
   `aud` is exactly that audience. If your frontend talks to two APIs, either run two
   authorization flows (one per audience) or route through one audience.

### Token model at a glance

| Token | Format | Lifetime | Audience | Validated by | Notes |
| --- | --- | --- | --- | --- | --- |
| Authorization code | opaque, single-use | ~10 min (request expiry) | your `client_id` + `redirect_uri` | IdP `/oauth/token` | PKCE `code_verifier` required, always |
| ID token | RS256 JWT | short | your `client_id` | your BFF (JWKS) | Login proof only; has `nonce`; never send to resource APIs |
| Access token | RS256 JWT, `typ=at+jwt` | **10 minutes** | the `resource` audience | resource API (JWKS, local) | Claims: `sub`, `client_id`, `scope`, `permissions`, `jti`, `iat`, `exp` |
| Refresh token | opaque, rotating | **30 days** | your `client_id` + resource | IdP `/oauth/token` | Only issued when `offline_access` scope requested; rotation reuses revoke the whole family |

Access-token claims (see `examples/hono-resource-server/auth.ts` and `src/oauth/service.ts`):

```json
{
  "iss": "https://your-idp-origin",
  "aud": "urn:basis:api:example",
  "sub": "user-uuid",
  "client_id": "your-client-id",
  "scope": "openid profile email permissions projects.read offline_access",
  "permissions": ["participant"],
  "jti": "token-id",
  "iat": 1710000000,
  "exp": 1710000600
}
```

The `permissions` claim is only emitted when the granted scope includes `permissions`.
Permission changes and user disablement take effect on resource APIs when the current
ten-minute access token expires — unless the API also does the immediate-revocation check
(Section 8).

## 2. Protocol surface you will touch

Base everything off discovery, not hardcoded paths. `GET /.well-known/openid-configuration`
returns (see `src/app.ts` `openidConfiguration`):

| Field | Value |
| --- | --- |
| `issuer` | your `OIDC_ISSUER` |
| `authorization_endpoint` | `{issuer}/oauth/authorize` |
| `token_endpoint` | `{issuer}/oauth/token` |
| `userinfo_endpoint` | `{issuer}/oauth/userinfo` |
| `jwks_uri` | `{issuer}/oauth/jwks` |
| `revocation_endpoint` | `{issuer}/oauth/revoke` |
| `end_session_endpoint` | `{issuer}/oauth/logout` |
| `response_types_supported` | `["code"]` — code flow only |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `token_endpoint_auth_methods_supported` | `["client_secret_basic", "none"]` |
| `code_challenge_methods_supported` | `["S256"]` — PKCE S256 is mandatory for every client type |
| `scopes_supported` | `openid profile email permissions offline_access` plus your resource scopes |
| `claims_supported` | `sub name picture email email_verified permissions` |

Full endpoint table:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/.well-known/openid-configuration` | GET | OIDC discovery (cache 5 min) |
| `/.well-known/oauth-authorization-server` | GET | OAuth metadata (cache 5 min) |
| `/oauth/authorize` | GET | Start authorization code flow; serves the login/consent UI |
| `/oauth/interaction` | GET | JSON describing the pending interaction (`uid`, `prompt`, `client`, `scopes`, `resources`, `csrfToken`) — used by the React UI |
| `/oauth/interaction/:uid/consent` | POST | Allow/deny consent (UI internal; your app does not call this) |
| `/oauth/upstream/microsoft` | GET | Begin Microsoft Entra redirect (UI internal) |
| `/oauth/callback/microsoft` | GET | Microsoft return (IdP internal; register this URI in Entra) |
| `/oauth/token` | POST | Exchange code for tokens; exchange refresh token for new tokens |
| `/oauth/userinfo` | GET, POST | Identity claims for a valid access token |
| `/oauth/jwks` | GET | RS256 public signing keys (cache 5 min + stale-while-revalidate) |
| `/oauth/revoke` | POST | Revoke a refresh token |
| `/oauth/logout` | GET, POST | Destroy the IdP SSO session |
| `/api/me` | GET | Current IdP SSO identity (IdP-origin session only; not for downstream apps) |

Your application only calls: `authorize` (browser redirect), `token`, `userinfo`
(optional profile read), `jwks` (indirectly via your JWT library), `revoke`, `logout`.
You never call the interaction, upstream, or callback endpoints directly — the browser
does that by following redirects through the IdP UI.

## 3. Registration: clients and resources

Registration is configuration plus database seeding. Understand both or you will be
confused when a removed client "comes back".

### 3.1 The two JSON blobs

`OIDC_RESOURCES_JSON` declares API audiences and the scopes each API accepts:

```json
[
  { "audience": "urn:basis:api:example", "scopes": ["projects.read", "projects.write"] }
]
```

`OIDC_CLIENTS_JSON` declares which resources and scopes each application may request:

```json
[
  {
    "clientId": "my-app",
    "name": "My App",
    "clientSecret": "replace-with-a-long-random-client-secret-at-least-16-chars",
    "redirectUris": ["http://localhost:4000/oauth/callback"],
    "public": false,
    "scopes": ["openid", "profile", "email", "permissions", "offline_access", "projects.read"],
    "resources": ["urn:basis:api:example"],
    "requireConsent": true,
    "filterMode": null,
    "filterContent": []
  }
]
```

Field reference (validated by `clientSchema` in `src/config.ts`):

| Field | Required | Rules |
| --- | --- | --- |
| `clientId` | yes | Unique. Omitted when using `clients:add` (a UUID is generated and printed). |
| `name` | no | Displayed on the consent screen. |
| `clientSecret` | confidential only | Minimum 16 chars. Forbidden on public clients; required on confidential clients. Stored in PostgreSQL as a scrypt hash, never plaintext. The TUI auto-generates a `sk-...` secret when left blank (shown once). |
| `redirectUris` | yes | Minimum 1, all valid URLs. The authorize `redirect_uri` must match one *exactly*. Register every environment's callback (local, staging, prod) — or use separate clients per environment (recommended). |
| `public` | yes | `false` = confidential BFF (uses `client_secret_basic`). `true` = public client (SPA/native, `token_endpoint_auth_method=none`, must not send a secret). |
| `scopes` | yes | Union of identity scopes and resource scopes the client may request. Requests outside this set fail with `invalid_scope` (code 14401). |
| `resources` | yes | Minimum 1. Every entry must exist in `OIDC_RESOURCES_JSON`, or startup fails. Authorize requests for other resources fail with `invalid_target` (14501). |
| `requireConsent` | yes (default `true`) | `true` = show Allow/Deny consent (remembered per client + expanded scope set). `false` = silently approve registered grants — only for first-party apps you operate. |
| `filterMode` / `filterContent` | optional | `"whitelist"` = only the normalized lowercase emails in `filterContent` may sign in; `"blacklist"` = those emails are rejected; `null` + `[]` = allow all. Setting content without a mode fails startup validation. |
| Owners (portal-managed) | portal | The portal stores `owners` in client metadata; seed JSON does not set them. |

Scope semantics (see `src/oauth/scopes.ts`):

- Identity scopes: `openid`, `profile`, `email`, `permissions`, `offline_access`.
  `offline_access` is required to receive a refresh token. `permissions` is required for
  the `permissions` claim to appear in tokens and UserInfo.
- Resource scopes: free-form strings declared per resource (e.g. `projects.read`).
- Wildcard: a granted scope ending in `.all` covers anything under that prefix
  (`projects.all` covers `projects.read` and `projects.write.nested`). Use sparingly.

### 3.2 How seeding works (read before editing)

On startup the server applies checked-in Drizzle migrations and **idempotently upserts**
configured clients and resource servers (`README.md`, `src/database/seed.ts`). Consequences:

- Adding a client to `OIDC_CLIENTS_JSON` and restarting creates it.
- Editing the JSON and restarting updates it.
- **Removing an entry from the JSON does not delete it from the database.** You must also
  delete it explicitly, otherwise the seed recreates it on next boot.
- Never delete-then-seed in the wrong order: remove from JSON first, then delete from DB.

Interactive management with `bun run clients` (menu: list, add, remove, edit,
register resource). Adding or editing walks through name, type, redirect URIs,
resources, scopes, consent, and account filters; a blank secret auto-generates a
`sk-...` secret that is printed once (only a scrypt hash is stored). Audiences
that are not registered yet are created live on save — no restart, no
`OIDC_*_JSON` edit. New clients authorize instantly; edits apply within ~60s
(client-cache TTL). The list flags references without a registry row as `WARNING`.

Non-interactive equivalents (client JSON without `clientId` generates a UUID;
a missing secret is auto-generated):

```bash
bun run clients:add -- '{"name":"My App","redirectUris":["https://app.example.org/oauth/callback"],"public":false,"resources":["urn:basis:api:example"]}'

# Delete by UUID (cascades to its authorization data: requests, codes, refresh families, consents)
bun run clients:remove -- 3fa85f64-5717-4562-b3fc-2c963f66afa6
```

### 3.3 Choosing confidential (BFF) vs public (SPA/native)

|  | Confidential BFF (recommended) | Public client |
| --- | --- | --- |
| Example | Hono/Express/FastAPI/Next.js server app | Pure SPA with no backend, mobile app |
| Secret | Yes, `client_secret_basic` on `/oauth/token` and `/oauth/revoke` | No secret, `token_endpoint_auth_method=none`; sending one fails with code 14003 |
| PKCE | Required (S256) | Required (S256) — this is the *only* client authentication |
| Refresh token storage | Server-side session store, encrypted | No safe storage in a pure SPA — prefer short sessions + re-login, or add a BFF |
| CORS | Not needed (server-to-server token calls) | Needs `CORS_ALLOWED_ORIGINS` to include your origin for `/oauth/token` and `/oauth/userinfo` |

Default to a confidential BFF. Choose public only when there is genuinely no backend,
and accept the weaker refresh story. A static frontend that gains any server component
later should be promoted to confidential at that point.

### 3.4 Per-environment registration recipe

1. Create one client per environment (`my-app-local`, `my-app-staging`, `my-app-prod`) or
   one client with all three redirect URIs. Separate clients give separate secrets, separate
   consent records, and safer revocation — prefer them.
2. Local redirect: `http://localhost:4000/oauth/callback` (whatever port your BFF listens on).
3. Production redirect must be HTTPS and exactly what your BFF sends in `redirect_uri`.
4. Keep `filterMode: null` + `filterContent: []` unless you need per-client account gating
   (Section 11). School-wide apps normally allow all `@basischina.com` accounts; the
   allow-listing happens at the Microsoft tenant level, not per client.

## 4. Path A: new application from scratch (confidential BFF)

This is the reference flow. Every port in Path B converges onto it.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as Your BFF
  participant I as DevConnect IdP
  participant M as Microsoft Entra
  B->>A: GET /login
  A->>A: create BFF session; store state, nonce, PKCE verifier
  A->>B: 302 {issuer}/oauth/authorize?...
  B->>I: GET /oauth/authorize
  I->>B: login UI (or SSO skip)
  B->>M: Microsoft login
  M->>I: GET /oauth/callback/microsoft
  I->>B: consent (Allow)
  B->>A: GET /oauth/callback?code=...&state=...
  A->>I: POST /oauth/token (code + verifier + client_secret_basic)
  I-->>A: id_token + access_token (+ refresh_token)
  A->>A: validate ID token; create app session cookie
  A->>B: Set-Cookie app_session; redirect to /
```

### Step 1 — Discover the IdP

At BFF startup, fetch `{issuer}/.well-known/openid-configuration` and cache it. Read
`authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, `jwks_uri`,
`revocation_endpoint`, `end_session_endpoint` from the document — never hardcode the
`/oauth/*` paths. Cache discovery + JWKS for at least 5 minutes (the IdP sends
`Cache-Control: public, max-age=300`).

### Step 2 — Start login: state, nonce, PKCE

When the browser hits your `/login`:

1. Generate `state` (≥ 32 random bytes, base64url), `nonce` (≥ 32 random bytes), and a
   PKCE `code_verifier` (43–128 chars from `[A-Za-z0-9-._~]`). Derive
   `code_challenge = BASE64URL(SHA256(verifier))` with `code_challenge_method=S256`.
   `plain` is not supported; `nonce` alone is not a substitute for PKCE.
2. Store all three server-side in a short-lived BFF session (5–10 min TTL), keyed by a
   cookie you set (or your existing session). They must never be guessable from the browser.
3. Redirect the browser to the authorization endpoint with **every** parameter below:

```text
{authorization_endpoint}?
  client_id=my-app&
  response_type=code&
  redirect_uri=https%3A%2F%2Fapp.example.org%2Foauth%2Fcallback&
  scope=openid%20profile%20email%20permissions%20offline_access%20projects.read&
  resource=urn%3Abasis%3Aapi%3Aexample&
  state=RANDOM_STATE&
  nonce=RANDOM_NONCE&
  code_challenge=DERIVED_CHALLENGE&
  code_challenge_method=S256
```

Parameter rules (enforced in `oauth.startAuthorization`, `src/app.ts`):

- `client_id`: must be registered.
- `response_type`: must be `code`. `response_type=token` is rejected (`unsupported_response_type`, 14429).
- `redirect_uri`: must exactly match a registered URI. OAuth 2.1 clients do not need to
  repeat it at the token step, but if supplied there it must match exactly.
- `scope`: space-separated. Every entry must be in the client's registered scopes and
  (for resource scopes) accepted by the requested resource, else `invalid_scope` (14401).
  Include `offline_access` if you want a refresh token.
- `resource`: exactly one audience, must be registered for the client, else
  `invalid_target` (14501) / `unknown_resource` (14407).
- `state`, `nonce`, `code_challenge` + `code_challenge_method=S256`: all required.
  `state` is returned verbatim so you can verify CSRF; `nonce` is bound into the ID token.

Minimal Node helper (standard library only):

```ts
import { createHash, randomBytes } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64url");
export function newState() { return b64url(randomBytes(32)); }
export function newNonce() { return b64url(randomBytes(32)); }
export function newVerifier() { return b64url(randomBytes(32)); } // 43 chars, valid range
export function challengeFor(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
```

### Step 3 — Handle the callback and exchange the code

The IdP redirects the browser to your `redirect_uri` with `?code=...&state=...`
(or `?error=access_denied&...` if the user pressed Deny — show a friendly "sign-in
cancelled" page, do not retry automatically).

In your callback handler:

1. Verify `state` matches the stored value for this BFF session; reject mismatches (CSRF).
2. From your BFF (server-to-server, never from the browser), POST to the token endpoint:

```bash
curl -u 'my-app:YOUR_CLIENT_SECRET' \
  -d 'grant_type=authorization_code' \
  -d 'code=AUTHORIZATION_CODE' \
  -d 'code_verifier=ORIGINAL_VERIFIER' \
  --data-urlencode 'redirect_uri=https://app.example.org/oauth/callback' \
  https://your-idp-origin/oauth/token
```

```ts
// BFF token exchange (Node 24, global fetch)
const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const res = await fetch(tokenEndpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${basic}`,
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: storedVerifier,
    redirect_uri: registeredRedirectUri, // optional under OAuth 2.1, must match if sent
  }),
});
if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
const { id_token, access_token, refresh_token, expires_in } = await res.json();
```

Rules: confidential clients authenticate with `client_secret_basic` (Authorization header).
Putting `client_secret` in the POST body is rejected (`invalid_client` — "Use
client_secret_basic"). Public clients send `client_id` in the body and no secret.

### Step 4 — Validate the ID token, then create your own session

Validate the ID token **in your BFF** with `jose` (or your platform's OIDC library):

- Signature against `{issuer}/oauth/jwks` (RS256 only), exact `iss` match, `aud` is your
  `client_id`, lifetime valid, `nonce` matches the stored value.
- Then extract `sub` (stable user UUID — use this as your user key, not email),
  `email`, `name`, `picture`, `permissions` (only present if you requested the
  `permissions` scope).

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL(`${issuer}/oauth/jwks`));
const { payload } = await jwtVerify(id_token, jwks, { issuer, audience: clientId });
if (payload.nonce !== storedNonce) throw new Error("nonce mismatch");
// payload.sub is the user id. Create-or-update your local user row here.
```

Then:

1. Create your application's own session (database row / Redis entry / signed cookie —
   your choice) containing the user id, and set your own HTTP-only, `Secure`, `SameSite=Lax`
   session cookie on your origin.
2. If a `refresh_token` was issued, **encrypt it** (e.g. AES-GCM with a KMS/local key) and
   store it in the server-side session record. Never put it in a cookie readable by JS,
   never return it to the browser.
3. Keep the access token server-side alongside the session (or refetch via refresh when
   needed). The browser calls your BFF; your BFF calls resource APIs with
   `Authorization: Bearer <access_token>`.
4. Delete the one-time `state`/`nonce`/verifier record.

### Step 5 — Call resource APIs from the BFF

```ts
const apiRes = await fetch("https://api.example.org/api/projects", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (apiRes.status === 401) {
  // access token expired or invalid -> refresh (Step 6), retry once, else re-login
}
```

The browser never talks to the resource API directly with the user's token in the
reference architecture. If your frontend is a JS SPA, it calls your BFF same-origin;
your BFF attaches the bearer token. Direct browser-to-API calls are only for the
public-client variant (Section 6) with CORS enabled.

### Step 6 — Refresh before the 10-minute expiry

Proactively refresh when the access token has less than ~60–120s left (decode the JWT
`exp` client-side in the BFF — no I/O needed), or reactively on a single 401 followed
by one retry.

```ts
const res = await fetch(tokenEndpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${basic}`,
  },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: storedRefresh }),
});
const next = await res.json(); // new access_token + rotated refresh_token
// Replace the stored refresh token. The old one is now consumed;
// reusing it revokes the entire token family (theft protection).
```

Rotation semantics (implemented atomically in `src/oauth/service.ts`): every refresh
returns a **new** refresh token and consumes the old one. Reusing a consumed token
signals possible theft and revokes the whole family — the user must sign in again.
So: persist the new refresh token before using it, serialize concurrent refreshes per
session (one in-flight refresh at a time), and treat "refresh rejected" as "re-login".

### Step 7 — Logout

Full logout is three actions in your BFF's `/logout` handler:

1. Revoke the stored refresh token (server-to-server):

```bash
curl -u 'my-app:YOUR_CLIENT_SECRET' \
  -d 'token=REFRESH_TOKEN' \
  https://your-idp-origin/oauth/token  # emitter: /oauth/revoke
```

```text
POST {issuer}/oauth/revoke
Authorization: Basic BASE64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

token=<refresh_token>
```

2. Delete your BFF session record and clear your app session cookie.
3. Redirect the browser to `{issuer}/oauth/logout` to end the shared DevConnect SSO
   session (otherwise the next `/login` silently re-authenticates without Microsoft).
   Note the IdP logout clears the interaction user and returns to the original
   authorization URL; the user's Microsoft session stays alive separately (by design).

Per-user global revocation (admin action, portal): disabling a user kills sessions and
revokes tokens; the `tokens_valid_after` barrier plus `loadTokenSubject` (Section 8)
enforces it within the ten-minute access-token window, or immediately for APIs that
check per request.

## 5. Reference BFF skeleton (Hono + jose, copy-adapt)

This is the smallest confidential-client BFF that follows the guide. Dependencies:
your existing web framework + `jose`. Session store is an in-memory `Map` below —
replace with your database in production.

```ts
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = process.env.BASIS_AUTH_ISSUER!; // e.g. http://localhost:3000
const CLIENT_ID = process.env.BASIS_CLIENT_ID!;
const CLIENT_SECRET = process.env.BASIS_CLIENT_SECRET!;
const REDIRECT_URI = process.env.BASIS_REDIRECT_URI!; // registered exactly
const RESOURCE = process.env.BASIS_RESOURCE!; // e.g. urn:basis:api:example
const API_BASE = process.env.BASIS_API_BASE!;

const b64url = (b: Buffer) => b.toString("base64url");
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/oauth/jwks`));
const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

// ponytail: in-memory stores; use your database/Redis in production.
const pending = new Map<string, { state: string; nonce: string; verifier: string; exp: number }>();
const sessions = new Map<string, { userId: string; accessToken: string; refreshToken?: string; exp: number }>();

const app = new Hono();

app.get("/login", async (c) => {
  const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  const sessionKey = b64url(randomBytes(16));
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  pending.set(sessionKey, {
    state, nonce,
    verifier,
    exp: Date.now() + 10 * 60 * 1000,
  });
  setCookie(c, "oidc_pending", sessionKey, { httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email permissions offline_access projects.read",
    resource: RESOURCE,
    state, nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return c.redirect(`${discovery.authorization_endpoint}?${params}`, 302);
});

app.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (c.req.query("error")) return c.text(`Sign-in cancelled: ${c.req.query("error")}`, 400);
  const key = getCookie(c, "oidc_pending");
  const p = key ? pending.get(key) : undefined;
  pending.delete(key ?? "");
  if (!code || !p || p.state !== state || p.exp < Date.now()) return c.text("invalid login state", 400);

  const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: p.verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) return c.text("token exchange failed", 502);
  const tokens = await tokenRes.json();

  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: ISSUER, audience: CLIENT_ID });
  if (payload.nonce !== p.nonce) return c.text("nonce mismatch", 400);

  const sessionId = b64url(randomBytes(32));
  const accessExp = (JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).exp ?? 0) * 1000;
  sessions.set(sessionId, {
    userId: payload.sub!,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token, // encrypt before storing in production
    exp: accessExp,
  });
  setCookie(c, "app_session", sessionId, { httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  return c.redirect("/", 302);
});

app.get("/api/projects", async (c) => {
  const s = sessions.get(getCookie(c, "app_session") ?? "");
  if (!s) return c.json({ error: "unauthorized" }, 401);
  // Refresh when under 90s of life left (see Section 4 Step 6 for rotation handling).
  const apiRes = await fetch(`${API_BASE}/api/projects`, {
    headers: { Authorization: `Bearer ${s.accessToken}` },
  });
  return c.json(await apiRes.json(), apiRes.status as 200);
});

app.post("/logout", async (c) => {
  const id = getCookie(c, "app_session");
  const s = id ? sessions.get(id) : undefined;
  if (s?.refreshToken) {
    const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
    await fetch(discovery.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ token: s.refreshToken }),
    }).catch(() => {});
  }
  if (id) sessions.delete(id);
  deleteCookie(c, "app_session", { path: "/" });
  return c.redirect(`${ISSUER}/oauth/logout`, 302);
});

export default app;
```

Production hardening on top of this skeleton: persistent session store, AES-GCM
encryption of refresh tokens, single-flight refresh per session, CSRF protection on
your own POST routes, `Secure` cookies (required behind HTTPS), and structured logging
of `error`/`error_description` from the token endpoint.

## 6. Public-client variant (SPA / mobile, no backend)

Use only when there is genuinely no server. Register with `"public": true` and no
`clientSecret`. Ask the operator to add your origin to `CORS_ALLOWED_ORIGINS` so the
browser can call `/oauth/token` and `/oauth/userinfo`.

Flow differences from Section 4:

- Token and revocation calls send `client_id` in the POST body and no `Authorization` header.
- PKCE is your only credential — generate the verifier with `crypto.getRandomValues` /
  `crypto.subtle.digest("SHA-256")` in the browser and keep it in memory (not localStorage).
- Do not request `offline_access` unless you have a safe refresh story; without a backend
  there is nowhere safe to keep a 30-day refresh token. Prefer session-length logins and
  re-authorize.
- Expect `invalid_client` code 14003 if a secret is ever sent — that is the server telling
  you the client is registered as public.

```ts
// Browser PKCE (WebCrypto, no dependency)
const rand = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const verifier = rand(32);
const challenge = btoa(String.fromCharCode(...new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
```

The moment the project gains any server component, register a confidential client and
move the token exchange + refresh storage there. The authorize URL is identical apart
from `client_id`.

## 7. Resource API from scratch

Copy `examples/hono-resource-server/` — it is the contract reference. The middleware:

- downloads and caches `/oauth/jwks` (`createRemoteJWKSet`);
- allows only RS256 with `typ=at+jwt` (rejects ID tokens and foreign JWTs structurally);
- validates exact `issuer`, exact `audience`, and token lifetime;
- checks required claims (`sub`, `client_id`, `scope`, `permissions`, `jti`, `iat`);
- exposes `requireScopes()` (token's space-separated `scope` must cover all required;
  `.all` prefix wildcards apply per `src/oauth/scopes.ts`) and `requirePermissions()`
  (token's `permissions` array must cover all required).

```ts
// From examples/hono-resource-server/index.ts — the whole integration is this small:
import { Hono } from "hono";
import { basisAuth, requirePermissions, requireScopes } from "./auth.js";

const app = new Hono();
app.use("/api/*", basisAuth({
  issuer: process.env.BASIS_AUTH_ISSUER ?? "http://localhost:3000",
  audience: process.env.API_AUDIENCE ?? "urn:basis:api:example",
}));
app.get("/api/projects",
  requireScopes("projects.read"),
  requirePermissions("participant"),
  (c) => c.json({ userId: c.get("basisToken").sub, projects: [] }),
);
```

Registration pairing: the API's `audience` must appear in `OIDC_RESOURCES_JSON` with the
scopes the API enforces, and every client calling the API must list that audience in its
`resources` and the scopes in its `scopes`. Mismatches fail fast with 14401/14407/14501 —
treat those codes as "fix registration", not "retry".

Non-Hono stacks implement the same contract with their standard OAuth resource-server
library: fetch JWKS from `{issuer}/oauth/jwks`, enforce `alg=RS256` + `typ=at+jwt` +
exact `iss`/`aud` + expiry, then check `scope`/`permissions`. The example's `auth.test.ts`
shows the claim-shape assertions to replicate.

## 8. Immediate revocation (disabled users, `tokens_valid_after`)

APIs that only verify JWTs locally observe disablement and permission changes when the
ten-minute access token expires. For immediate per-user revocation, load the token
subject's state after signature validation and reject disabled subjects and tokens whose
`iat` is at or before the barrier — exactly what the example's `loadTokenSubject` does:

```ts
app.use("/api/*", basisAuth({
  issuer, audience,
  loadTokenSubject: async (subject) => {
    // GET {internal}/internal/users/:userId with INTERNAL_API_TOKEN (Section 12).
    // Return { disabled, tokensValidAfter } | undefined.
  },
}));
```

The rule (from `examples/hono-resource-server/auth.ts`): reject when the subject is
missing, `disabled` is true, or `iat * 1000 <= tokensValidAfter.getTime()`. Keep this
check local to the resource API (a fast internal lookup), not a call to the IdP per request.

## 9. Users, permissions, and profile data

- **Stable key:** `sub` (UUID in `users.id`). Keyed to `(provider, upstreamIssuer,
  upstreamSubject)` — stable across email renames. Store `sub`, not email, as your
  foreign key.
- **Permissions:** string labels (`participant` default via `DEFAULT_PERMISSION`, `admin`
  via bootstrap/portal). Request the `permissions` scope to receive the `permissions`
  claim in ID tokens, access tokens, and UserInfo. Guard APIs with `requirePermissions()`;
  guard portal-style admin routes with the relevant permission, never with email equality.
- **First admin:** list the operator's Microsoft email in
  `BOOTSTRAP_PERMISSION_GRANTS_JSON`; the grant applies on first boot when absent from
  the DB, then manage grants from the portal afterwards.
- **Profile:** `name`, `email`, `email_verified`, `picture` come from UserInfo
  (`GET/POST /oauth/userinfo` with the access token) or the ID token. Avatar bytes live
  at the IdP's `/api/picture/:userId` and are self-only (the IdP SSO session of the
  requested user is required) — fetch and cache them server-side in your BFF, never expose
  the IdP session cookie to do it.
- **Consent memory:** Allow decisions are remembered per user + client + expanded scope
  set. Changing requested scopes re-prompts. `requireConsent: false` clients skip the
  screen for registered grants. Users revoke remembered consent from the portal; admins
  can drop it via the consents API.

## 10. Path B: porting an existing application

### 10.1 Identify your starting point

| Current auth | What changes | What stays |
| --- | --- | --- |
| Username/password (own user table, bcrypt, reset flows) | Delete password storage, hashes, reset tokens, login-attempt throttling on passwords; replace login UI with "Sign in with DevConnect" | Your user table (add `devconnect_sub` column), your roles (map to permissions), your sessions (re-key to `sub`) |
| Direct Microsoft MSAL (each app has its own Entra registration) | Delete your Entra client, MSAL config, tenant logic; point the OIDC flow at DevConnect instead (DevConnect keeps the single Entra integration) | Microsoft accounts themselves; your post-login user provisioning (re-keyed) |
| Shared session / monolith cookie across apps | Split into per-app BFF sessions; stop reading the shared cookie; each app runs the code flow independently | Session store technology (now keyed per app) |
| Self-issued JWTs / API keys for first-party clients | Keep your API's auth middleware shape, swap the verification to DevConnect JWKS + audience + scopes/permissions | Route structure, scope names (declare them as resource scopes) |
| Auth0 / Firebase / Supabase / other IdP | Swap discovery issuer, client id/secret, JWKS URL; remap claims (`sub` is now a new UUID space — migrate by email once, then key on `sub`) | Most BFF flow code if you already use authorization-code + PKCE |

The single biggest porting decision: **nobody verifies passwords or talks to Entra except
DevConnect anymore.** Your app's login page becomes a one-button redirect. Everything
else (sessions, permissions, API authz) adapts around that.

### 10.2 Strangler migration (recommended for any app with users today)

1. **Register first, code later.** Get staging + prod clients and your resource audience
   registered (Section 3). Verify discovery and JWKS from your network before writing code.
2. **Add DevConnect as a second login button** alongside the old login. New sessions created
   via DevConnect store both your legacy user id and the new `devconnect_sub`.
3. **Join accounts by email once.** On first DevConnect login, match `email` (lowercased)
   to your existing user, write `devconnect_sub`, and never match on email again. Orphan
   DevConnect-only accounts (no legacy match) become new users through your normal
   provisioning path.
4. **Dual-run.** Both login paths issue your existing app session format. Ship, monitor
   (login success rate per path, token-exchange errors, `state` mismatches), and move
   internal users first.
5. **Migrate API auth.** Deploy the JWKS-validating middleware next to the old check;
   accept either during dual-run, then remove the old check. Resource servers can validate
   both issuers temporarily if you must, but time-box it.
6. **Cut over.** Remove the old login UI, password routes, and MSAL/legacy IdP config.
   Scrub secrets from env and secret stores. Force global re-login if the old session
   format is untrustworthy (rotate your session keys).
7. **Clean up data.** Drop password hashes and reset tokens (or the whole legacy auth
   column family) in a migration *after* the cutover sticks. Keep an audit trail of the
   `email -> sub` join for support.

### 10.3 Case notes

**From passwords:** the login form, `bcrypt`/`argon2` verification, "forgot password",
email verification for passwords, and password-breach screening all go away. Keep email
verification state if you use it for non-auth purposes, but treat `email_verified` from
DevConnect/UserInfo as the identity signal. Rate limiting moves from "per password attempt"
to the IdP's built-in 120 req/min per IP+route plus your own login-start throttling.

**From direct MSAL:** remove `msal` / Entra client ids from every app; keep exactly one
Entra registration — DevConnect's. Your `redirect_uri`s change from `.../auth/msal/callback`
to your new DevConnect callback. Tenant-specific issuer config (`MICROSOFT_ISSUER`, not
`/common`) lives only in the IdP's env now. Per-app account restrictions move to
`filterMode`/`filterContent` (Section 11).

**From shared monolith sessions:** each app gets its own session cookie and store. The
SSO experience is preserved *through the IdP*: after signing in once, the second app's
authorize redirect finds the DevConnect SSO session and skips Microsoft (subject to
consent). Do not try to recreate cross-app SSO with a shared cookie — that is the IdP's job.

**From self-issued JWTs:** your `aud` values become DevConnect resource audiences; declare
them in `OIDC_RESOURCES_JSON`. Your custom claims become either scopes (coarse access)
or permissions (user capabilities). The 10-minute access-token lifetime replaces any
custom expiry — design refresh (Section 4 Step 6) instead of lengthening tokens.

**From another IdP:** the BFF flow code is nearly identical (authorize → code → token →
JWKS validation). The differences are all in values: issuer, `resource` parameter
(DevConnect-specific — other IdPs often use `audience`), `typ=at+jwt` enforcement,
`permissions` claim semantics, and the `sub` namespace change. Migrate sessions by
re-login; do not try to translate foreign tokens into DevConnect tokens.

### 10.4 Data migration sketch

```sql
-- 1. Add the stable DevConnect key next to your existing user id.
ALTER TABLE app_users ADD COLUMN devconnect_sub uuid UNIQUE;

-- 2. Backfill on first DevConnect login (pseudocode, in your callback handler):
--    SELECT * FROM app_users WHERE lower(email) = lower(:devconnect_email);
--    IF found AND devconnect_sub IS NULL → UPDATE app_users SET devconnect_sub = :sub;
--    IF found AND devconnect_sub <> :sub → support case (account takeover check).
--    IF not found → INSERT new user with devconnect_sub = :sub.

-- 3. After cutover + grace period, make it NOT NULL and drop legacy auth columns.
-- ALTER TABLE app_users ALTER COLUMN devconnect_sub SET NOT NULL;
-- ALTER TABLE app_users DROP COLUMN password_hash, DROP COLUMN password_reset_token;
```

Keep `users.disabled` semantics mirrored if you have bans: banning in your app bans the
app; banning in DevConnect (portal) bans every client. Decide which your moderators need.

## 11. Account gating: `filterMode`, `filterContent`, `disabled`

Three layers, evaluated in this order during `/oauth/callback/microsoft` (`src/app.ts`):

1. `users.disabled` — global kill switch across every client. Blocked sign-ins return to
   the authorization page with `access_denied`.
2. Per-client `whitelist` — only normalized (trimmed, lowercased) emails in `filterContent`
   may use this client.
3. Per-client `blacklist` — listed emails are rejected from this client.

Use whitelist for closed pilots ("only these 30 test accounts"), blacklist for individual
removals without full disablement, and `disabled` for abuse/security. Remember the
normalization: `filterContent` entries are lowercased at config parse, and the callback
compares against the lowercased Microsoft email — write all entries lowercase.

## 12. Internal API (trusted services only)

`basis-api`-style backends use the private listener for user state, avatars, and PATCH
operations (`src/internal/app.ts`, `src/internal/users.ts`):

| Endpoint | Purpose |
| --- | --- |
| `GET /internal/users/:userId` | Subject state (`disabled`, `tokensValidAfter`), profile fields |
| `GET /internal/users/:userId/picture` | Avatar bytes |
| `PATCH /internal/users/:userId` | Profile/state updates |

It runs on a **separate listener** (`INTERNAL_API_HOST` default `127.0.0.1`,
`INTERNAL_API_PORT` default `3001`) and additionally requires
`Authorization: Bearer <INTERNAL_API_TOKEN>` (≥ 32 random chars). Keep the listener off
the public network (loopback or private VPC + firewall), use the same random token in
trusted local services, and never expose it to browsers. This is also what powers the
`loadTokenSubject` immediate-revocation check in Section 8.

## 13. CORS, cookies, CSRF, rate limits

- **CORS** (`CORS_ALLOWED_ORIGINS`, comma-separated, empty = deny all): only affects
  `/oauth/token` and `/oauth/userinfo`, and only echoes a matching `Origin`. BFF apps do
  not need it (server-to-server calls have no Origin). Set it only for public-client
  browser origins.
- **Cookies** (IdP-origin): `basis_sso` (SSO session, up to 30 days, idle expiry 12h via
  `SESSION_IDLE_TIMEOUT_MS`, absolute cap 30d via `SESSION_ABSOLUTE_MAX_MS`, last-seen
  refreshed at most every 5 min); `basis_bridge_id` (interaction id, `/oauth` path,
  10 min); `basis_bridge_error` (JSON error payload, readable by JS, `/oauth` path,
  10 min). `Secure` is set in production; non-production binds `Domain=localhost`.
  Running any public (non-localhost) host without `NODE_ENV=production` breaks every
  session — browsers drop the `Domain=localhost` dev cookies — and startup refuses
  `development` with a non-localhost issuer.
  Your app's own cookies follow the same recipe: HTTP-only, `Secure`, `SameSite=Lax`.
- **CSRF:** your `/login`→`/callback` leg is protected by `state`. Your own POST routes
  need your own CSRF tokens. The IdP's consent POST additionally requires `x-csrf-token`
  bound to the interaction id (UI-internal, shown here so you do not try to call it).
- **Rate limits** (process-local fixed window, 120 req/min per IP+route): `/oauth/token`,
  `/oauth/revoke`, `/oauth/authorize`, `/oauth/interaction/:uid/consent`,
  `/oauth/callback/microsoft`, `/api/me`. Treat sustained 429s as "back off", not "retry harder".

## 14. Configuration reference (operator checklist)

| Variable | Why it matters to your app |
| --- | --- |
| `OIDC_ISSUER` | Origin only (no path/query). Must match the running origin, the port, and the Entra redirect URI host. Mismatches break discovery, JWKS URLs, and callbacks. |
| `PORT` | IdP HTTP port (default 3000). |
| `DATABASE_URL` | PostgreSQL 14+. Migrations run at startup. |
| `OIDC_COOKIE_KEYS` | Comma-separated, each ≥ 32 chars, no placeholders. Two+ required in prod (key rotation: prepend new key, keep old until sessions age out). |
| `OIDC_JWKS_JSON` / `OIDC_JWKS_FILE` | RS256 signing keys. Auto-generated ephemerally in non-prod; **required persistent in prod**. Rotation: publish new public key alongside active, deploy everywhere, make it the first private key, retain old publics until their tokens expire (~10 min + clock skew margin, keep longer to be safe). `keys:generate` creates them. |
| `OIDC_CLIENTS_JSON` / `OIDC_RESOURCES_JSON` | Your registration (Section 3). Validate JSON before restart — startup fails loudly on unknown resources, bad secrets, or content-without-mode. |
| `DEFAULT_PERMISSION` | Granted to every signed-in user (default `participant`). Your API's baseline `requirePermissions` target. |
| `BOOTSTRAP_PERMISSION_GRANTS_JSON` | First-boot admin grants by email. One-shot per absent grant. |
| `MICROSOFT_ISSUER` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Tenant-specific Entra issuer (never `/common`); all three together or none; required in prod. Redirect URI registered in Entra: `{issuer}/oauth/callback/microsoft`. |
| `INTERNAL_API_*` | Private user-state listener + token (Section 12). |
| `CORS_ALLOWED_ORIGINS` | Browser origins for token/userinfo (Section 13). |
| `SESSION_*_MS`, `DATABASE_*` | Session lifetimes and pool tuning; defaults suit single-instance deploys. |

Production launch reminder from the README: HTTPS issuer, persistent JWKS, strong cookie
keys, Microsoft credentials, TLS PostgreSQL — plus an OpenID conformance run and a
security review of the authorization/redirect/refresh-rotation/key-management paths
before internet-facing launch.

## 15. Error handling (codes are not HTTP statuses)

The IdP returns OAuth `error` strings plus numeric `code`s. Log both; branch on the code.

| Code | `error` namespace | Meaning | App action |
| --- | --- | --- | --- |
| 14001 | `invalid_client` | Client unknown/disabled; authorize shows "not registered" | Fix `client_id` / registration |
| 14002 | `invalid_client` | Client disabled | Contact operator; show "app unavailable" |
| 14003 | `invalid_client` | Public client sent a secret | Remove secret from token calls |
| 14004 | `invalid_client` | Bad secret | Rotate/fix `clientSecret` (no retry loop) |
| 14100 | `invalid_request` | `redirect_uri` missing/unregistered | Exact-match the registered URI |
| 14401 | `invalid_scope` | Scope not permitted for client/resource | Fix requested `scope` / registration |
| 14407 | `unknown_resource` | Resource audience has no registry row (the error names it) | Re-save the client via `bun run clients` edit, or add the audience to `OIDC_RESOURCES_JSON` and restart |
| 14501 | `invalid_target` | Resource not registered for this app | Add audience to client's `resources` |
| 14429 | `unsupported_response_type` | `response_type` not `code` | Send `response_type=code` |
| 2400 | `invalid_request` | Interaction cookie missing/expired | Restart login (10-min interaction window) |
| 50040 | `server_error` | Internal login failure (e.g. Microsoft unreachable) | Show retry-once page; alert operator |
| — | `access_denied` (callback) | User pressed Deny, or account gated (`disabled`/filter) | Deny → "cancelled" page; gated → "not permitted" page, do not auto-retry |
| — | `invalid_grant` (token) | Bad/expired/consumed code or refresh reuse | Code path → re-login; refresh reuse → re-login (family revoked) |

Frontend-flow failures also set the `basis_bridge_error` cookie and redirect back to the
original authorization URL so the React UI can render the error — your BFF sees these as
`?error=...` on your own callback (deny) or as a fresh login page with an error banner.

## 16. Testing checklist (do this before prod)

- [ ] Discovery + JWKS reachable from BFF and API networks; `Cache-Control` respected.
- [ ] Happy path: login → consent Allow → callback → tokens → API 200 → logout → re-login prompts.
- [ ] Deny path shows "cancelled", no session created, no retry loop.
- [ ] Wrong `state` rejected; missing PKCE verifier rejected; `plain` challenge rejected.
- [ ] `offline_access` absent → no refresh token; present → refresh token issued.
- [ ] Access token expires (~10 min): proactive refresh works; single 401 → refresh → retry-once succeeds.
- [ ] Refresh reuse (replay old token) → family revoked → user must re-login.
- [ ] Revocation: `/oauth/revoke` then refresh fails; app session deleted.
- [ ] Scope denial: API without required scope → 403 `insufficient_scope` with `WWW-Authenticate`.
- [ ] Permission denial: token without permission → 403 `insufficient_permissions`.
- [ ] Disabled user / whitelist / blacklist each produce `access_denied`, not a crash.
- [ ] Logout ends BFF session *and* IdP SSO (second app login re-prompts).
- [ ] `bun run typecheck`, `bun run test`, and (with a real `DATABASE_URL`)
      `RUN_POSTGRES_TESTS=1 bun run test` pass for any flow change.

## 17. Security dos and don'ts

Do:

- Validate ID tokens (signature, `iss`, `aud=client_id`, expiry, `nonce`) in the BFF.
- Enforce `alg=RS256` + `typ=at+jwt` + exact `iss`/`aud` in resource APIs.
- Encrypt refresh tokens at rest; serialize refreshes; revoke + clear on logout.
- Keep `INTERNAL_API_*` loopback-only with a strong random token.
- Use separate clients + secrets per environment; rotate secrets with overlap, then revoke old sessions.

Do not:

- Never accept ID tokens in resource APIs; never use UserInfo per request as auth.
- Never put tokens in URLs (other than the one-time `code` in the IdP redirect), in
  `localStorage`, or in non-HTTP-only cookies.
- Never forward the `basis_sso` cookie, never share sessions between apps, never use
  `response_type=token`, never substitute `nonce` for PKCE.
- Never set `requireConsent: false` for an app you do not operate; never request scopes
  you do not enforce.

## 18. Minimal wiring checklists

**New app (confidential BFF + one API):** register resource → register client(s) →
discovery in BFF → `/login` redirect with PKCE+state+nonce+resource → callback exchange
(`client_secret_basic`) → validate ID token → own session + encrypted refresh → BFF→API
bearer calls → refresh-before-expiry → revoke + IdP logout on sign-out → immediate
revocation via `loadTokenSubject` if needed.

**Port:** register → add second login button → join on email once, key on `sub` →
dual-run old + new → migrate API middleware to JWKS → cut over → scrub legacy secrets →
drop password/legacy columns post-grace-period.

**New API only (existing client):** declare audience + scopes in `OIDC_RESOURCES_JSON` →
add audience to the client's `resources` and scopes to its `scopes` → deploy `basisAuth`
+ `requireScopes`/`requirePermissions` (+ `loadTokenSubject` for instant revocation) →
verify 401/403 shapes match your clients' retry logic.
