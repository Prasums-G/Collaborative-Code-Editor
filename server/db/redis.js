// db/redis.js
const Redis  = require('ioredis');
const logger = require('../logger');

const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => logger.error('Redis error', err));
redis.connect().catch((err) => logger.error('Redis connect failed', err));

module.exports = { redis };
