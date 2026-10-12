import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo } from './sum.mjs';

test('sumTo(n) adds every integer from 0 through n', () => {
  assert.equal(sumTo(0), 0);
  assert.equal(sumTo(1), 1);
  assert.equal(sumTo(4), 10);
});
