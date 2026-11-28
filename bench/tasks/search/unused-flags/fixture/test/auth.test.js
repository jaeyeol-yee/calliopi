const test = require('node:test');
const assert = require('node:assert/strict');
const { isEnabled } = require('../src/flags');

test('legacy auth is off by default', () => assert.equal(isEnabled('legacyAuth'), false));
