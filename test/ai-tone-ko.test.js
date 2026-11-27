'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { analyze } = require('../ai-tone-ko.js');

const ex = (n) => path.join(__dirname, '..', 'examples', n);

test('AI 티가 많은 글은 점수가 높고, 고친 글은 낮다', () => {
  const before = analyze(ex('before.md'));
  const after = analyze(ex('after.md'));
  assert.ok(before.score > 20, `before 점수 ${before.score}`);
  assert.ok(after.score < 3, `after 점수 ${after.score}`);
});

test('패턴별로 실제로 센다', () => {
  const m = analyze(ex('before.md')).metrics;
  assert.ok(m.emoji.count >= 2, 'emoji');
  assert.ok(m.checkmark.count === 3, 'checkmark');
  assert.ok(m.cliche.count >= 6, 'cliche');
  assert.ok(m.emdash.count === 2, 'emdash');
  assert.ok(m.eyebrow_en.count >= 1, 'english label');
  assert.ok(m.same_ending.count >= 1, 'same ending');
});

test('고친 글에서는 상투구·이모지·체크가 0이다', () => {
  const m = analyze(ex('after.md')).metrics;
  assert.strictEqual(m.cliche.count, 0);
  assert.strictEqual(m.emoji.count, 0);
  assert.strictEqual(m.checkmark.count, 0);
});
