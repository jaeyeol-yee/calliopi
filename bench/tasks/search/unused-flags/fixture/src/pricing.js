const { inRollout } = require('./rollout');

function priceOf(item, userId = 0) {
  const base = item.cents * item.qty;
  return inRollout(userId) ? Math.round(base * 0.95) : base;
}

module.exports = { priceOf };
