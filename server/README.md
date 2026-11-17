# GitView backend: authentication module

Phase 0 and 1 of the blueprint: Express 5, Prisma 7, PostgreSQL, bcrypt, JWT access + refresh
tokens in HTTP-only cookies, authentication and role-based authorization middleware.

## Setup

Requirements: **Node 22.18 or newer** (Prisma 7 generates TypeScript files that Node runs directly,
which needs type stripping, enabled by default from 22.18) and PostgreSQL.

```bash
npm install

# 1. Create two empty databases: gitview (development) and gitview_test (tests)

# 2. Configuration
cp .env.example .env          # then fill in DATABASE_URL and the two JWT secrets
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # run twice: one value per secret

# 3. Prisma
npm run db:generate                    # creates src/generated/prisma (the typed client)
npm run db:migrate -- --name init      # creates prisma/migrations and the tables

# 4. First admin (set SEED_ADMIN_* in .env first, remove them afterwards)
npm run db:seed

# 5. Run
npm run dev                            # http://localhost:3000/api/v1/health
```

### Tests

```bash
cp .env.test.example .env.test         # point it at the gitview_test database
npm run db:test:migrate                # applies the migrations to the test database
npm test
```

The tests use the real database (so unique constraints and atomic updates are really tested) and
**delete every user** in it. The test setup refuses to run unless the database name contains "test".
Test secrets are random on every run.

## Endpoints

| Method | Path | Access | Result |
|---|---|---|---|
| POST | `/api/v1/auth/register` | public | 201 `{ data: { user } }` + cookies |
| POST | `/api/v1/auth/login` | public | 200 `{ data: { user } }` + cookies |
| POST | `/api/v1/auth/refresh` | refresh cookie | 200 `{ data: { user } }` + rotated cookies |
| POST | `/api/v1/auth/logout` | refresh cookie (optional) | 204, cookies cleared |
| GET | `/api/v1/users/me` | logged in | 200 `{ data: { user } }` |
| GET | `/api/v1/admin/users?page=&perPage=` | ADMIN | 200 `{ data: [...], meta }` |
| GET | `/api/v1/health` | public | 200 |

Errors always look like `{ "error": { "code", "message", "details"? } }`.
Codes: `VALIDATION_ERROR`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `INVALID_CREDENTIALS`, `TOKEN_MISSING`,
`TOKEN_EXPIRED`, `TOKEN_INVALID`, `TOKEN_REUSED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`TOO_MANY_REQUESTS`, `INTERNAL_ERROR`.

## What each middleware is for (request order)

| Middleware | Purpose |
|---|---|
| `helmet()` | Security headers (CSP, no MIME sniffing...); removes `X-Powered-By`. |
| `cors({ origin, credentials })` | Only our frontend origin may call the API from a browser, and may send cookies. |
| `morgan` | One log line per request (off in tests). |
| `express.json({ limit })` | Parses JSON bodies; rejects bodies over 100 kb. |
| `cookieParser()` | Fills `req.cookies`, where the tokens live. |
| `credentialsLimiter` / `refreshLimiter` | Brute-force protection. See "Decisions" for why there are two. |
| `validate({ body, query })` | Runs zod schemas. Rejects bad input with 400, converts types, and **drops unlisted fields** (blocks mass assignment such as `role: "ADMIN"`). |
| `authenticate` | **Who are you?** Verifies the access-token cookie (signature + expiry, no DB call) and sets `req.user = { id, role }`. Fails with 401. |
| `requireRole('ADMIN')` | **May you do this?** Checks `req.user.role`. Fails with 403. Must come after `authenticate`. |
| `notFound` | Unknown routes get a JSON 404. |
| `errorHandler` | The single place errors become responses. Known errors explain themselves; bugs become a generic 500 and are only logged server-side. |

## The authentication steps

**Register**: zod validates and normalises (lowercase email/username, password 8 to 72 bytes) → check
email/username are free (409) → `bcrypt.hash(password, 12)` (random salt stored inside the hash) → create
the user with an explicit field list, so the role is always `USER` → issue tokens → set cookies.
The response goes through `toPublicUser`, a whitelist that cannot leak `passwordHash`.

**Login**: find user → run **one** bcrypt comparison (against a dummy hash if the user doesn't exist, so
timing doesn't reveal which emails are registered) → unknown email, wrong password and GitHub-only
account all return the same 401 `INVALID_CREDENTIALS` → issue tokens with a **new family id**.

**issueTokens**: signs a 15-minute access JWT (`sub`, `role`) and a 7-day refresh JWT (`sub`, `jti`,
`fam`) with *different* secrets, stores `SHA-256(refreshToken)` in the `RefreshToken` table (never the
token itself), and returns both for the controller to put in cookies.

**Cookies**: `HttpOnly` (JavaScript can't read them, so XSS can't steal them), `Secure` in production
(HTTPS only), `SameSite=Lax` (not sent on cross-site POST/PUT/DELETE, which is the CSRF defence). The
refresh cookie has `Path=/api/v1/auth`, so the browser only sends it to the auth routes.

**Refresh with rotation**: verify the refresh JWT → load its row by `jti` and compare the stored hash →
atomically mark the row revoked **only if it isn't already** (one `UPDATE ... WHERE revokedAt IS NULL`)
→ if that changed 0 rows, the token was already used: someone is replaying it, so revoke the **whole
family** and answer `TOKEN_REUSED` → otherwise issue a new pair in the same family. Every refresh token
therefore works exactly once.

**Logout**: revoke the session's family, clear both cookies, always 204.

## Decisions worth knowing for the viva (and where this differs from the blueprint)

- **Rate limiting is per route, not on all of `/auth/*`.** The blueprint's 10 per 15 minutes would also hit
  `/auth/refresh`, which the frontend calls automatically, and a classroom behind one IP would lock itself out.
  Login/register use `skipSuccessfulRequests` (only failures count); refresh gets its own roomier limiter.
- **Rotation is race-safe.** The blueprint's "mark revoked, then issue" has a gap if two requests arrive
  together; the conditional `updateMany` closes it (there is a test for it).
- **Prisma 7 specifics.** The blueprint warned that setup changes between versions. Prisma 7 needs
  `prisma.config.js` (connection URL and seed command live there), a driver adapter (`@prisma/adapter-pg`),
  and generates the client into `src/generated/prisma`. Versions are pinned exactly in `package.json`.
- **Schema syntax.** The blueprint's one-line `enum Role { USER ADMIN }` is not valid Prisma; enums must span lines.
- **Usernames are lowercased** like emails, so the unique constraints can't be sidestepped by letter case.
- **`optionalAuth`** (blueprint) is left out until the OAuth module needs it. `OAuthAccount` and `Repository` are
  added to `schema.prisma` in their phases (migrations are additive).
- **Logout revokes the whole family**, which the blueprint allowed ("current row or its family").

## Known limitations (all acceptable for the MVP, good "Later" items)

- The access token is stateless, so after logout (or a role change) it stays valid for up to 15 minutes.
  Role changes reach the token at the next refresh.
- Two browser tabs refreshing at the *same instant* look like a replay and end the session. Have the frontend
  refresh from one place and retry once.
- The rate limiter keeps counters in memory (one server instance only; use Redis for several).
- Cookies assume the frontend and API share a *site* (`localhost:5173` + `localhost:3000` is fine). Different
  domains in production need a different `SameSite` setting plus a CSRF token.
- No cleanup of expired `RefreshToken` rows yet (a scheduled `deleteMany` later).

## Frontend contract

```js
async function api(path, options = {}) {
  const call = () => fetch(`${API}${path}`, { ...options, credentials: 'include' });  // always send cookies
  let res = await call();
  if (res.status === 401 && (await res.clone().json()).error?.code === 'TOKEN_EXPIRED') {
    const refreshed = await fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) res = await call();   // retry once
    else window.location.assign('/login');
  }
  return res;
}
```

## Layout

```
src/
  app.js, server.js, routes.js     app assembly / listen + shutdown / mounts modules
  config/env.js                    validated environment (fails fast)
  lib/prisma.js                    the single PrismaClient
  middleware/                      authenticate, requireRole, validate, rateLimiters, notFound, errorHandler
  modules/auth/                    routes -> controller -> service (+ zod schemas)
  modules/users/                   GET /users/me, GET /admin/users
  utils/                           AppError, tokens (JWT + hashing), cookies, toPublicUser
prisma/                            schema.prisma, seed.js
tests/                             supertest + vitest, real PostgreSQL
```
