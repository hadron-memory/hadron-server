/**
 * URL content extraction utility for Pong.
 *
 * Fetches a URL and extracts readable text content by stripping HTML.
 * Used by the Pong chat's fetch_url_content tool.
 */

/**
 * Fetch a URL and extract its text content.
 * Strips HTML tags, scripts, styles, and normalizes whitespace.
 */
export async function extractUrlContent(url: string, maxLength = 10000): Promise<{
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Pong/1.0 (Hadron Email Agent)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    // Extract title from HTML
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : undefined;

    let text: string;

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      // Strip HTML
      text = body
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // Assume plain text
      text = body.trim();
    }

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + '...(truncated)';
    }

    return { success: true, content: text, title };
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return { success: false, error: 'Request timed out after 15 seconds' };
    }
    return { success: false, error: e instanceof Error ? e.message : 'Failed to fetch URL' };
  }
}
