/**
 * #5354 (hrn:node:hadronmemory.com:specs:cor:dmo:020:02, follow-up to #5311 / #5306): the MCP `hadron_update_node` abstract
 * description states the 2000-character cap AND says where the long text goes ("for the long form use `content`"), as the
 * create shape, the runner tools and the GraphQL inputs already do. The wording names a place for the author's text and
 * never says the server moves, truncates or derives anything (020:02: description, abstract and content are three
 * independent texts). The cap and its runtime refusal are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { SHAPE_HADRON_CREATE_NODE, SHAPE_HADRON_UPDATE_NODE } from './toolShapes.js';

const POINTER = 'for the long form use `content`';
const abstractText = (shape: { abstract: { description?: string } }): string => shape.abstract.description ?? '';

describe('#5354: hadron_update_node abstract names where the long form goes', () => {
  it('states the cap and the pointer, once, in the update shape', () => {
    const text = abstractText(SHAPE_HADRON_UPDATE_NODE as never);
    expect(text).toContain('max 2000 chars');
    expect(text.split(POINTER)).toHaveLength(2);
  });

  it('says nothing about moving, truncating or deriving', () => {
    expect(abstractText(SHAPE_HADRON_UPDATE_NODE as never)).not.toMatch(/truncat|moved? (in)?to|overflow|derive/i);
  });

  it('keeps the clear-with-null and staleness text the shape already carried', () => {
    const text = abstractText(SHAPE_HADRON_UPDATE_NODE as never);
    expect(text).toContain('Pass `null` to clear; omit to preserve.');
    expect(text).toContain('STALENESS:');
  });

  it('matches the create shape, which already carries the same pointer', () => {
    expect(abstractText(SHAPE_HADRON_CREATE_NODE as never)).toContain(POINTER);
  });
});
