/**
 * #3514 — the partial-turn report on a refused chat extraction.
 *
 * `processChatResponse` is not atomic (findings:chat-extraction-data-node-bypassed-write-gate): it commits the assistant
 * message and the message counter in one transaction, judges and writes the extraction in a second, and only then
 * advances the stage. When the authoring gate refuses the extraction the call errors, and the first transaction has
 * already committed. The refusal keeps its code and role and gains `extensions.partialTurn`, which names the three
 * parts of the turn and nothing else: no id, no task, no revision, nothing the caller could not already read.
 *
 * It is a report, not a promise. It says nothing about retry: repeating the call appends another assistant message.
 */
import { GraphQLError } from 'graphql';
import { AuthoringAttestationError } from './authoringAttestation.js';

export interface PartialTurnReport {
  /** Committed before the extraction was judged. */
  persisted: ['ASSISTANT_MESSAGE', 'MESSAGE_COUNTER'];
  /** The extraction leg, with the existing typed reason the authoring gate gave. */
  refused: [{ component: 'EXTRACTION'; code: string }];
  /** Never reached: the stage edits and the on-complete edge evaluation come after the extraction. */
  notRun: ['STAGE_PROGRESSION'];
}

export function extractionRefusedReport(code: string): PartialTurnReport {
  return {
    persisted: ['ASSISTANT_MESSAGE', 'MESSAGE_COUNTER'],
    refused: [{ component: 'EXTRACTION', code }],
    notRun: ['STAGE_PROGRESSION'],
  };
}

/**
 * Rethrow an extraction refusal with the report attached. Only the authoring gate's typed refusal gets one: any other
 * error (a lock timeout, a database fault) is not a typed refusal of the extraction and passes through untouched.
 */
export function reportPartialTurn(e: unknown): never {
  if (e instanceof AuthoringAttestationError) {
    throw new GraphQLError(e.message, {
      extensions: { ...e.extensions, partialTurn: extractionRefusedReport(e.code) },
    });
  }
  throw e;
}
