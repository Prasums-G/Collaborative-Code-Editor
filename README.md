# Collaborative Code Editor

Real-time multi-user code editing with Operational Transform, built on a production-grade stack. This is the full-stack upgrade of the single-file demo into a system you could deploy at scale.

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![Express](https://img.shields.io/badge/Express-4.18-black) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue) ![MongoDB](https://img.shields.io/badge/MongoDB-7-green) ![Redis](https://img.shields.io/badge/Redis-7-red) ![Docker](https://img.shields.io/badge/Docker-Compose-blue)

---

## Architecture

```
Client (React + Monaco Editor)
        │  REST (auth, rooms)     │  WebSocket /ws?token=jwt&room=id
        ▼                         ▼
  ┌─────────────────────────────────────┐
  │   Express API + ws WebSocket server  │
  │   Port 4000                          │
  └───┬──────────────┬──────────────┬───┘
      │              │              │
      ▼              ▼              ▼
 PostgreSQL       MongoDB         Redis
 (users, rooms,  (op history,    (live doc state,
  documents)      versions)       pub/sub broadcast)
```

**Horizontal scaling**: replace the in-memory room map with Redis. Multiple API instances subscribe to Redis pub/sub and broadcast ops to their local WebSocket clients. Add a load balancer (sticky sessions or connection upgrade routing) in front.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| HTTP + WebSocket server | Node.js 20 + Express + `ws` | Single-threaded event loop handles thousands of concurrent WS connections efficiently |
| OT engine | Custom (`ot/transform.js`) | No library — the algorithm is the project |
| Auth | JWT (access 15m + refresh 7d) + bcrypt | Industry standard; stateless auth scales horizontally |
| Primary DB | PostgreSQL 16 | Users, rooms, documents — relational integrity with foreign keys and transactions |
| Op log DB | MongoDB 7 | Append-heavy, schema-flexible op history; indexed by `(roomId, version)` |
| Cache + pub/sub | Redis 7 | Stores live document state per room; pub/sub for broadcasting across server instances |
| Logging | Winston | JSON logs in production; pretty-print in development |
| Validation | Joi | Schema validation on all REST request bodies |
| Container | Docker + Compose | One command to run the full stack locally |

---

## Project Structure

```
Collaborative-Code-Editor/
├── docker-compose.yml
├── server/
│   ├── index.js              ← Entry point: Express + WebSocket server
│   ├── logger.js             ← Winston logger
│   ├── package.json
│   ├── .env.example
│   ├── Dockerfile
│   ├── ot/
│   │   ├── transform.js      ← Core OT algorithm (insert/delete transforms)
│   │   └── apply.js          ← Apply op to document string
│   ├── routes/
│   │   ├── auth.js           ← POST /register, /login, /refresh
│   │   ├── rooms.js          ← GET/POST /rooms, invite
│   │   └── documents.js      ← GET /documents/:id/history
│   ├── middleware/
│   │   └── auth.js           ← JWT verify middleware + signTokens()
│   └── db/
│       ├── schema.sql        ← PostgreSQL DDL (run once)
│       ├── postgres.js       ← pg Pool
│       ├── redis.js          ← ioredis client
│       └── mongo.js          ← Mongoose connection + Op schema
```

---

## Quick Start

```bash
# 1. Clone and configure
cp server/.env.example server/.env
# Edit server/.env with your secrets

# 2. Start everything with Docker Compose
docker compose up --build

# 3. The API is now at:
#    REST:      http://localhost:4000/api
#    WebSocket: ws://localhost:4000/ws?token=<jwt>&room=<roomId>
#    Health:    http://localhost:4000/health
```

---

## API Reference

### Authentication

```
POST /api/auth/register
Body: { name, email, password }
Response: { user, access, refresh }

POST /api/auth/login
Body: { email, password }
Response: { user, access, refresh }

POST /api/auth/refresh
Body: { refreshToken }
Response: { access, refresh }
```

### Rooms

```
GET  /api/rooms                 — List rooms you belong to
POST /api/rooms                 — Create room { name, language }
GET  /api/rooms/:id             — Room details + members + doc content
POST /api/rooms/:id/invite      — Invite user { email, role }
```

### WebSocket Protocol

Connect: `ws://host/ws?token=<access_jwt>&room=<roomId>&name=YourName&color=%237F77DD`

**Client → Server messages:**

```json
{ "type": "op",       "op": { "type": "insert", "pos": 42, "text": "hello" }, "version": 7 }
{ "type": "op",       "op": { "type": "delete", "pos": 10, "len": 3 },        "version": 8 }
{ "type": "cursor",   "line": 5, "col": 12 }
{ "type": "awareness","data": { "isTyping": true } }
```

**Server → Client messages:**

```json
{ "type": "init",       "doc": "...full content...", "version": 7, "peers": [...] }
{ "type": "op",         "op": { ... }, "version": 8, "userId": "uuid" }
{ "type": "ack",        "version": 8 }
{ "type": "cursor",     "userId": "uuid", "name": "Priya", "color": "#1D9E75", "line": 3, "col": 5 }
{ "type": "peer_joined","userId": "uuid", "name": "Arjun", "color": "#7F77DD" }
{ "type": "peer_left",  "userId": "uuid", "name": "Arjun" }
{ "type": "error",      "message": "Unauthorized" }
```

---

## The OT Engine

### Why three databases?

**PostgreSQL** holds the canonical document state (the final merged string after all ops). It is the source of truth for what a user sees when they open a room.

**MongoDB** stores every individual operation as a document `{ roomId, op, version, userId, createdAt }`. This is the op log — the full history. It enables:
- Rebasing a stale client (fetch ops since their last known version)
- Audit history ("who deleted line 42 at 3pm?")
- Time travel / undo

**Redis** stores the live document state as a JSON blob for fast reads, and acts as a pub/sub bus so multiple API server instances can broadcast ops to each other's WebSocket clients without going through the database.

### OT transform cases

| Incoming op | Concurrent op | Transform rule |
|---|---|---|
| insert(pos) | insert(pos2 ≤ pos) | Shift pos right by len(concurrent.text) |
| insert(pos) | delete(pos2 < pos) | Shift pos left by min(delete.len, pos - pos2) |
| delete(pos) | insert(pos2 ≤ pos) | Shift pos right by len(concurrent.text) |
| delete(pos) | delete — overlapping | Shrink len by overlap, shift pos |

### Scaling beyond one server

```
Client A ─── API server 1 ──┐
                              ├── Redis pub/sub ──── MongoDB op log
Client B ─── API server 2 ──┘
```

Each API server:
1. Receives an op from its local client
2. Acquires a Redis lock on the document (`SET room:id:lock NX EX 1`)
3. Transforms the op against ops since the client's version
4. Applies the op, increments version
5. Publishes `{ op, version }` to the Redis channel
6. Other API servers receive the publish and forward to their WS clients

---

## Interview Q&A

**"What does Redis solve here that PostgreSQL can't?"**
PostgreSQL can store the document state and op log, but broadcasting an update to WebSocket clients across multiple server processes requires a pub/sub mechanism that PostgreSQL's LISTEN/NOTIFY isn't optimised for at scale. Redis pub/sub delivers messages in under 1ms with no polling. The document cache in Redis also avoids a DB read on every WebSocket connection.

**"Why separate PostgreSQL and MongoDB?"**
PostgreSQL enforces relational integrity (users, rooms, memberships) with ACID transactions — critical for correctness. MongoDB's document model is a natural fit for the op log: each op is self-contained, the collection is append-only, and querying by `(roomId, version)` on a compound index is extremely fast. Mixing both lets each database do what it's best at.

**"How would you handle 10,000 concurrent users in one room?"**
Fan-out at that scale requires moving from WebSocket broadcast to a dedicated message bus. Replace the in-process `room.clients` set with a Redis Streams consumer group. Each API server instance processes its own partition. For very high scale, replace custom OT with a CRDT library (Yjs or Automerge) which removes the central transform authority entirely.

---

## Production checklist

- [ ] Set `NODE_ENV=production` and real secrets in environment
- [ ] Enable PostgreSQL SSL (`ssl: { rejectUnauthorized: true }` in pool config)
- [ ] Set Redis `requirepass` and use `rediss://` TLS URL
- [ ] Add Nginx in front for TLS termination (see `nginx/collab.conf`)
- [ ] Configure CORS `allow_origins` to your actual client domain
- [ ] Set up database backups (pg_dump daily, MongoDB Atlas backups)
- [ ] Add Datadog or Prometheus scraping on `/metrics` endpoint
- [ ] Deploy with Kubernetes: 3 replicas of API server, Redis Cluster, PostgreSQL with read replica

---

## YouTube Resources

- **OT Explained — Real-Time Editing**: https://www.youtube.com/watch?v=ThdGY7ysiZ4
- **Google SWE: OT vs CRDT system design**: https://www.youtube.com/watch?v=uOKrTc3Q0D0

---

## License

MIT
