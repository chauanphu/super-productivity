# SuperSync Server

A custom, high-performance synchronization server for Super Productivity.

> **Note:** This server implements a custom operation-based synchronization protocol (Event Sourcing), **not** WebDAV. It is designed specifically for the Super Productivity client's efficient sync requirements.

> **Related Documentation:**
>
> - [Authentication Architecture](./docs/authentication.md) - Auth design decisions and security features
> - [Operation Log Architecture](/docs/sync-and-op-log/operation-log-architecture.md) - Client-side architecture
> - [Server Architecture Diagrams](./sync-server-architecture-diagrams.md) - Visual diagrams
> - [Backup & Disaster Recovery](./docs/backup-and-recovery.md) - Backup setup and recovery procedures

## Architecture

The server uses an **Append-Only Log** architecture backed by **PostgreSQL** (via Prisma):

1.  **Operations**: Clients upload atomic operations (Create, Update, Delete, Move).
2.  **Sequence Numbers**: The server assigns a strictly increasing `server_seq` to each operation.
3.  **Synchronization**: Clients request "all operations since sequence `X`".
4.  **Snapshots**: The server can regenerate the full state by replaying operations, optimizing initial syncs.

### Key Design Principles

| Principle                           | Description                                                               |
| ----------------------------------- | ------------------------------------------------------------------------- |
| **Server-Authoritative**            | Server assigns monotonic sequence numbers for total ordering              |
| **Client-Side Conflict Resolution** | Server stores operations as-is; clients detect and resolve conflicts      |
| **E2E Encryption Support**          | Payloads can be encrypted client-side; server treats them as opaque blobs |
| **Idempotent Uploads**              | Request ID deduplication prevents duplicate operations                    |

## Quick Start

### Docker (Recommended)

The easiest way to run the server is using the provided Docker Compose configuration.

```bash
# 1. Copy environment example
cp .env.example .env

# 2. Configure .env (Set JWT_SECRET, DOMAIN, POSTGRES_PASSWORD)
nano .env

# 3. Start the stack (Server + Postgres + Caddy)
docker-compose up -d
```

### Manual Setup (Development)

```bash
# Install dependencies
npm install

# Generate Prisma Client
npx prisma generate

# Set up .env
cp .env.example .env
# Edit .env to point to your PostgreSQL instance (DATABASE_URL)

# Push schema to DB
npx prisma db push

# Start the server
npm run dev

# Or build and run
npm run build
npm start
```

## Configuration

All configuration is done via environment variables.

| Variable       | Default                          | Description                                                                     |
| :------------- | :------------------------------- | :------------------------------------------------------------------------------ |
| `PORT`         | `1900`                           | Server port                                                                     |
| `DATABASE_URL` | -                                | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/db`)  |
| `JWT_SECRET`   | -                                | **Required.** Secret for signing JWTs (min 32 chars)                            |
| `PUBLIC_URL`   | -                                | **Required.** Public URL used for email links (e.g. `https://sync.example.com`) |
| `CORS_ORIGINS` | upstream app origins (see below) | Allowed CORS origins, comma-separated. **Set it** to your app origin            |
| `SMTP_HOST`    | -                                | SMTP Server for emails                                                          |

| Variable                | Default | Description                                                                                                                                                                                                                                                   |
| :---------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WEB_ROOT`              | -       | Directory of the built Angular app (`dist/browser`). When set and it contains `index.html`, the server serves the app at `/` instead of the legacy `public/` pages (and their `/reset-password`, `/verify-email`, `/magic-login`, `/recover-passkey` routes). |
| `REGISTRATION_DISABLED` | `false` | `true` makes `POST /api/register/passkey/options`, `/api/register/passkey/verify` and `/api/register/magic-link` return `403 {"error":"Registration is disabled"}`. Logins are unaffected. Create users with `set-password` (see Maintenance).                |
| `ALLOWED_EMAILS`        | -       | Optional registration allowlist: comma-separated emails or `*@domain`.                                                                                                                                                                                        |

`CORS_ORIGINS` defaults to the upstream hosted app (`https://app.super-productivity.com` and its
preview deployments). A self-hosted server must set it to its own app origin, e.g.
`CORS_ORIGINS=https://planner.captechvn.com`. When the app is served by this server
(`WEB_ROOT`) all requests are same-origin and CORS is not involved, but set it anyway so the
upstream origin is not allowed.

## Deploying at planner.captechvn.com behind nginx-proxy-manager

One container serves both the Angular app and the API on the same origin, plus Postgres.
No external services. Files: `docker-compose.planner.yml` and `.env.planner.example` at the
repo root; the image is the `planner` target of `packages/super-sync-server/Dockerfile`
(it builds the app with `npm run buildFrontend:prodWeb`, copies `dist/browser` to `/app/web`
and sets `WEB_ROOT=/app/web`; the default target is still the server-only image).

### 1. Configure and start

```bash
cp .env.planner.example .env.planner
# Fill in POSTGRES_PASSWORD (openssl rand -hex 24) and JWT_SECRET (openssl rand -hex 32).
# Keep REGISTRATION_DISABLED=true and CORS_ORIGINS=https://planner.captechvn.com.
docker compose -f docker-compose.planner.yml --env-file .env.planner up -d --build
```

The app container (`scripts/docker-start.sh`) runs `prisma migrate deploy` and then the server
on port 1900. `prisma/migrations` has no initial migration, so on an empty database the script
first creates the schema with `prisma db push` and marks the existing migrations as applied. The compose
file publishes it on `127.0.0.1:${APP_PORT:-1900}` only.

**Never expose port 1900 to the internet directly.** The server trusts exactly one proxy hop
(`trustProxy: 1`, fixed in `src/server.ts`; there is no env var): it takes the client IP from
the last `X-Forwarded-For` entry, which NPM sets. That is correct with NPM as the single proxy
in front. A client reaching the port directly could put any IP into `X-Forwarded-For` and
dodge per-IP rate limits, and it would bypass TLS. If you add another proxy hop (e.g. a CDN in
front of NPM), the value has to change.

### 2. Create the first user

Self-registration is closed (`REGISTRATION_DISABLED=true`), so the operator creates accounts:

```bash
docker compose -f docker-compose.planner.yml --env-file .env.planner exec \
  -e SET_PASSWORD_PASSWORD='a-long-password' app node dist/scripts/set-password.js user@example.com
```

The same command resets a password (add `--revoke-sessions` to log out all devices).

### 3. nginx-proxy-manager Proxy Host

- **Details**: Domain Names `planner.captechvn.com`; Scheme `http`; Forward Hostname/IP and
  Port: if NPM runs on the host network, `127.0.0.1` and `1900` (`APP_PORT`). If NPM runs in
  Docker (usual), `127.0.0.1` is NPM's own container: attach NPM to this project's network
  (`docker network connect <project>_default <npm-container>`) and forward to `app` : `1900`;
  then the `ports:` mapping can be removed entirely.
- Enable **Websockets Support** (the client keeps a websocket at `/api/sync/ws` for live sync
  notifications) and **Block Common Exploits**. Cache Assets: off (the server sends the right
  `Cache-Control` headers itself).
- **SSL**: request a new Let's Encrypt certificate, enable **Force SSL** and **HTTP/2 Support**
  (HSTS optional).
- **Advanced** custom Nginx configuration:

  ```nginx
  # Server body limit is 20 MB for normal routes and 30 MB for POST /api/sync/snapshot
  # (backup/repair imports); nginx's default of 1 MB would reject large uploads.
  client_max_body_size 32m;
  # The server allows up to 80 s per request (snapshot generation); nginx's default is 60 s.
  # Websocket pings run every 30 s, so 90 s also keeps idle sockets open.
  proxy_read_timeout 90s;
  proxy_send_timeout 90s;
  ```

### 4. Backup and restore

```bash
docker compose -f docker-compose.planner.yml --env-file .env.planner exec -T db \
  pg_dump -U planner -d planner -Fc > planner-$(date +%F).dump
# restore into an empty database:
docker compose -f docker-compose.planner.yml --env-file .env.planner exec -T db \
  pg_restore -U planner -d planner --clean --if-exists < planner-YYYY-MM-DD.dump
```

(Use your `POSTGRES_USER`/`POSTGRES_DB` if you changed them.)

### 5. Upgrade

```bash
docker compose -f docker-compose.planner.yml --env-file .env.planner exec -T db \
  pg_dump -U planner -d planner -Fc > planner-before-upgrade.dump
git pull
docker compose -f docker-compose.planner.yml --env-file .env.planner up -d --build
```

Migrations run automatically when the app container starts.

### Desktop (Electron) and Android builds

They have no usable origin (`file://`, `https://localhost`), so they must be built with
`superSyncBaseUrl: 'https://planner.captechvn.com'` in `src/environments/environment.prod.ts`
(and `environment.ts`/`environment.stage.ts` for other build types). The web app served by
this server keeps `superSyncBaseUrl: ''` and uses its own origin. `CORS_ORIGINS` needs no extra
entry for them: Electron injects CORS response headers itself (`electron/main-window.ts`) and
Android sends requests through native `CapacitorHttp` (`capacitor.config.ts`).

## API Endpoints

### Authentication

#### Register a new user

```http
POST /api/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

Response:

```json
{
  "message": "User registered. Please verify your email.",
  "id": 1,
  "email": "user@example.com"
}
```

#### Login

```http
POST /api/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

Response:

```json
{
  "token": "jwt-token",
  "user": { "id": 1, "email": "user@example.com" }
}
```

### Synchronization

All sync endpoints require Bearer authentication: `Authorization: Bearer <jwt-token>`

#### 1. Upload Operations

Send new changes to the server.

```http
POST /api/sync/ops
```

#### 2. Download Operations

Get changes from other devices.

```http
GET /api/sync/ops?sinceSeq=123
```

#### 3. Get Snapshot

Get the full current state (optimized).

```http
GET /api/sync/snapshot
```

#### 4. Sync Status

Check pending operations and device status.

```http
GET /api/sync/status
```

## Client Configuration

The login page asks only for email and password; the server is fixed per build:

- The client uses `superSyncBaseUrl` from `src/environments/environment*.ts`, or, if it is
  empty, the origin that serves the app (`http:`/`https:` pages only). No external host is
  ever used as a fallback; without either, the login page shows "Server not configured".
- Simplest deployment: one reverse proxy that serves the built Angular app at `/` and this
  server under `/api` on the same origin. No CORS setup needed.
- If the app and the server are on different origins, set `superSyncBaseUrl` and configure
  CORS on the server to allow the app's origin.
- Electron and Android builds have no usable origin (`file://`, `https://localhost`), so
  they must set `superSyncBaseUrl`.

## Maintenance

### Scripts

The server includes scripts for administrative tasks. These use the configured database.

```bash
# Create a user or set/reset a password (6 chars to 72 bytes; user is marked verified).
# Run `pg_dump` before deploying a new version.
# Development (ts-node):
npm run set-password -- user@example.com 'a-long-password'
# Production container (dev dependencies are not installed, use the compiled script):
node dist/scripts/set-password.js user@example.com 'a-long-password'
# Keep the password out of `ps` and shell history: omit it and pass it via the env:
SET_PASSWORD_PASSWORD='a-long-password' node dist/scripts/set-password.js user@example.com
# Reset a compromised password AND log out every existing session (bumps tokenVersion;
# without the flag existing tokens stay valid):
SET_PASSWORD_PASSWORD='a-new-password' node dist/scripts/set-password.js --revoke-sessions user@example.com

# Delete a user account
npm run delete-user -- user@example.com

# Clear sync data (preserves account)
npm run clear-data -- user@example.com

# Clear ALL sync data (dangerous)
npm run clear-data -- --all
```

## API Details

### Upload Operations (`POST /api/sync/ops`)

Request body:

```json
{
  "ops": [
    {
      "id": "uuid-v7",
      "opType": "UPD",
      "entityType": "TASK",
      "entityId": "task-123",
      "payload": { "changes": { "title": "New title" } },
      "vectorClock": { "clientA": 5 },
      "timestamp": 1701234567890,
      "schemaVersion": 1
    }
  ],
  "clientId": "clientA",
  "lastKnownSeq": 100
}
```

Response:

```json
{
  "results": [{ "opId": "uuid-v7", "accepted": true, "serverSeq": 101 }],
  "newOps": [],
  "latestSeq": 101
}
```

### Download Operations (`GET /api/sync/ops`)

Query parameters:

- `sinceSeq` (required): Server sequence number to start from
- `limit` (optional): Max operations to return (default: 500)

### Upload Snapshot (`POST /api/sync/snapshot`)

Used for full-state operations (BackupImport, SyncImport, Repair):

```json
{
  "state": {
    /* Full AppDataComplete */
  },
  "clientId": "clientA",
  "reason": "initial",
  "vectorClock": { "clientA": 10 },
  "schemaVersion": 1
}
```

## Security Features

| Feature                       | Implementation                                    |
| ----------------------------- | ------------------------------------------------- |
| **Authentication**            | JWT Bearer tokens in Authorization header         |
| **Timing Attack Mitigation**  | Dummy hash comparison on invalid users            |
| **Input Validation**          | Operation ID, entity ID, schema version validated |
| **Rate Limiting**             | Configurable per-user limits                      |
| **Vector Clock Sanitization** | Limited to 50 entries, 255 char keys              |
| **Entity Type Allowlist**     | Prevents injection of invalid entity types        |
| **Request Deduplication**     | Prevents duplicate operations on retry            |

## Multi-Instance Deployment Considerations

When deploying multiple server instances behind a load balancer, be aware of these limitations:

### Passkey Challenge Storage

**Issue**: WebAuthn challenges are stored in an in-memory Map, which doesn't work across instances.

**Symptom**: Passkey registration/login fails if the challenge generation request hits instance A but verification hits instance B.

**Solution for multi-instance**:

- Implement Redis-backed challenge storage
- Or use sticky sessions (less ideal)

**Current status**: A warning is logged at startup in production if in-memory storage is used.

### Snapshot Generation Locks

**Issue**: Concurrent snapshot generation prevention uses an in-memory Map.

**Symptom**: Same user may trigger duplicate snapshot computations across different instances.

**Impact**: Performance only (no data corruption) - snapshots are deterministic.

**Solution for multi-instance**:

- Implement Redis distributed lock (optional, only for performance)

### Single-Instance Deployment

For single-instance deployments, these limitations do not apply. The current implementation is fully functional and well-tested for single-instance use.

## Known Limitations

- **First-sync merge and server snapshots**: the client's first-login merge of local data into an existing account is uploaded as `applyFirstSyncMerge` operations. Server-side snapshot generation (restore points, `GET /api/sync/snapshot`) does not replay these operations, so data that only arrived through such a merge is missing from server-built snapshots.

## Security Notes

- **Set JWT_SECRET** to a secure random value in production (min 32 characters).
- **Use HTTPS in production**. The Docker setup includes Caddy to handle this automatically.
- **Restrict CORS origins** in production.
- **Database backups** are recommended for production deployments.
