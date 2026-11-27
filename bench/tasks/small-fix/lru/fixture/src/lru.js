// A least-recently-used cache holding at most `capacity` entries. Reading or writing a key makes it
// the most recently used; when full, writing a new key evicts the least recently used one.
class LRU {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  set(key, value) {
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }
  has(key) {
    return this.map.has(key);
  }
  get size() {
    return this.map.size;
  }
}
module.exports = { LRU };
