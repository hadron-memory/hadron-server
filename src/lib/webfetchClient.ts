import { GraphQLError } from 'graphql';

/**
 * Client for the internal hadrontool-webfetch capability tool (#628/#667).
 * The `/ops` plane is stateless; the `/polls` plane owns durable watch jobs.
 * Mirrors pdfClient.ts / emailClient.ts: hadron-server stays the front
 * door — the policy chain + grant model have already authorized the run before
 * anything here is called — and this module only ships an already-authorized
 * request to the tool and returns its typed result.
 *
 * Ops calls are self-contained and, when a fetch needs credentials, the caller
 * supplies them inline in `auth`. This client performs exactly ONE request per
 * call and NEVER retries. That is load-bearing for non-GET operations:
 * `http-request` may
 * POST/PUT/PATCH/DELETE, which are not known-idempotent, so an auto-retry could
 * double a side effect. GET/HEAD (`fetch-url` / `check-url`) are safe to retry,
 * but retry policy belongs to the caller, not this client.
 *
 * Configured by env:
 *   WEBFETCH_TOOL_URL    base URL, e.g. http://hadrontool-webfetch:8080 (required)
 *   WEBFETCH_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: WEBFETCH_TOOL_NOT_CONFIGURED / WEBFETCH_TOOL_UNREACHABLE /
 * WEBFETCH_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * tool's own stable, typed codes (validation_error, url_forbidden,
 * url_unresolvable, fetch_timeout, fetch_failed, response_too_large,
 * unsupported_content_type, too_many_redirects) via extensions.webfetchErrorCode.
 *
 * SECRET HYGIENE: caller-supplied `auth` is credential material. It is passed
 * to the tool in the request body and is NEVER placed on an error path here —
 * error extensions carry only the tool's typed code + a capped message, never
 * the request input. (The tool likewise redacts credentials from its own error
 * bodies, including validation errors — see #628.)
 */

/**
 * Caller-supplied per-request authentication (inline in the op input). The tool
 * applies it to the outbound request and DROPS it on any redirect hop that
 * leaves the original origin (#628). hadron-server run tools do NOT yet expose
 * this to LLM runs — the credentials-node indirection lands core-side later
 * (#628 "hadron-server side"). GraphQL/API callers that already hold a secret
 * may set it.
 */
export type WebFetchAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string };

export type WebFetchFormat = 'markdown' | 'text' | 'html' | 'links';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FetchUrlInput {
  url: string;
  /** Output shape (default markdown). `links` returns only the link graph. */
  format?: WebFetchFormat;
  /** Cap on response bytes read (the tool also enforces its own ceiling). */
  maxBytes?: number;
  /** Extra request headers — the tool allow-lists these (accept, accept-language). */
  headers?: Record<string, string>;
  auth?: WebFetchAuth;
}

export interface FetchUrlResult {
  finalUrl: string;
  status: number;
  contentType: string | null;
  title: string | null;
  content: string;
  /** Present only for `format: 'links'`. */
  links?: { text: string; href: string }[];
  truncated: boolean;
  /** The tool tags fetched content as untrusted external input (#628). */
  source?: 'external';
}

export interface CheckUrlInput {
  url: string;
  auth?: WebFetchAuth;
}

export interface CheckUrlResult {
  finalUrl: string;
  status: number;
  contentType: string | null;
  contentLength?: number;
  redirectLocation?: string;
}

export interface HttpRequestInput {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Raw string body. Use `body` OR `json`, not both. */
  body?: string;
  /** JSON body — the tool serializes it and sets application/json. */
  json?: unknown;
  maxBytes?: number;
  auth?: WebFetchAuth;
}

export interface HttpRequestResult {
  method: HttpMethod;
  finalUrl: string;
  status: number;
  /** Allow-listed subset of response headers (never the full set). */
  headers: Record<string, string>;
  contentType: string | null;
  /** Parsed JSON when the response is JSON, else capped text. */
  body: unknown;
  truncated: boolean;
  source?: 'external';
}

export type WebPollContentKind = 'auto' | 'html' | 'json';
export type WebPollMode = 'any' | 'all';
export type WebPollFirePolicy = 'once' | 'every_change' | 'cooldown';

/** Conditions are validated and evaluated by the sidecar's shared schema. */
export type WebPollCondition = Record<string, unknown>;

export interface CreatePollInput {
  url: string;
  contentKind?: WebPollContentKind;
  conditions: WebPollCondition[];
  mode?: WebPollMode;
  intervalSeconds: number;
  ttlSeconds: number;
  firePolicy?: WebPollFirePolicy;
  cooldownSeconds?: number;
  headers?: Record<string, string>;
  auth?: WebFetchAuth;
  orgId: string;
  appId?: string;
  /** Audit provenance only. Legacy wire name (tool-side rename pending);
   *  since #677 it carries the resolved Secret reference (`secret:<id>`). */
  credentialsNodeUrn?: string;
  /** Audit provenance only; core enforces this binding before creation. */
  urlPrefix?: string;
}

export interface CreatePollResult {
  jobId: string;
  nextRunAt: string;
  expiresAt: string;
}

export interface WebPollStatus {
  jobId: string;
  orgId?: string;
  appId?: string | null;
  url?: string;
  status: string;
  nextRunAt?: string | null;
  expiresAt: string;
  lastCheckedAt?: string | null;
  lastTriggeredAt?: string | null;
  triggerCount: number;
  consecutiveFailures: number;
}

export interface ListPollsResult {
  jobs: WebPollStatus[];
}

/**
 * Client timeout. Set ABOVE the tool's own total fetch budget so a genuinely
 * slow page surfaces as the tool's typed `fetch_timeout` (a WEBFETCH_TOOL_ERROR
 * carrying the stable code) rather than a client-side abort that a caller can't
 * distinguish from an unreachable tool.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

function toolConfig(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.WEBFETCH_TOOL_URL;
  if (!baseUrl) {
    throw new GraphQLError('Web fetch is not configured (WEBFETCH_TOOL_URL unset).', {
      extensions: { code: 'WEBFETCH_TOOL_NOT_CONFIGURED' },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env.WEBFETCH_TOOL_TOKEN || undefined };
}

/**
 * POST a single op to the stateless tool's `/ops/<operation>` plane with a
 * timeout and typed-error mapping. One request, no retry (see module doc).
 */
async function runToolRequest<T>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  input?: unknown,
): Promise<T> {
  const { baseUrl, token } = toolConfig();
  // Serialize BEFORE opening the network try: a serialization failure (a
  // circular ref, or a BigInt in `json`) is a caller-input error, not an
  // unreachable tool — mapping it to WEBFETCH_TOOL_UNREACHABLE would be
  // misleading. Never attach `input` to the error — it can carry credentials.
  let body: string | undefined;
  if (input !== undefined) {
    try {
      body = JSON.stringify(input);
    } catch (err) {
      throw new GraphQLError('Web fetch request could not be serialized.', {
        extensions: { code: 'WEBFETCH_TOOL_ERROR', cause: String(err) },
      });
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    // Keep the body read inside the timeout window — a tool that sends headers
    // and then stalls mid-body must abort too, not hang the run (this bit
    // ms-exchange; PR-486 / Codex P2).
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body → outer catch
      payload = null; // malformed/empty body — handled below
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    // NB: never attach `input` here — it can carry caller-supplied credentials.
    throw new GraphQLError(timedOut ? 'Web fetch service timed out.' : 'Web fetch service is unreachable.', {
      extensions: { code: 'WEBFETCH_TOOL_UNREACHABLE', cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The tool's typed error body: { error: <code>, message, ... }. Surface the
    // stable code so callers react to the contract, not to HTTP statuses. Cap
    // the message; a misbehaving tool must not inflate the response.
    const webfetchErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message =
      typeof payload?.message === 'string'
        ? payload.message.slice(0, 500)
        : `Web fetch service error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'WEBFETCH_TOOL_ERROR',
        ...(webfetchErrorCode ? { webfetchErrorCode } : {}),
        status: res.status,
      },
    });
  }

  if (!payload) {
    throw new GraphQLError('Web fetch service returned an unexpected response.', {
      extensions: { code: 'WEBFETCH_TOOL_ERROR' },
    });
  }
  return payload as T;
}

async function runOperation<T>(operation: string, input: unknown): Promise<T> {
  return runToolRequest<T>(`/ops/${operation}`, 'POST', input);
}

/** GET a page and return readable content (the workhorse). Retry-safe. */
export function fetchUrl(input: FetchUrlInput): Promise<FetchUrlResult> {
  return runOperation<FetchUrlResult>('fetch-url', input);
}

/** HEAD a URL — cheap link validation, no body. Retry-safe. */
export function checkUrl(input: CheckUrlInput): Promise<CheckUrlResult> {
  return runOperation<CheckUrlResult>('check-url', input);
}

/**
 * Call an HTTP API with any method. NEVER auto-retried (non-GET methods are not
 * known-idempotent — see module doc); the tool does not follow redirects on
 * non-GET, returning the 3xx to the caller instead.
 */
export function httpRequest(input: HttpRequestInput): Promise<HttpRequestResult> {
  return runOperation<HttpRequestResult>('http-request', input);
}

/** Create one durable GET-only watch job. One request; no blind retries. */
export function createPoll(input: CreatePollInput): Promise<CreatePollResult> {
  return runToolRequest<CreatePollResult>('/polls', 'POST', input);
}

/** Read one poll's sanitized status/counters. */
export function getPoll(jobId: string): Promise<WebPollStatus> {
  return runToolRequest<WebPollStatus>(`/polls/${encodeURIComponent(jobId)}`, 'GET');
}

/** List sanitized jobs for exactly one core-authorized organization. */
export function listPolls(organizationId: string): Promise<ListPollsResult> {
  return runToolRequest<ListPollsResult>(`/polls?orgId=${encodeURIComponent(organizationId)}`, 'GET');
}

/** Cancel one poll. Core checks ownership before calling this. */
export function cancelPoll(jobId: string): Promise<WebPollStatus> {
  return runToolRequest<WebPollStatus>(`/polls/${encodeURIComponent(jobId)}`, 'DELETE');
}
