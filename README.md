# Collaborative Code Editor with Operational Transform

A real-time multi-user code editor built in **vanilla HTML, CSS, and JavaScript**. No backend required for the demo — the OT engine, conflict resolution, and operation log all run in the browser.

![HTML](https://img.shields.io/badge/HTML-5-orange) ![CSS](https://img.shields.io/badge/CSS-3-blue) ![JS](https://img.shields.io/badge/JavaScript-ES6-yellow) ![Algorithm](https://img.shields.io/badge/Algorithm-Operational_Transform-purple)

---

## What makes this IIT-level

This project implements the same algorithm that powers **Google Docs, Notion, and Figma** — Operational Transformation (OT). It is one of the most asked system design topics in FAANG interviews. Most candidates have never implemented it.

---

## Features

| Feature | Description |
|---|---|
| Live operation log | Every insert/delete logged as a structured OT event `{type, pos, text, version}` |
| Conflict simulation | Press "Simulate OT conflict" to see two simultaneous edits get resolved |
| Conflict explainer panel | Visual breakdown of what OT did to preserve both operations |
| Multi-user avatars | Three simulated collaborators with colour-coded cursors |
| Sync status badge | Real-time `synced / sending / conflict / resolved` states |
| Version tracking | Every operation increments a shared version counter |

---

## Project Structure

```
collab-editor/
└── collab-editor.html    ← Everything: HTML + CSS + OT engine in JS
```

---

## The OT Algorithm Explained

### The Problem

Two users (A and B) are both at document version 4. They both insert text at **position 6** simultaneously:

```
User A: insert(pos=6, text="# base case")    version=4
User B: insert(pos=6, text="# trivial case") version=4
```

If the server applies A first, then applies B without adjustment, B's insertion lands in the wrong place — the document diverges between clients.

### The Solution — `transform(opA, opB)`

```js
function transformInsertInsert(opA, opB) {
  // If opB inserted before or AT opA's position,
  // opA's position must shift right by the length of opB's text
  if (opB.pos <= opA.pos) {
    return { ...opA, pos: opA.pos + opB.text.length };
  }
  return opA; // opB is after opA — no adjustment needed
}
```

After transformation:
- Server applies A: `insert(6, "# base case")`
- Server transforms B → `insert(7, "# trivial case")` (position shifted by `"# base case".length` = 12)
- Both operations are applied — document converges on all clients ✓

### Why this is hard

The simple 2-client case is manageable, but OT becomes exponentially harder with:
- **N clients** (you need to transform an operation across the entire history since the client diverged)
- **Delete + insert at same position** (must handle tombstones)
- **Network partitions** (operations arrive out of order)

Production systems like Google Docs use a server-side history and a [Jupiter protocol](https://dl.acm.org/doi/10.1145/215585.215706) to reduce this to a simpler 2-party problem.

---

## Core Code Concepts

### 1. Operation representation

```js
// Every edit is an operation object — NOT a diff string
const op = {
  type:    'insert',          // 'insert' | 'delete'
  pos:     42,                // character index in document
  text:    '# base case',     // for insert: text to add
  len:     12,                // for delete: number of chars to remove
  version: 4,                 // document version when op was created
};
```

### 2. Applying an operation

```js
function applyOp(doc, op) {
  if (op.type === 'insert') {
    // Slice the string at pos, inject text, rejoin
    return doc.slice(0, op.pos) + op.text + doc.slice(op.pos);
  }
  if (op.type === 'delete') {
    // Cut out `len` characters starting at `pos`
    return doc.slice(0, op.pos) + doc.slice(op.pos + op.len);
  }
  return doc;
}
```

### 3. Transforming insert vs delete

```js
function transformInsertDelete(opInsert, opDelete) {
  // A delete happened before the insert position — shift insert left
  if (opDelete.pos < opInsert.pos) {
    return { ...opInsert, pos: Math.max(opDelete.pos, opInsert.pos - opDelete.len) };
  }
  return opInsert; // delete was after insert — no change
}
```

### 4. Version vector — knowing when to transform

```js
let version = 0; // shared document version, incremented after every accepted op

// Client tags every operation with its known version
const localOp = { ...op, version: version };

// Server: if op.version < server.version, transform op across
// every operation that happened since op.version
```

---

## How to explain this in an interview

**"What is the core problem Operational Transform solves?"**
Concurrent edits to a shared document that arrive at a server out-of-order. Naive last-write-wins loses data. OT transforms each operation relative to all concurrent operations that preceded it, so the final document state is identical on all clients regardless of arrival order.

**"How does your transform function work?"**
Given two concurrent insert operations at the same position, the one with the lower client ID (or that arrived second) gets its position shifted right by the length of the first insert. For delete + insert conflicts, if the delete happened before the insert position, the insert shifts left.

**"How would you scale this?"**
Use the Jupiter protocol — flatten to a star topology with a central server. Each client only ever talks to the server (not each other), so you only need to transform an operation across the server's history since the client's last known version. This caps the complexity at O(history_length) per operation rather than O(N²) for N clients.

**"What's the alternative to OT?"**
CRDTs (Conflict-free Replicated Data Types) — used by Figma and Linear. Instead of transforming operations, you design the data structure so that any merge order produces the same result mathematically. More complex to implement correctly but easier to reason about at scale.

---

## Real-world implementation stack

To make this production-ready:

```
Frontend:  Vanilla JS (this file) or CodeMirror with @codemirror/collab
WebSocket: Node.js + ws library  →  wss://your-server/collab
Backend:   Express + in-memory doc store (or Redis for scale)
Scaling:   Redis pub/sub to broadcast ops across multiple server instances
Auth:      JWT tokens passed in WebSocket handshake
```

---

## YouTube Resources

- **Operational Transform Explained — Real-Time Editing**: https://www.youtube.com/watch?v=ThdGY7ysiZ4 (Dec 2025)
- **Google SWE teaches systems design — OT vs CRDT**: https://www.youtube.com/watch?v=uOKrTc3Q0D0

---

## License

MIT — free to use, modify, and include in your portfolio.
