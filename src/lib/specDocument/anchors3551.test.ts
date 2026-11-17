/** #3551 / ruling 0206: expected IDs are literal contract oracles, never produced by the assigner. */
import { describe, expect, it } from 'vitest';
import { renderSpecDocument, type DocPart, type DocInput, type LinkResolution } from './render.js';
const part = (loc: string, name = 'Rule: Entry'): DocPart => ({loc,name,body:'Body.',isPlaceholder:false,superseded:false,supersededBy:[],approval:{state:'NOT_APPROVED'},minted:false});
function input(locs: string[]): DocInput {
 const links = new Map<string,LinkResolution>(locs.map((loc,index)=>[loc,{kind:'part',loc,name:`entry${index}`} ]));
 const body = locs.map((loc,index)=>`[[${loc}|link${index}]]`).join(' ');
 return {memory:'synthetic:specs',renderedAt:new Date('2026-11-06T00:00:00Z'),feature:{...part('fx:110','Feature: F'),body:`${body}\n---\n${body}`},parts:locs.map(loc=>({...part(loc),body})),links};
}
function expectAnchors(locs:string[], ids:string[]) {
 const doc=input(locs);const rendered=renderSpecDocument(doc);
 expect([...rendered.matchAll(/<a id="([^"]+)"><\/a>/g)].map(match=>match[1])).toEqual(ids);
 expect(new Set(ids).size).toBe(ids.length);
 ids.forEach((id,index)=>expect(rendered).toContain(`[link${index}](#${id})`));
 // Feature body, all part bodies and feature tail share the exact assignment.
 ids.forEach((id,index)=>expect(rendered.split(`[link${index}](#${id})`).length-1).toBe(locs.length+2));
 expect(renderSpecDocument(doc)).toBe(rendered);
 return rendered;
}
describe('#3551 natural reservations and exact-entry links',()=>{
 it('pair golden: first bare, second -2',()=>{
  expectAnchors(['fx:110:a-b','fx:110:a:b'],['fx-110-a-b','fx-110-a-b-2']);
 });
 it('three colliders use distinct smallest suffixes',()=>{
  expectAnchors(['fx:110:a-b-c','fx:110:a:b-c','fx:110:a-b:c'],['fx-110-a-b-c','fx-110-a-b-c-2','fx-110-a-b-c-3']);
 });
 it.each([
  [['fx:110:a-b','fx:110:a:b','fx:110:a-b-2'],['fx-110-a-b','fx-110-a-b-3','fx-110-a-b-2']],
  [['fx:110:a-b-2','fx:110:a-b','fx:110:a:b'],['fx-110-a-b-2','fx-110-a-b','fx-110-a-b-3']],
 ])('reserves natural suffix strings in either order: %j',(locs,ids)=>{expectAnchors(locs,ids);});
 it('reserves all natural IDs and skips already generated suffixes',()=>{
  expectAnchors(['fx:110:a-b-c','fx:110:a:b-c','fx:110:a-b:c','fx:110:a-b-c-2','fx:110:a-b-c-3'],['fx-110-a-b-c','fx-110-a-b-c-4','fx-110-a-b-c-5','fx-110-a-b-c-2','fx-110-a-b-c-3']);
 });
 it('keeps case and does not collide with lower-case spellings',()=>{
  expectAnchors(['fx:110:A-b','fx:110:A:b','fx:110:a-b'],['fx-110-A-b','fx-110-A-b-2','fx-110-a-b']);
 });
 it('uses final grouped document order rather than input citation order',()=>{
  const doc=input(['fx:110:a-b','fx:110:a:b']);doc.parts[0].name='Rule: R';doc.parts[1].name='Definition: D';
  const rendered=renderSpecDocument(doc);
  expect(rendered.indexOf('## Definition: D')).toBeLessThan(rendered.indexOf('## Rule: R'));
  expect(rendered).toContain('[link0](#fx-110-a-b-2)');expect(rendered).toContain('[link1](#fx-110-a-b)');
 });
 it('does not create links to absent or nonpart targets',()=>{
  const doc=input(['fx:110:a']);doc.feature.body='[[missing|Absent]] [[plain|Plain]] [[feature|Feature]]';
  doc.links=new Map([...doc.links,['missing',{kind:'part',loc:'fx:110:absent',name:'Absent'}],['plain',{kind:'plain'}],['feature',{kind:'feature',loc:'fx:110'}]]);
  expect(renderSpecDocument(doc)).toContain('Absent Plain Feature');
 });
 it('noncollision full golden stays byte-identical',()=>{
  const doc=input(['fx:110:a']);doc.feature.body='[[fx:110:a|exact]]';doc.parts[0].body='Rule body.';
  expect(renderSpecDocument(doc)).toBe('# Feature: F [fx:110]\n\nsynthetic:specs · rendered 2026-11-06T00:00Z\n\nReadiness: 2 specs · 0 approved · 0 minted · 0 superseded · no open questions\n\n[exact](#fx-110-a)\n\n# Rules\n\n<a id="fx-110-a"></a>\n\n## Rule: Entry [fx:110:a]\nApproval: NOT_APPROVED · Mint: unminted\n\nRule body.\n');
 });
});
