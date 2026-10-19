import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {renderBatch} from './renderBatch.js';
const msg=(seq:number,body='body')=>({channelId:'channel-a',seq,createdAt:new Date(seq),authorName:'Ada',body,parentSeq:null,parent:null,mentions:[]});
it('bounds a single multibyte oversize message with an explicit historical-read stub and exact proof range',()=>{
 const body='界'.repeat(65536);
 const out=renderBatch({workerName:'Diego',messages:[msg(1,body),msg(2)]});
 expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(128000);
 expect(out.text).toContain('[oversize message omitted');
 expect(out.text).toContain("hadron channel read 'channel-a' --since 0 --before 2 --limit 1");
 expect(out.text).not.toContain(body);
 expect(out.renderedCount).toBe(1);expect(out.overflow).toBe(1);
 expect(out.ranges).toEqual([{channelId:'channel-a',fromSeq:1,throughSeq:1,seqs:[1]}]);
 expect(out.renderHash).toBe(createHash('sha256').update(out.text).digest('hex'));
});
it('counts authors/header/parent/overflow/hint bytes and trims only an oldest prefix',()=>{
 const messages=Array.from({length:10},(_,i)=>({...msg(i+1),authorName:'界'.repeat(10000)}));
 const out=renderBatch({workerName:'Diego',messages,totalEligible:20});
 expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(128000);
 expect(out.renderedCount).toBe(4);expect(out.overflow).toBe(16);
 expect(out.ranges[0].seqs).toEqual([1,2,3,4]);expect(out.text).toContain('+16 more waiting');
});
it('bounds pathological display metadata in the first-message stub without mutating input',()=>{
 const message={...msg(1,'whole'),authorName:'😀'.repeat(40000),parentSeq:9,parent:{seq:9,authorName:'界'.repeat(50000),excerpt:'parent'}};
 const input={workerName:'界'.repeat(50000),messages:[message]};const before=structuredClone(input);
 const out=renderBatch(input);
 expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(128000);expect(out.text).toContain('[oversize message omitted');
 expect(out.text).not.toContain('\uFFFD');expect(input).toEqual(before);
});
it('retains whole ordinary first messages above the character budget when they fit the transport',()=>{
 const body='x'.repeat(7000);const out=renderBatch({workerName:'Diego',messages:[msg(1,body),msg(2)]});
 expect(out.text).toContain(body);expect(out.text).not.toContain('[oversize');expect(out.overflow).toBe(1);
});
it('keeps an exact byte-ceiling envelope whole and stubs the first byte beyond it',()=>{
 const overhead=Buffer.byteLength(renderBatch({workerName:'Diego',messages:[msg(1,'')]}).text);
 const body='x'.repeat(128000-overhead);
 const exact=renderBatch({workerName:'Diego',messages:[msg(1,body)]});
 expect(Buffer.byteLength(exact.text)).toBe(128000);expect(exact.text).toContain(body);
 const over=renderBatch({workerName:'Diego',messages:[msg(1,body+'x')]});
 expect(over.text).toContain('[oversize message omitted');expect(Buffer.byteLength(over.text)).toBeLessThan(128000);
});
