export const DEFAULT_SOCIAL_REVIEWER_ID = '709042878592057406';
export const REVIEW_REACTIONS = { '✅': 'approve', '❌': 'reject', '🔄': 'rewrite' } as const;
export type ReviewAction = typeof REVIEW_REACTIONS[keyof typeof REVIEW_REACTIONS];
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'publishing' | 'published' | 'publication_unknown' | 'failed';

export interface SocialSuggestion {
  id: string;
  version: number;
  text: string;
  rationale: string;
  evidence: Array<{ id: string; kind: 'database' | 'web'; label: string; url?: string; observedAt: string }>;
  expiresAt: string;
  createdAt: string;
  updatedAt?: string;
  status: SuggestionStatus;
  recipientId: string;
  discordMessageId?: string;
  discordChannelId?: string;
  tweetUrl?: string;
  error?: string;
}

export interface DeliveryBinding {
  version: number;
  recipientId: string;
  discordMessageId: string;
  discordChannelId: string;
}

export interface ReviewRequest extends Omit<DeliveryBinding, 'recipientId'> {
  action: ReviewAction;
  actorId: string;
}

export interface SuggestionsApi {
  list(cursor?: string): Promise<{ items: SocialSuggestion[]; nextCursor?: string }>;
  get(id: string): Promise<SocialSuggestion>;
  deliver(id: string, binding: DeliveryBinding, idempotencyKey: string): Promise<void>;
  review(id: string, request: ReviewRequest, idempotencyKey: string): Promise<SocialSuggestion>;
}

export function suggestionKey(suggestion: Pick<SocialSuggestion, 'id' | 'version'>): string {
  return `${suggestion.id}:${suggestion.version}`;
}

function validSourceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function assertSuggestion(value: unknown): asserts value is SocialSuggestion {
  const s = value as SocialSuggestion | null;
  const states: SuggestionStatus[] = ['pending', 'approved', 'rejected', 'expired', 'publishing', 'published', 'publication_unknown', 'failed'];
  if (!s || !/^[a-f0-9]{64}$/.test(s.id) || !Number.isSafeInteger(s.version) || s.version < 1
    || typeof s.text !== 'string' || s.text.length < 1 || s.text.length > 4096
    || typeof s.rationale !== 'string' || s.rationale.length > 1000
    || !/^\d{16,22}$/.test(s.recipientId) || !states.includes(s.status)
    || !Number.isFinite(Date.parse(s.expiresAt)) || !Number.isFinite(Date.parse(s.createdAt))
    || (s.updatedAt !== undefined && !Number.isFinite(Date.parse(s.updatedAt)))
    || !Array.isArray(s.evidence) || s.evidence.length > 20
    || s.evidence.some(e => !e || typeof e.id !== 'string' || !['database', 'web'].includes(e.kind)
      || typeof e.label !== 'string' || e.label.length > 250 || !Number.isFinite(Date.parse(e.observedAt))
      || (e.url !== undefined && !validSourceUrl(e.url)))) {
    throw new Error('Invalid social suggestion response');
  }
}
