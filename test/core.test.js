import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckin, cookieExpiry, domainsFromReply, remainingTraffic, CookieExpiredError, withCheckinRetries } from '../src/core.js';

test('waits 10, 30 and 100 minutes before exhausting four attempts', async () => {
  const waits = [];
  let attempts = 0;
  await assert.rejects(withCheckinRetries(async () => {
    attempts++;
    throw new Error('network failure');
  }, { wait: async delay => waits.push(delay) }), /network failure/);
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [600_000, 1_800_000, 6_000_000]);
});

test('cookie expiry stops retries immediately', async () => {
  let attempts = 0;
  const waits = [];
  await assert.rejects(withCheckinRetries(async () => {
    attempts++;
    if (attempts === 1) throw new Error('timeout');
    throw new CookieExpiredError('expired');
  }, { wait: async delay => waits.push(delay) }), CookieExpiredError);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [600_000]);
});

test('successful retry stops further attempts', async () => {
  let attempts = 0;
  const waits = [];
  const result = await withCheckinRetries(async () => {
    if (++attempts === 1) throw new Error('timeout');
    return 'already checked in';
  }, { wait: async delay => waits.push(delay) });
  assert.equal(result, 'already checked in');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [600_000]);
});

test('parses the remembered session expiry', () => {
  assert.equal(cookieExpiry('uid=1; expire_in=1791264093; key=secret'), 1791264093);
});

test('only accepts exact iKuuu hosts from the automatic reply', () => {
  const text = 'https://ikuuu.top/ https://ikuuu.pw/ https://ikuuu.top.evil.test/ https://other.example/';
  assert.deepEqual(domainsFromReply(text), ['ikuuu.top', 'ikuuu.pw']);
});

test('reads remaining traffic from the encoded user page', () => {
  const html = '<div>剩余流量 <span>43.73</span> GB</div>';
  const wrapper = `var originBody = "${Buffer.from(html).toString('base64')}";`;
  assert.equal(remainingTraffic(wrapper), '43.73 GB');
});

test('distinguishes an already completed checkin from a new reward', () => {
  assert.deepEqual(classifyCheckin('{"ret":0,"msg":"您似乎已经签到过了..."}').status, 'already');
  assert.equal(classifyCheckin('{"ret":1,"msg":"获得 500 MB 流量"}').gained, '500 MB');
});
