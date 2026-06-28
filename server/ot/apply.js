// ot/apply.js — Apply an operation to a document string
function applyOp(doc, op) {
  if (op.type === 'insert') {
    return doc.slice(0, op.pos) + op.text + doc.slice(op.pos);
  }
  if (op.type === 'delete') {
    return doc.slice(0, op.pos) + doc.slice(op.pos + op.len);
  }
  return doc;
}
module.exports = { applyOp };
