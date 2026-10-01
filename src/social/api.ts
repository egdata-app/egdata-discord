import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { SocialConfig } from './config.js';
import { assertSuggestion, type DeliveryBinding, type ReviewRequest, type SocialSuggestion, type SuggestionsApi } from './types.js';

export class JobApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`Social job API failed (${status}, ${code})`);
  }
}

export function signJobRequest(input: {
  keyId: string; secret: string; timestamp: string; nonce: string; method: string;
  url: string; body: string; idempotencyKey?: string;
}): string {
  const url = new URL(input.url);
  const canonical = ['egdata-job-api-v1', input.keyId, input.timestamp, input.nonce, input.method.toUpperCase(),
    `${url.pathname}${url.search}`, input.idempotencyKey || '', createHash('sha256').update(input.body).digest('hex')].join('\n');
  return createHmac('sha256', input.secret).update(canonical, 'utf8').digest('hex');
}

export class SignedSuggestionsApi implements SuggestionsApi {
  constructor(private readonly config: SocialConfig, private readonly signal: AbortSignal, private readonly transport: typeof fetch = fetch) {}

  private async request(method: string, path: string, value?: unknown, idempotencyKey?: string): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    const body = value === undefined ? '' : JSON.stringify(value);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const headers: Record<string, string> = {
      'X-Api-Key-Id': this.config.keyId, 'X-Api-Timestamp': timestamp, 'X-Api-Nonce': nonce,
      'X-Api-Signature': signJobRequest({ keyId: this.config.keyId, secret: this.config.secret, timestamp, nonce, method, url, body, idempotencyKey }),
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (body) headers['Content-Type'] = 'application/json';
    if (this.config.accessClientId && this.config.accessClientSecret) {
      headers['CF-Access-Client-Id'] = this.config.accessClientId;
      headers['CF-Access-Client-Secret'] = this.config.accessClientSecret;
    }
    const response = await this.transport(url, {
      method, headers, body: body || undefined, redirect: 'error',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new JobApiError(response.status, typeof payload.error === 'string' ? payload.error : 'request_failed');
    }
    return response.json();
  }

  async list(cursor?: string): Promise<{ items: SocialSuggestion[]; nextCursor?: string }> {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const result = await this.request('GET', `/v1/social/suggestions?${query}`) as { items: unknown[]; nextCursor?: string };
    if (!Array.isArray(result.items) || result.items.length > 100 || (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')) {
      throw new Error('Invalid social suggestions list');
    }
    result.items.forEach(assertSuggestion);
    return result as { items: SocialSuggestion[]; nextCursor?: string };
  }

  async get(id: string): Promise<SocialSuggestion> {
    const result = await this.request('GET', `/v1/social/suggestions/${id}`) as { suggestion: unknown };
    assertSuggestion(result.suggestion);
    if (result.suggestion.id !== id) throw new Error('Social suggestion identity mismatch');
    return result.suggestion;
  }

  async deliver(id: string, binding: DeliveryBinding, idempotencyKey: string): Promise<void> {
    await this.request('POST', `/v1/social/suggestions/${id}/delivery`, binding, idempotencyKey);
  }

  async review(id: string, request: ReviewRequest, idempotencyKey: string): Promise<SocialSuggestion> {
    const result = await this.request('POST', `/v1/social/suggestions/${id}/review`, request, idempotencyKey) as { suggestion: unknown };
    assertSuggestion(result.suggestion);
    if (result.suggestion.id !== id || result.suggestion.version !== request.version) throw new Error('Social review identity mismatch');
    return result.suggestion;
  }
}
