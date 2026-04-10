/**
 * Server-side Pong draft generation.
 *
 * Triggered by the Exchange webhook when a new email arrives.
 * Uses the station's AI config (provider/model/key) via Vercel AI SDK.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDecipheriv } from 'crypto';
import { db } from '../db/client.js';
import type { GraphMessage } from '../exchange/exchange.js';
import { listPongKnowledge } from './knowledge.js';
import { getPongSettings, type PongExclusionRule } from './settings.js';
import { createPongDraft } from './drafts.js';

const PONG_SYSTEM_PROMPT = `You are Pong, an AI email assistant for a university professor. Your job is to draft replies to student emails using ONLY the professor's knowledge base documents provided below.

Rules:
1. ONLY use information from the provided knowledge base documents to answer questions.
2. Match the professor's tone and style if a reply tone is specified.
3. Be helpful, professional, and concise.
4. If the knowledge base does not contain enough information to answer the student's question confidently, say so clearly in the reasoning and give a LOW confidence score.
5. Include the professor's signature if provided.
6. Never fabricate information not present in the knowledge base.

You must respond in JSON format with these fields:
- "draftBody": the email reply body (plain text, no HTML)
- "confidence": a number 0.0–1.0 reflecting how well the knowledge base covers this question
- "sourceDocs": array of document titles used to craft the response
- "reasoning": brief explanation of your confidence level and sources used`;

function decryptToken(ciphertext: string): string {
  const keyBuf = Buffer.from(process.env.HADRON_ENCRYPTION_KEY ?? '', 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function createLanguageModel(provider: string, apiKey: string, model: string) {
  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    case 'glm': {
      const glm = createOpenAI({
        apiKey,
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      });
      return glm.chat(model);
    }
    default:
      return null;
  }
}

/**
 * Process an incoming email: generate a draft reply, flag/categorize, and
 * auto-send if confidence exceeds the user's threshold.
 */
function matchesExclusionRule(
  rule: PongExclusionRule,
  fromAddress: string,
  subject: string,
): boolean {
  const senderMatches = rule.senderPattern
    ? new RegExp(rule.senderPattern, 'i').test(fromAddress)
    : true;
  const subjectMatches = rule.subjectPattern
    ? new RegExp(rule.subjectPattern, 'i').test(subject)
    : true;
  // Both conditions must match if both are set; an empty rule never matches.
  if (!rule.senderPattern && !rule.subjectPattern) return false;
  return senderMatches && subjectMatches;
}

export async function processIncomingEmail(
  connectionId: string,
  message: GraphMessage,
): Promise<void> {
  const fromAddress = message.from?.emailAddress?.address ?? 'unknown';
  const subject = message.subject ?? '(no subject)';

  // Load Pong settings for this connection (from hadron memory)
  const settings = await getPongSettings(db, connectionId).catch(() => null);

  if (!settings?.stationId) {
    console.log(`[pong] Skipping — no station linked for connection ${connectionId}`);
    return;
  }

  // Pause: skip if Pong is paused and the pause hasn't expired
  if (settings.pausedUntil && settings.pausedUntil > new Date()) {
    console.log(`[pong] Skipping "${subject}" — Pong is paused until ${settings.pausedUntil.toISOString()}`);
    return;
  }

  // Exclusion rules: skip if any rule matches sender or subject
  const matched = settings.exclusionRules.find((r) => matchesExclusionRule(r, fromAddress, subject));
  if (matched) {
    console.log(`[pong] Skipping "${subject}" from ${fromAddress} — exclusion rule matched (${matched.reason ?? 'no reason'})`);
    return;
  }

  // Load station AI config
  const station = await db.station.findUnique({ where: { id: settings.stationId } });
  if (!station?.aiProvider || !station?.aiModel || !station?.aiApiKeyEncrypted) {
    console.log(`[pong] Skipping — station ${settings.stationId} has no AI config`);
    return;
  }

  const apiKey = decryptToken(station.aiApiKeyEncrypted);
  const languageModel = createLanguageModel(station.aiProvider, apiKey, station.aiModel);
  if (!languageModel) {
    console.log(`[pong] Skipping — unsupported provider: ${station.aiProvider}`);
    return;
  }

  // Load knowledge base documents from hadron memory
  let knowledgeDocs: Awaited<ReturnType<typeof listPongKnowledge>> = [];
  try {
    knowledgeDocs = await listPongKnowledge(db, connectionId);
  } catch (err) {
    console.log(`[pong] Skipping — knowledge lookup failed:`, err instanceof Error ? err.message : err);
    return;
  }

  if (knowledgeDocs.length === 0) {
    console.log(`[pong] Skipping — no knowledge documents for connection ${connectionId}`);
    return;
  }

  // Build the prompt
  const kbContext = knowledgeDocs
    .map((doc, i) => `--- Document ${i + 1}: ${doc.title} (${doc.docType ?? 'general'}) ---\n${doc.content}`)
    .join('\n\n');

  const toneInstruction = settings.replyTone ? `\nReply tone: ${settings.replyTone}` : '';
  const signatureInstruction = settings.signatureText
    ? `\nAppend this signature at the end of the reply:\n${settings.signatureText}`
    : '';

  const messageBody = message.body?.content ?? message.bodyPreview ?? '(empty)';

  const userMessage = `KNOWLEDGE BASE:\n${kbContext}
${toneInstruction}${signatureInstruction}

INCOMING EMAIL:
From: ${fromAddress}
Subject: ${subject}
Body:
${messageBody}

Generate a reply draft in JSON format.`;

  console.log(`[pong] Generating draft for "${subject}" from ${fromAddress}`);

  // Generate with AI
  const result = await generateText({
    model: languageModel,
    system: PONG_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxOutputTokens: 1024,
  });

  // Parse the JSON response
  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`[pong] Failed to parse AI response for message ${message.id}`);
    return;
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    draftBody: string;
    confidence: number;
    sourceDocs: string[];
    reasoning: string;
  };

  const confidence = Math.max(0, Math.min(1, parsed.confidence));

  // Map source doc titles back to ids (node loc)
  const sourceDocIds = parsed.sourceDocs
    .map((title) => {
      const doc = knowledgeDocs.find((d) => d.title.toLowerCase() === title.toLowerCase());
      return doc?.id;
    })
    .filter((id): id is string => !!id);

  // Create the Outlook draft with embedded meta-block. createPongDraft also
  // handles categorizing, flagging, and auto-send based on the user's
  // confidence threshold.
  await createPongDraft(db, {
    connectionId,
    userId: settings.userId,
    messageId: message.id,
    messageSubject: subject,
    messageFrom: fromAddress,
    draftBody: parsed.draftBody,
    confidence,
    reasoning: parsed.reasoning,
    sourceDocs: sourceDocIds,
  });

  console.log(`[pong] Draft created for "${subject}" — confidence: ${(confidence * 100).toFixed(0)}%`);
}
