import {test,expect} from 'vitest';
import {extractDomains} from '../../src/domain-source.js';
import publication from '../fixtures/ikuuu-win-20260911.html?raw';
import {boundedText} from '../../src/body.js';

test('actual publication HTML decodes date, main and backup domains without executing scripts',()=>{
  const result=extractDomains(publication);
  expect(result.updatedAt).toBe('2026-09-11');
  expect(result.domains.map(d=>d.host)).toEqual(['ikuuu.top','ikuuu.pw']);
});
test('changed publication fails safely instead of inventing a domain',()=>{
  expect(()=>extractDomains('<html>new unknown layout</html>')).toThrow();
});
test('stream size bounds apply even without Content-Length',async()=>{
  let canceled=false;
  const response=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(11));},cancel(){canceled=true;}}));
  await expect(boundedText(response,10)).rejects.toThrow();expect(canceled).toBe(true);
});
