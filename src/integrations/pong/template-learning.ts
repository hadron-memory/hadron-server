/**
 * Template learning from professor edits.
 *
 * When a professor edits and sends a Pong draft, this module:
 * 1. Matches the sent email back to the original PongDraft via conversationId
 * 2. Compares the original draft with the professor's sent version
 * 3. Uses AI to extract a reusable reply template from the edit
 * 4. Stores the template as a KnowledgeDocument for future drafts
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDecipheriv } from 'crypto';
import { db } from '../db/client.js';
import type { GraphMessage } from '../exchange/exchange.js';

const TEMPLATE_EXTRACTION_PROMPT = `You are analyzing how a professor edited an AI-generated email draft. Your job is to extract a reusable reply template from the professor's version.

Given:
- The original AI-generated draft
- The professor's edited/sent version
- The original incoming email subject and sender

Extract a generalized reply template that captures the professor's preferred style and content patterns. The template should:
1. Replace specific names/dates/details with placeholders like [STUDENT_NAME], [DATE], [SPECIFIC_DETAIL]
2. Preserve the professor's tone, greeting style, and sign-off
3. Identify what TYPE of email this template applies to (e.g., "grade inquiry", "office hours request", "extension request", "recommendation letter")

Respond in JSON format:
- "templateTitle": short descriptive title for this template (e.g., "Grade Inquiry Response")
- "emailType": the category of email this template applies to
- "templateContent": the generalized reply template with placeholders
- "keyChanges": brief summary of what the professor changed from the AI draft (helps improve future drafts)
- "shouldSave": boolean — false if the edits were trivial (typo fixes, minor rewording) and don't warrant a template`;

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

/** Strip HTML tags and normalize whitespace for comparison */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Process a sent email: match it to a Pong draft, learn from edits.
 * Called when the sentItems webhook fires.
 */
export async function processSentEmail(
  connectionId: string,
  refreshToken: string,
  sentMessage: GraphMessage,
): Promise<void> {
  const conversationId = sentMessage.conversationId;
  if (!conversationId) {
    console.log(`[pong-learn] Skipping — sent message has no conversationId`);
    return;
  }

  // Find a matching Pong draft by conversationId for this connection
  const draft = await db.pongDraft.findFirst({
    where: {
      exchangeConnectionId: connectionId,
      conversationId,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!draft) {
    // No Pong draft for this conversation — professor replied without Pong
    return;
  }

  const sentBody = stripHtml(sentMessage.body?.content ?? sentMessage.bodyPreview ?? '');
  const draftBody = stripHtml(draft.draftBody);

  // Check if the sent version is substantially the same
  if (sentBody === draftBody) {
    // Professor sent as-is — mark approved, no template needed
    await db.pongDraft.update({
      where: { id: draft.id },
      data: { status: 'APPROVED', sentAt: new Date() },
    });
    console.log(`[pong-learn] Draft approved as-is for "${draft.messageSubject}"`);
    return;
  }

  // Professor edited — store the edit and learn from it
  await db.pongDraft.update({
    where: { id: draft.id },
    data: {
      status: 'EDITED',
      editedBody: sentBody,
      sentAt: new Date(),
    },
  });

  console.log(`[pong-learn] Draft was edited for "${draft.messageSubject}" — extracting template`);

  // Load station AI config for template extraction
  const settings = await db.pongSettings.findUnique({
    where: { exchangeConnectionId: connectionId },
  });

  if (!settings?.stationId) return;

  const station = await db.station.findUnique({ where: { id: settings.stationId } });
  if (!station?.aiProvider || !station?.aiModel || !station?.aiApiKeyEncrypted) return;

  const apiKey = decryptToken(station.aiApiKeyEncrypted);
  const languageModel = createLanguageModel(station.aiProvider, apiKey, station.aiModel);
  if (!languageModel) return;

  // Use AI to extract a template from the edit
  const result = await generateText({
    model: languageModel,
    system: TEMPLATE_EXTRACTION_PROMPT,
    messages: [
      {
        role: 'user',
        content: `ORIGINAL AI DRAFT:
${draft.draftBody}

PROFESSOR'S SENT VERSION:
${sentBody}

ORIGINAL EMAIL:
Subject: ${draft.messageSubject ?? '(no subject)'}
From: ${draft.messageFrom ?? 'unknown'}

Extract a reusable template in JSON format.`,
      },
    ],
    maxOutputTokens: 1024,
  });

  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`[pong-learn] Failed to parse template extraction response`);
    return;
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    templateTitle: string;
    emailType: string;
    templateContent: string;
    keyChanges: string;
    shouldSave: boolean;
  };

  if (!parsed.shouldSave) {
    console.log(`[pong-learn] Edits were trivial for "${draft.messageSubject}" — skipping template`);
    return;
  }

  // Check if a template for this email type already exists — update it if so
  const existingTemplate = await db.knowledgeDocument.findFirst({
    where: {
      exchangeConnectionId: connectionId,
      docType: 'template',
      title: { contains: parsed.emailType },
      deletedAt: null,
    },
  });

  if (existingTemplate) {
    await db.knowledgeDocument.update({
      where: { id: existingTemplate.id },
      data: {
        content: `Email type: ${parsed.emailType}\n\nTemplate:\n${parsed.templateContent}\n\nKey patterns: ${parsed.keyChanges}`,
      },
    });
    console.log(`[pong-learn] Updated existing template "${existingTemplate.title}" for "${draft.messageSubject}"`);
  } else {
    await db.knowledgeDocument.create({
      data: {
        exchangeConnectionId: connectionId,
        userId: draft.userId,
        title: `Reply Template: ${parsed.templateTitle}`,
        content: `Email type: ${parsed.emailType}\n\nTemplate:\n${parsed.templateContent}\n\nKey patterns: ${parsed.keyChanges}`,
        docType: 'template',
      },
    });
    console.log(`[pong-learn] Created new template "${parsed.templateTitle}" from edit of "${draft.messageSubject}"`);
  }
}
