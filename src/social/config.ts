import path from 'node:path';
import { DEFAULT_SOCIAL_REVIEWER_ID } from './types.js';

export interface SocialConfig {
  reviewerId: string;
  baseUrl: string;
  keyId: string;
  secret: string;
  journalPath: string;
  pollIntervalMs: number;
  accessClientId?: string;
  accessClientSecret?: string;
}

export function readSocialConfig(env: NodeJS.ProcessEnv = process.env): SocialConfig | undefined {
  if (env['SOCIAL_SUGGESTIONS_ENABLED'] !== 'true') return undefined;
  const reviewerId = env['SOCIAL_REVIEWER_DISCORD_ID'] || DEFAULT_SOCIAL_REVIEWER_ID;
  const baseUrl = env['JOB_API_BASE_URL'] || 'https://jobs.egdata.app';
  const keyId = env['JOB_API_KEY_ID'];
  const secret = env['JOB_API_SECRET'];
  const url = new URL(baseUrl);
  if (!/^\d{16,22}$/.test(reviewerId) || !keyId || !secret || secret.length < 32) {
    throw new Error('Social suggestions require a valid reviewer ID and JOB_API_KEY_ID/JOB_API_SECRET (at least 32 characters)');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('JOB_API_BASE_URL must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('JOB_API_BASE_URL must be an origin without credentials, path, query or fragment');
  }
  const pollIntervalMs = Number(env['SOCIAL_POLL_INTERVAL_MS'] || 60000);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10000 || pollIntervalMs > 3600000) {
    throw new Error('SOCIAL_POLL_INTERVAL_MS must be between 10000 and 3600000');
  }
  if (Boolean(env['CF_ACCESS_CLIENT_ID']) !== Boolean(env['CF_ACCESS_CLIENT_SECRET'])) {
    throw new Error('Cloudflare Access service-token values must be configured together');
  }
  return {
    reviewerId, baseUrl: url.origin, keyId, secret,
    journalPath: path.resolve(env['SOCIAL_JOURNAL_PATH'] || 'data/social-suggestions.jsonl'),
    pollIntervalMs, accessClientId: env['CF_ACCESS_CLIENT_ID'], accessClientSecret: env['CF_ACCESS_CLIENT_SECRET'],
  };
}
