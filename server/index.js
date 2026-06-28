// ═══════════════════════════════════════════════════════════
//  index.js — Enterprise Collaborative Editor Server
//  Stack: Express (REST API) + ws (WebSocket OT engine)
//         PostgreSQL (users/rooms) + MongoDB (op history)
//         Redis (doc state + pub/sub for horizontal scaling)
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const http       = require('http');
const express    = require('express');
const { WebSocketServer } = require('ws');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const logger     = require('./logger');
const { pgPool } = require('./db/postgres');
const { redis }  = require('./db/redis');
const mongoose   = require('./db/mongo');

const authRouter = require('./routes/auth');
const roomRouter = require('./routes/rooms');
const docRouter  = require('./routes/documents');
const userRouter = require('./routes/users');

const { verifyToken }  = require('./middleware/auth');
const { transformOp }  = require('./ot/transform');
const { applyOp }      = require('./ot/apply');

const app    = express();
const server = http.createServer(app);

// ── Middleware ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Global rate limiter: 200 req / 15 min per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ── REST Routes ──────────────────────────────────────────────
// POST /api/auth/register  — create account
// POST /api/auth/login     — get JWT pair
// POST /api/auth/refresh   — swap refresh token
// GET  /api/rooms          — list user's rooms
// POST /api/rooms          — create a room
// GET  /api/rooms/:id      — room details + current doc state
// GET  /api/documents/:id/history — paginated op history
// GET  /api/users/me       — profile
app.use('/api/auth',      authRouter);
app.use('/api/rooms',     verifyToken, roomRouter);
app.use('/api/documents', verifyToken, docRouter);
app.use('/api/users',     verifyToken, userRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── WebSocket Server ─────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory map: roomId → { doc, version, clients: Set<ws> }
// In production this is backed by Redis (see below)
const rooms = new Map();

wss.on('connection', async (ws, req) => {
  // 1. Authenticate — token passed as ?token=<jwt> in URL
  const params = new URL(req.url, 'ws://x').searchParams;
  const token  = params.get('token');
  const roomId = params.get('room');

  let userId;
  try {
    const payload = verifyToken(token); // throws on invalid
    userId = payload.sub;
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  // 2. Load or initialise room state from Redis
  if (!rooms.has(roomId)) {
    const cached = await redis.get(`room:${roomId}:state`);
    if (cached) {
      rooms.set(roomId, JSON.parse(cached));
    } else {
      // Fall back to PostgreSQL
      const { rows } = await pgPool.query(
        'SELECT content FROM documents WHERE room_id = $1',
        [roomId]
      );
      const content = rows[0]?.content ?? '';
      rooms.set(roomId, { doc: content, version: 0, clients: new Set() });
    }
  }
  const room = rooms.get(roomId);
  room.clients.add(ws);
  ws._userId = userId;
  ws._roomId = roomId;
  ws._name   = params.get('name') ?? 'Anonymous';
  ws._color  = params.get('color') ?? '#888';

  // 3. Send initial state to new client
  ws.send(JSON.stringify({
    type:    'init',
    doc:     room.doc,
    version: room.version,
    peers:   [...room.clients]
      .filter(c => c !== ws && c.readyState === 1)
      .map(c => ({ userId: c._userId, name: c._name, color: c._color })),
  }));

  // 4. Announce new user to room
  broadcast(room, ws, { type: 'peer_joined', userId, name: ws._name, color: ws._color });

  // 5. Message handler
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Client sends an edit operation ──────────────────────
      case 'op': {
        const { op, version: clientVersion } = msg;
        const currentVersion = room.version;

        // Transform op against all ops that happened since clientVersion
        // In production, fetch those ops from MongoDB and chain-transform.
        // Here we demonstrate the single-step server transform:
        let transformedOp = op;
        const pendingOps = await getOpsSince(roomId, clientVersion);
        for (const serverOp of pendingOps) {
          transformedOp = transformOp(transformedOp, serverOp);
        }

        // Apply transformed op to server document
        room.doc     = applyOp(room.doc, transformedOp);
        room.version = currentVersion + 1;

        // Persist op to MongoDB (op log)
        await saveOp({
          roomId,
          op:      transformedOp,
          version: room.version,
          userId,
        });

        // Update Redis cache (non-blocking)
        redis.set(`room:${roomId}:state`,
          JSON.stringify({ doc: room.doc, version: room.version }),
          'EX', 3600
        );

        // Acknowledge to sender with server-assigned version
        ws.send(JSON.stringify({ type: 'ack', version: room.version }));

        // Broadcast transformed op to all other clients in room
        broadcast(room, ws, {
          type:    'op',
          op:      transformedOp,
          version: room.version,
          userId,
        });
        break;
      }

      // ── Cursor position update ────────────────────────────
      case 'cursor': {
        broadcast(room, ws, {
          type:   'cursor',
          userId,
          name:   ws._name,
          color:  ws._color,
          line:   msg.line,
          col:    msg.col,
        });
        break;
      }

      // ── Awareness (typing indicator, selection) ───────────
      case 'awareness': {
        broadcast(room, ws, { type: 'awareness', userId, ...msg.data });
        break;
      }
    }
  });

  // 6. Cleanup on disconnect
  ws.on('close', () => {
    room.clients.delete(ws);
    broadcast(room, null, { type: 'peer_left', userId, name: ws._name });

    if (room.clients.size === 0) {
      // Persist doc to PostgreSQL when last user leaves
      pgPool.query(
        'UPDATE documents SET content = $1, updated_at = NOW() WHERE room_id = $2',
        [room.doc, roomId]
      ).catch(err => logger.error('persist doc error', err));
    }
  });

  ws.on('error', (err) => logger.error('ws error', { userId, err: err.message }));
});

// ── Helpers ──────────────────────────────────────────────────

function broadcast(room, senderWs, payload) {
  const msg = JSON.stringify(payload);
  room.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1) {
      client.send(msg);
    }
  });
}

async function getOpsSince(roomId, sinceVersion) {
  // Fetches ops from MongoDB that happened after sinceVersion
  const Op = mongoose.model('Op');
  return Op.find({ roomId, version: { $gt: sinceVersion } })
    .sort({ version: 1 })
    .lean()
    .then(docs => docs.map(d => d.op));
}

async function saveOp({ roomId, op, version, userId }) {
  const Op = mongoose.model('Op');
  await new Op({ roomId, op, version, userId, createdAt: new Date() }).save();
}

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));
