// Phase-0 spike (plan-tools §5 step 0): one tool round-trip on bedrock —
// the provider that hung generateObject (#535). Pass = model calls the
// tool, receives the result, produces final text within the step cap.
import { readFileSync } from 'node:fs';
import { generateText, tool, jsonSchema, stepCountIs } from 'ai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

const credsPath = process.argv[2];
if (!credsPath) {
  console.error('usage: node scripts/spike-tool-loop.mjs <bedrock-credentials.json>  # {accessKeyId, secretAccessKey, region, model}');
  process.exit(2);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const model = createAmazonBedrock({
  region: creds.region, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey,
})(creds.model);

const calls = [];
const t0 = Date.now();
const timeout = AbortSignal.timeout(45_000);
try {
  const out = await generateText({
    model,
    system: 'You are executing one step of an automation flow.',
    prompt: 'Look up the node "triage:alerts" using the hadron_read_node tool, then reply with one sentence summarizing it.',
    tools: {
      hadron_read_node: tool({
        description: 'Read a Hadron node by loc. Returns its content.',
        inputSchema: jsonSchema({ type: 'object', properties: { loc: { type: 'string' } }, required: ['loc'] }),
        execute: async ({ loc }) => {
          calls.push(loc);
          return { loc, content: 'MCP Endpoint Outage — Micromentor production endpoint down, funder demo 3pm.' };
        },
      }),
    },
    stopWhen: stepCountIs(4),
    abortSignal: timeout,
  });
  console.log(JSON.stringify({
    ok: true, ms: Date.now() - t0, toolCalls: calls, steps: out.steps.length,
    tokens: { in: out.usage?.inputTokens, out: out.usage?.outputTokens },
    text: out.text.slice(0, 160),
  }, null, 1));
} catch (err) {
  console.log(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String(err?.message ?? err) }));
}
