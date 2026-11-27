const test = require('node:test');
const assert = require('node:assert/strict');
const { total } = require('../src/report');
test('total of small amounts', () => assert.equal(total(['1.25', '2.50']), '3.75'));
test('total with thousands', () => assert.equal(total(['1,234,567.00', '0.50']), '1234567.50'));
