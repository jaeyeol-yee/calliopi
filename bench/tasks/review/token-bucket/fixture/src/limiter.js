// A token bucket per key. A bucket holds at most `capacity` tokens and gains `ratePerSec` tokens
// per second since its last refill; fractions of a token accumulate. A new key starts full.
// Times (`now`, `idleMs`) are in milliseconds, and `now` never goes backwards.
//
// take(key, now, cost = 1): refills the bucket; if it then has at least `cost` tokens, removes them
//   and returns true. Otherwise removes nothing and returns false.
// remaining(key, now): the whole tokens the key could take at `now`. Changes nothing.
// retryAfter(key, now, cost = 1): the shortest wait in milliseconds, rounded up to a whole one, after
//   which take(key, ..., cost) can succeed; 0 if it can now, Infinity if cost exceeds capacity.
// sweep(now): forgets buckets not used for longer than `idleMs`; such a key starts full again.
class RateLimiter {
  constructor({ capacity, ratePerSec, idleMs = 60_000 }) {
    this.capacity = capacity;
    this.ratePerSec = ratePerSec;
    this.idleMs = idleMs;
    this.buckets = new Map();
  }

  take(key, now, cost = 1) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.at;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.ratePerSec);
    bucket.at = now;
    if (bucket.tokens > cost) {
      bucket.tokens -= cost;
      return true;
    }
    return false;
  }

  remaining(key, now) {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.capacity;
    const seconds = (now - bucket.at) / 1000;
    return Math.floor(Math.min(this.capacity, bucket.tokens + seconds * this.ratePerSec));
  }

  retryAfter(key, now, cost = 1) {
    if (cost > this.capacity) return Infinity;
    const have = this.remaining(key, now);
    if (have >= cost) return 0;
    return Math.ceil(((cost - have) / this.ratePerSec) * 1000);
  }

  sweep(now) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > this.idleMs) this.buckets.delete(key);
    }
  }
}

module.exports = { RateLimiter };
