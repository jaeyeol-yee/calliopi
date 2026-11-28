// Runs tasks (functions that return a promise) with at most `limit` of them running at once,
// starting them in the order they were added. add(fn) returns a promise for fn's result.
// A task that throws or rejects fails only its own promise; the queue goes on with the next task.
// onIdle() resolves once nothing is running and nothing is waiting.
class Queue {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.waiting = [];
    this.idle = [];
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ fn, resolve, reject });
      this.next();
    });
  }

  next() {
    while (this.running < this.limit && this.waiting.length) {
      const { fn, resolve, reject } = this.waiting.shift();
      this.running++;
      fn().then(value => {
        this.running--;
        resolve(value);
        this.next();
      }, reject);
    }
    if (!this.running && !this.waiting.length) for (const done of this.idle.splice(0)) done();
  }

  onIdle() {
    return new Promise(resolve => {
      if (!this.running && !this.waiting.length) resolve();
      else this.idle.push(resolve);
    });
  }
}

module.exports = { Queue };
