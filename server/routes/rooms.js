// routes/rooms.js — CRUD for collaboration rooms
const router     = require('express').Router();
const { v4: uuid } = require('uuid');
const { pgPool } = require('../db/postgres');

// GET /api/rooms — list rooms the user belongs to
router.get('/', async (req, res) => {
  const userId = req.user.sub;
  const { rows } = await pgPool.query(
    `SELECT r.id, r.name, r.language, r.created_at,
            u.name AS owner_name,
            COUNT(DISTINCT rm.user_id)::int AS member_count
     FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id
     JOIN users u ON u.id = r.owner_id
     WHERE rm.user_id = $1
     GROUP BY r.id, u.name
     ORDER BY r.created_at DESC`,
    [userId]
  );
  res.json(rows);
});

// POST /api/rooms — create a new room
router.post('/', async (req, res) => {
  const { name, language = 'python' } = req.body;
  const userId = req.user.sub;

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [room] } = await client.query(
      `INSERT INTO rooms (id, name, language, owner_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [uuid(), name, language, userId]
    );

    // Create initial empty document for this room
    await client.query(
      `INSERT INTO documents (room_id, content) VALUES ($1, '')`,
      [room.id]
    );

    // Add owner as a member
    await client.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [room.id, userId]
    );

    await client.query('COMMIT');
    res.status(201).json(room);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not create room' });
  } finally {
    client.release();
  }
});

// GET /api/rooms/:id — room details
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const userId  = req.user.sub;

  // Ensure user is a member
  const { rows: [member] } = await pgPool.query(
    'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
    [id, userId]
  );
  if (!member) return res.status(403).json({ error: 'Access denied' });

  const { rows: [room] } = await pgPool.query(
    `SELECT r.*, d.content, d.id AS doc_id
     FROM rooms r JOIN documents d ON d.room_id = r.id
     WHERE r.id = $1`,
    [id]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { rows: members } = await pgPool.query(
    `SELECT u.id, u.name, rm.role
     FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1`,
    [id]
  );
  res.json({ ...room, members });
});

// POST /api/rooms/:id/invite — add a user by email
router.post('/:id/invite', async (req, res) => {
  const { id } = req.params;
  const { email, role = 'editor' } = req.body;
  const requesterId = req.user.sub;

  const { rows: [requester] } = await pgPool.query(
    'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
    [id, requesterId]
  );
  if (!requester || requester.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can invite' });
  }

  const { rows: [invitee] } = await pgPool.query(
    'SELECT id FROM users WHERE email = $1', [email]
  );
  if (!invitee) return res.status(404).json({ error: 'User not found' });

  await pgPool.query(
    `INSERT INTO room_members (room_id, user_id, role)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [id, invitee.id, role]
  );
  res.json({ message: 'Invited successfully' });
});

module.exports = router;
