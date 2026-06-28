// db/mongo.js — MongoDB connection + Op schema
const mongoose = require('mongoose');
const logger   = require('../logger');

mongoose.connect(process.env.MONGO_URL, {
  serverSelectionTimeoutMS: 5000,
}).then(() => logger.info('MongoDB connected'))
  .catch(err => logger.error('MongoDB error', err));

// Operation log schema
// Each document is one atomic edit operation with version number.
// Indexed by (roomId, version) for efficient history queries.
const opSchema = new mongoose.Schema({
  roomId:    { type: String, required: true, index: true },
  op:        { type: Object, required: true },  // { type, pos, text, len }
  version:   { type: Number, required: true },
  userId:    { type: String, required: true },
  createdAt: { type: Date,   default: Date.now },
});
opSchema.index({ roomId: 1, version: 1 });

mongoose.model('Op', opSchema);

module.exports = mongoose;
