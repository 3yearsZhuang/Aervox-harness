import { createSummaryCompaction, defaultContextBuilder, type ContextBuilderPort, type PromptMessage } from '@aervox/core/browser';

// Leave space below the native 256 KiB request cap for its fixed envelope and
// model options. Measure JSON bytes, including escaping, rather than text size.
const MESSAGE_LIMIT = 128;
const MESSAGE_BYTES = 240 * 1024;
const encoder = new TextEncoder();

/** Native request packing reuses Core's explicit omission policy and report.
 * Durable history stays intact; only the model-visible projection is bounded.
 */
export const nativeContextBuilder: ContextBuilderPort = {
  async build(input) {
    let limit = MESSAGE_LIMIT;
    const messageBytes = new WeakMap<PromptMessage, number>();
    const size = (message: PromptMessage) => {
      const cached = messageBytes.get(message);
      if (cached !== undefined) return cached;
      const bytes = encoder.encode(JSON.stringify({ role: message.role, content: message.content })).byteLength;
      messageBytes.set(message, bytes);
      return bytes;
    };
    for (;;) {
      input.signal?.throwIfAborted();
      const compacted = await createSummaryCompaction({ maxMessages: limit }).compact(input);
      const first = compacted.messages.find(message => message.role !== 'system');
      const bytes = 2 + Math.max(0, compacted.messages.length - 1) + compacted.messages.reduce((total, message) => total + size(message), 0);
      if (compacted.messages.length <= MESSAGE_LIMIT && bytes <= MESSAGE_BYTES
        && first?.role !== 'assistant') {
        return { ...await defaultContextBuilder.build({ ...input, messages: compacted.messages }),
          pruningReport: compacted.pruningReport };
      }
      // A retained assistant must keep its preceding user input. Ask the same
      // shared policy for a smaller suffix instead of inventing a summary.
      if (limit <= 3) throw new Error('NATIVE_CONTEXT_LIMIT');
      limit = Math.min(limit - 1, compacted.messages.length - 1);
    }
  },
};
