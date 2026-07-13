import { GraphQLError } from 'graphql';

/**
 * Client for the Home Assistant capability tool
 * (hadrontool-home-assistant). Mirrors mcpToolClient.ts: hadron-server
 * stays the front door — the policy chain and org gates have all run
 * before anything here is called — and this module only ships
 * already-authorized requests to the internal tool, which speaks the HA
 * REST API per request (stateless).
 *
 * Configured by env:
 *   HA_TOOL_URL    e.g. http://hadrontool-home-assistant:8080 (required)
 *   HA_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: HA_TOOL_NOT_CONFIGURED / HA_TOOL_UNREACHABLE /
 * HA_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * tool's own typed codes (validation_error, private_network_blocked,
 * upstream_unreachable, upstream_timeout, ha_auth_failed, ha_not_found,
 * ha_error) via extensions.haErrorCode.
 */

const CALL_TIMEOUT_MS = 30_000;

/** The registered instance a request is aimed at. */
export interface HaTarget {
  /** Home Assistant base URL. */
  url: string;
  /** Decrypted long-lived access token. */
  accessToken: string;
}

function tool(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.HA_TOOL_URL;
  if (!baseUrl) {
    throw new GraphQLError('Home Assistant instances are not configured (HA_TOOL_URL unset).', {
      extensions: { code: 'HA_TOOL_NOT_CONFIGURED' },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env.HA_TOOL_TOKEN || undefined };
}

/**
 * Invoke one op route on the tool for one instance. `route` is an HA_OPS
 * catalog route segment; `args` are the LLM-facing op arguments — the
 * target credentials are injected here, never seen by the model. Returns
 * the tool's JSON payload verbatim (already bounded tool-side).
 */
export async function callHaOp(
  target: HaTarget,
  route: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = tool();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}/ops/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...args, baseUrl: target.url, accessToken: target.accessToken }),
      signal: controller.signal,
    });
    // The body read stays INSIDE the timeout window (slackClient posture).
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body → outer catch
      payload = null;
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(
      timedOut ? 'Home Assistant tool timed out.' : 'Home Assistant tool is unreachable.',
      { extensions: { code: 'HA_TOOL_UNREACHABLE', cause: String(err) } },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const haErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message =
      typeof payload?.message === 'string'
        ? payload.message.slice(0, 500)
        : `Home Assistant tool error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'HA_TOOL_ERROR',
        ...(haErrorCode ? { haErrorCode } : {}),
        status: res.status,
      },
    });
  }

  if (!payload) {
    throw new GraphQLError('Home Assistant tool returned an unexpected response.', {
      extensions: { code: 'HA_TOOL_ERROR' },
    });
  }
  return payload;
}
