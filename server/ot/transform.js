// ═══════════════════════════════════════════════════════════
//  ot/transform.js — Operational Transform core
//  Implements Jupiter-style server-side transform.
//  Every operation: { type: 'insert'|'delete', pos, text, len }
// ═══════════════════════════════════════════════════════════

/**
 * transformOp(incoming, concurrent)
 *
 * Transforms `incoming` operation assuming `concurrent` was
 * already applied to the document. Returns a new operation
 * that, when applied after `concurrent`, produces the same
 * logical intent as `incoming` would have on the original doc.
 */
function transformOp(incoming, concurrent) {
  if (incoming.type === 'insert' && concurrent.type === 'insert') {
    return transformInsertInsert(incoming, concurrent);
  }
  if (incoming.type === 'insert' && concurrent.type === 'delete') {
    return transformInsertDelete(incoming, concurrent);
  }
  if (incoming.type === 'delete' && concurrent.type === 'insert') {
    return transformDeleteInsert(incoming, concurrent);
  }
  if (incoming.type === 'delete' && concurrent.type === 'delete') {
    return transformDeleteDelete(incoming, concurrent);
  }
  return incoming;
}

// Insert vs Insert:
//   If concurrent inserted AT or BEFORE incoming's position,
//   incoming must shift right by the length of concurrent's text.
//   Tie-break: if positions are equal, we use userId ordering
//   to ensure both clients converge to the same final order.
function transformInsertInsert(ins, concurrent) {
  if (concurrent.pos < ins.pos) {
    return { ...ins, pos: ins.pos + concurrent.text.length };
  }
  if (concurrent.pos === ins.pos && concurrent.userId < ins.userId) {
    // Deterministic tie-break: lower userId wins the earlier position
    return { ...ins, pos: ins.pos + concurrent.text.length };
  }
  return ins;
}

// Insert vs Delete:
//   If concurrent deleted text before incoming's position,
//   incoming shifts left (but never past the delete start).
function transformInsertDelete(ins, del) {
  if (del.pos < ins.pos) {
    const shift = Math.min(del.len, ins.pos - del.pos);
    return { ...ins, pos: ins.pos - shift };
  }
  return ins;
}

// Delete vs Insert:
//   If concurrent inserted before or at delete start, delete shifts right.
function transformDeleteInsert(del, ins) {
  if (ins.pos <= del.pos) {
    return { ...del, pos: del.pos + ins.text.length };
  }
  // Insert is inside the range being deleted — split is needed in full impl.
  // For MVP: if insert is inside deleted region, adjust len
  if (ins.pos > del.pos && ins.pos < del.pos + del.len) {
    return { ...del, len: del.len + ins.text.length };
  }
  return del;
}

// Delete vs Delete:
//   Handle overlap between two concurrent deletions.
function transformDeleteDelete(del, concurrent) {
  if (concurrent.pos + concurrent.len <= del.pos) {
    // Concurrent fully before incoming — shift left
    return { ...del, pos: del.pos - concurrent.len };
  }
  if (concurrent.pos >= del.pos + del.len) {
    // Concurrent fully after incoming — no change
    return del;
  }
  // Overlapping deletes — shrink incoming's len by the overlap
  const overlapStart = Math.max(del.pos, concurrent.pos);
  const overlapEnd   = Math.min(del.pos + del.len, concurrent.pos + concurrent.len);
  const overlap      = Math.max(0, overlapEnd - overlapStart);
  return {
    ...del,
    pos: Math.min(del.pos, concurrent.pos),
    len: del.len - overlap,
  };
}

module.exports = { transformOp };
