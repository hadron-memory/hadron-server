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
import {
  createDraftReply,
  sendDraft,
  flagMessage,
  categorizeMessage,
} from '../exchange/exchange.js';
import type { GraphMessage } from '../exchange/exchange.js';

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
export async function processIncomingEmail(
  connectionId: string,
  refreshToken: string,
  message: GraphMessage,
): Promise<void> {
  const fromAddress = message.from?.emailAddress?.address ?? 'unknown';
  const subject = message.subject ?? '(no subject)';

  // Load Pong settings for this connection
  const settings = await db.pongSettings.findUnique({
    where: { exchangeConnectionId: connectionId },
  });

  if (!settings?.stationId) {
    console.log(`[pong] Skipping — no station linked for connection ${connectionId}`);
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

  // Load knowledge base documents
  const knowledgeDocs = await db.knowledgeDocument.findMany({
    where: { exchangeConnectionId: connectionId },
  });

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

  // Map source doc titles back to IDs
  const sourceDocIds = parsed.sourceDocs
    .map((title) => {
      const doc = knowledgeDocs.find((d) => d.title.toLowerCase() === title.toLowerCase());
      return doc?.id;
    })
    .filter((id): id is string => !!id);

  // Create Outlook draft reply
  const { data: outlookDraft } = await createDraftReply(refreshToken, message.id, parsed.draftBody);

  // Flag and categorize the original email
  await categorizeMessage(refreshToken, message.id, ['Pong Draft Ready']).catch(() => {});
  await flagMessage(refreshToken, message.id, 'flagged').catch(() => {});

  // Store draft in database
  const draft = await db.pongDraft.upsert({
    where: {
      exchangeConnectionId_messageId: {
        exchangeConnectionId: connectionId,
        messageId: message.id,
      },
    },
    create: {
      exchangeConnectionId: connectionId,
      userId: settings.userId,
      messageId: message.id,
      messageSubject: subject,
      messageFrom: fromAddress,
      draftBody: parsed.draftBody,
      confidence,
      sourceDocs: sourceDocIds,
      reasoning: parsed.reasoning,
      status: 'PENDING',
      outlookDraftId: outlookDraft.id,
    },
    update: {
      draftBody: parsed.draftBody,
      confidence,
      sourceDocs: sourceDocIds,
      reasoning: parsed.reasoning,
      status: 'PENDING',
      editedBody: null,
      sentAt: null,
      outlookDraftId: outlookDraft.id,
    },
  });

  console.log(`[pong] Draft created for "${subject}" — confidence: ${(confidence * 100).toFixed(0)}%`);

  // Auto-send if confidence exceeds threshold
  if (settings.autoSendEnabled && confidence >= (settings.confidenceThreshold ?? 0.95)) {
    await sendDraft(refreshToken, outlookDraft.id);
    await db.pongDraft.update({
      where: { id: draft.id },
      data: { status: 'APPROVED', sentAt: new Date() },
    });
    // Clear flag/category since it's been handled
    await categorizeMessage(refreshToken, message.id, []).catch(() => {});
    await flagMessage(refreshToken, message.id, 'complete').catch(() => {});
    console.log(`[pong] Auto-sent reply for "${subject}" (confidence: ${(confidence * 100).toFixed(0)}%)`);
  }
}
