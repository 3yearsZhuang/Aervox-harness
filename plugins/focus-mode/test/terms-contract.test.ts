import { expect, it } from 'vitest';
import { termExploreResponseSchema, termsExtractedEventDataSchema } from '../src/contracts/terms';
import { parseTermsExtracted } from '../src/ui/plugin-events';
it('uses one event schema for browser parsing and server projection', () => {
  const valid={turnId:'turn',terms:[{text:'SQLite',relation:'background',description:'数据库',privateField:'secret'}]};
  expect(parseTermsExtracted(valid)).toEqual(termsExtractedEventDataSchema.parse(valid));
  expect(parseTermsExtracted({...valid,turnId:''})).toBeNull();
  expect(parseTermsExtracted({...valid,terms:[{text:'',relation:'related'}]})).toBeNull();
  expect(parseTermsExtracted({...valid,terms:[{text:'x',relation:'unknown'}]})).toBeNull();
});
it('parses exploration defaults and removes fields not declared by the wire contract', () => {
  expect(termExploreResponseSchema.parse({term:'SQLite',kind:'related',content:'解释',internal:'secret'}))
    .toEqual({term:'SQLite',kind:'related',content:'解释',relatedQuestions:[]});
});
