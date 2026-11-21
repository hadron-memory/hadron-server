/** Metadata-only App writes preserve kind binding without reading or staging the unchanged value. */
import { describe, expect, it } from 'vitest';
import { validateUnchangedSecretMetadata } from './secrets.js';
describe('#3999 unchanged App value metadata',()=>{
 it('normalizes the stored webfetch type and validates the new origin binding',()=>{
  expect(validateUnchangedSecretMetadata('webfetch-auth',{urlPrefix:'https://example.test/api'},{type:'bearer'})).toEqual({type:'bearer',urlPrefix:'https://example.test/api'});
 });
 it.each([
  {type:'basic',urlPrefix:'https://example.test/'},
  {urlPrefix:'https://user:password@example.test/'},
  {urlPrefix:'https://example.test/?token=secret'},
  {},
 ])('refuses a metadata edit that breaks the existing value binding: %j',metadata=>{
  expect(()=>validateUnchangedSecretMetadata('webfetch-auth',metadata,{type:'bearer'})).toThrow();
 });
 it('enforces metadata object shape and size for generic secrets',()=>{
  expect(validateUnchangedSecretMetadata('generic',{label:'new'},{})).toEqual({label:'new'});
  expect(()=>validateUnchangedSecretMetadata('generic',[],{})).toThrow();
  expect(()=>validateUnchangedSecretMetadata('generic',{label:'x'.repeat(4096)},{})).toThrow();
 });
});
