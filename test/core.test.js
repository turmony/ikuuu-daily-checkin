import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckin, cookieExpiry, domainsFromReply, remainingTraffic } from '../src/core.js';

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
