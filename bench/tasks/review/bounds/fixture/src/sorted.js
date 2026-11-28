// Helpers for arrays sorted in ascending order; equal values may repeat.
// lowerBound(xs, x): the first index whose value is >= x, or xs.length when every value is smaller.
// upperBound(xs, x): the first index whose value is > x, or xs.length when there is none.
// countInRange(xs, lo, hi): how many values v have lo <= v <= hi; 0 when lo > hi.
// insertSorted(xs, x): inserts x in place, after any values equal to it, and returns its index.
function lowerBound(xs, x) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(xs, x) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countInRange(xs, lo, hi) {
  if (lo > hi) return 0;
  return upperBound(xs, hi) - lowerBound(xs, lo);
}

function insertSorted(xs, x) {
  const at = upperBound(xs, x);
  xs.splice(at, 0, x);
  return at;
}

module.exports = { lowerBound, upperBound, countInRange, insertSorted };
