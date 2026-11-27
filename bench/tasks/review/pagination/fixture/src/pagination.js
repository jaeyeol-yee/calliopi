// Page `page` (1-based) of `items`, `size` items per page.
// A page number below 1 is treated as page 1. Pages past the end are empty.
// `size` must be a positive integer.
function paginate(items, page, size) {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a positive integer');
  const p = Math.max(1, Math.floor(page));
  const start = (p - 1) * size;
  const end = start + size - 1;
  return items.slice(start, end);
}

// How many pages `count` items fill.
function pageCount(count, size) {
  return Math.ceil(count / size);
}

module.exports = { paginate, pageCount };
