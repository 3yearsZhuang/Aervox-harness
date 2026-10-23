import type { z } from 'zod';
import type { TermExploreResponse as ServerResponse, TermsExtractedEventData as ServerEvent } from '../src/server/contracts.js';
import type { ExtractedTerm as ExtractorTerm } from '../src/server/terms-extractor.js';
import type { TermsExtractedEventData as UiEvent, ExtractedTerm as UiTerm } from '../src/ui/plugin-events.js';
import type { termExploreResponseSchema, termsExtractedEventDataSchema, extractedTermSchema } from '../src/contracts/terms.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type WireCompatibility = [
  Assert<Equal<ServerResponse, z.output<typeof termExploreResponseSchema>>>,
  Assert<Equal<UiEvent, ServerEvent>>,
  Assert<Equal<UiEvent, z.output<typeof termsExtractedEventDataSchema>>>,
  Assert<Equal<UiTerm, ExtractorTerm>>,
  Assert<Equal<UiTerm, z.output<typeof extractedTermSchema>>>,
];
