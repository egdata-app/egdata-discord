import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SignedSuggestionsApi, signJobRequest } from '../dist/social/api.js';
import { readSocialConfig } from '../dist/social/config.js';
import { suggestionMessage } from '../dist/social/discord.js';
import { FileSuggestionsJournal } from '../dist/social/journal.js';
import { SocialSuggestionsService } from '../dist/social/service.js';
import { assertSuggestion } from '../dist/social/types.js';

const reviewerId = '709042878592057406';
const config = {
  reviewerId, baseUrl: 'https://jobs.egdata.app', keyId: 'discord', secret: 's'.repeat(32),
  journalPath: 'unused', pollIntervalMs: 10000,
};

function suggestion(overrides = {}) {
  return {
    id: 'a'.repeat(64), version: 1, text: 'End of Abyss ranks #9 on Top Wishlisted.',
    rationale: 'A timely ranking milestone.', evidence: [{ id: 'rank', kind: 'database', label: 'Top Wishlisted #9', observedAt: new Date().toISOString() }],
    expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    status: 'pending', recipientId: reviewerId, ...overrides,
  };
}

function harness(initial = suggestion(), journal) {
  const state = { current: initial, sends: 0, reviews: [], deliveries: [], refreshes: [], findResult: undefined, actions: [], failSend: false, failReview: false, failRefresh: false, valid: true };
  const records = new Map();
  journal ??= {
    entries: () => [...records.values()].map(entry => structuredClone(entry)),
    put: entry => records.set(`${entry.suggestion.id}:${entry.suggestion.version}`, structuredClone(entry)),
    close() {},
  };
  const api = {
    async list() { return { items: [structuredClone(state.current)] }; },
    async get() { return structuredClone(state.current); },
    async deliver(id, body, key) { state.deliveries.push({ id, body, key }); },
    async review(id, body, key) {
      state.reviews.push({ id, body, key });
      if (state.failReview) throw new Error('Connection lost after request');
      state.current = { ...state.current, status: body.action === 'approve' ? 'publishing' : 'rejected' };
      return structuredClone(state.current);
    },
  };
  const discord = {
    async send() { state.sends++; if (state.failSend) throw new Error('Ambiguous Discord timeout'); return { messageId: '123', channelId: '456' }; },
    async find() { return state.findResult; },
    async verify() { return state.valid; },
    async refresh(entry) { if (state.failRefresh) throw new Error('Discord edit failed'); state.refreshes.push(structuredClone(entry)); },
    async selectedActions() { return state.actions; },
  };
  const service = () => new SocialSuggestionsService(config, api, discord, journal, new AbortController(), () => {});
  return { state, journal, service, api };
}

const reaction = (overrides = {}) => ({ userId: reviewerId, userBot: false, isDm: true, messageId: '123', channelId: '456', emoji: '✅', ...overrides });

test('feature defaults off and reviewer defaults to configured owner; validates security configuration', () => {
  assert.equal(readSocialConfig({}), undefined);
  assert.equal(readSocialConfig({ SOCIAL_SUGGESTIONS_ENABLED: 'true', JOB_API_KEY_ID: 'discord', JOB_API_SECRET: 's'.repeat(32) }).reviewerId, reviewerId);
  assert.throws(() => readSocialConfig({ SOCIAL_SUGGESTIONS_ENABLED: 'true' }), /require/);
  assert.throws(() => readSocialConfig({ SOCIAL_SUGGESTIONS_ENABLED: 'true', JOB_API_KEY_ID: 'discord', JOB_API_SECRET: 's'.repeat(32), JOB_API_BASE_URL: 'http://public.example' }), /HTTPS/);
});

test('HMAC binds method, exact query, raw body and idempotency key', () => {
  const input = { keyId: 'discord', secret: 'test-secret', timestamp: '1801250000', nonce: 'test-nonce', method: 'post', url: 'https://jobs.egdata.app/v1/social/suggestions?limit=100', body: '{"version":1}', idempotencyKey: 'review-1' };
  const digest = createHash('sha256').update('{"version":1}').digest('hex');
  const expected = createHmac('sha256', 'test-secret').update(`egdata-job-api-v1\ndiscord\n1801250000\ntest-nonce\nPOST\n/v1/social/suggestions?limit=100\nreview-1\n${digest}`).digest('hex');
  assert.equal(signJobRequest(input), expected);
  for (const change of [{ url: 'https://jobs.egdata.app/v1/social/suggestions?limit=10' }, { body: '{ "version": 1 }' }, { idempotencyKey: 'review-2' }]) {
    assert.notEqual(signJobRequest({ ...input, ...change }), expected);
  }
});

test('network retries sign fresh nonces and preserve exact mutation idempotency and payload', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ suggestion: suggestion() }), { headers: { 'Content-Type': 'application/json' } });
  };
  const api = new SignedSuggestionsApi(config, new AbortController().signal, fetcher);
  const body = { version: 1, action: 'approve', actorId: reviewerId, discordMessageId: '123', discordChannelId: '456' };
  await api.review('a'.repeat(64), body, 'stable-key');
  await api.review('a'.repeat(64), body, 'stable-key');
  assert.notEqual(requests[0].options.headers['X-Api-Nonce'], requests[1].options.headers['X-Api-Nonce']);
  for (const { url, options } of requests) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Idempotency-Key'], 'stable-key');
    assert.equal(options.body, JSON.stringify(body));
    assert.equal(options.headers['X-Api-Signature'], signJobRequest({ ...config, timestamp: options.headers['X-Api-Timestamp'], nonce: options.headers['X-Api-Nonce'], method: 'POST', url, body: options.body, idempotencyKey: 'stable-key' }));
  }
});

test('delivery binds a single DM and approval waits for confirmed published status', async () => {
  const h = harness(); const service = h.service();
  await service.tick();
  await service.tick();
  assert.equal(h.state.sends, 1);
  assert.equal(h.state.deliveries.length, 1);
  assert.deepEqual(h.state.deliveries[0].body, { version: 1, recipientId: reviewerId, discordMessageId: '123', discordChannelId: '456' });
  await service.reaction(reaction());
  assert.equal(h.state.reviews.length, 1);
  assert.equal(h.state.refreshes.at(-1).suggestion.status, 'publishing');
  assert.match(suggestionMessage(h.state.refreshes.at(-1).suggestion).embeds[0].fields.at(-1).value, /waiting for confirmed publication/);
  await service.reaction(reaction({ emoji: '❌' }));
  assert.equal(h.state.reviews.length, 1);
  h.state.current = { ...h.state.current, status: 'published', tweetUrl: 'https://x.com/egdata/status/1' };
  await service.tick();
  assert.equal(h.state.refreshes.at(-1).suggestion.status, 'published');
  await service.stop();
});

test('untrusted, bot, guild and unrelated reactions never submit approval', async () => {
  const h = harness(); const service = h.service(); await service.tick();
  for (const change of [{ userId: '888888888888888888' }, { userBot: true }, { isDm: false }, { messageId: '999' }, { channelId: '999' }, { emoji: '👍' }]) await service.reaction(reaction(change));
  assert.equal(h.state.reviews.length, 0);
  h.state.valid = false;
  await service.reaction(reaction());
  assert.equal(h.state.reviews.length, 0);
  await service.stop();
});

test('stale, changed and expired drafts cannot be approved', async () => {
  for (const change of [{ version: 2 }, { text: 'Changed wording' }, { expiresAt: '2020-01-01T00:00:00Z' }, { status: 'rejected' }]) {
    const h = harness(); const service = h.service(); await service.tick();
    h.state.current = { ...h.state.current, ...change };
    await service.reaction(reaction());
    assert.equal(h.state.reviews.length, 0);
    await service.stop();
  }
});

test('ambiguous delivery is held across restarts and only recovered by finding the exact message', async () => {
  const h = harness(); h.state.failSend = true;
  const first = h.service(); await first.tick();
  assert.equal(h.state.sends, 1);
  assert.equal(h.journal.entries()[0].delivery, 'unknown');
  await first.stop();
  const restarted = h.service(); await restarted.tick();
  assert.equal(h.state.sends, 1);
  h.state.findResult = { messageId: '123', channelId: '456' };
  await restarted.tick();
  assert.equal(h.journal.entries()[0].delivery, 'acknowledged');
  assert.equal(h.state.sends, 1);
  await restarted.stop();
});

test('review intent survives restart with stable idempotency; second action cannot replace it', async () => {
  const h = harness(); const first = h.service(); await first.tick();
  h.state.failReview = true;
  await first.reaction(reaction());
  assert.equal(h.journal.entries()[0].action, 'approve');
  await first.stop();
  const restarted = h.service();
  await restarted.reaction(reaction({ emoji: '❌' }));
  h.state.failReview = false;
  await restarted.tick();
  assert.equal(h.state.reviews.length, 2);
  assert.equal(h.state.reviews[0].key, h.state.reviews[1].key);
  assert.deepEqual(h.state.reviews[0].body, h.state.reviews[1].body);
  assert.equal(h.journal.entries()[0].actionComplete, true);
  await restarted.stop();
});

test('known backend bindings recover without duplicate DM and offline reactions trigger reviews', async () => {
  const h = harness(suggestion({ discordMessageId: '123', discordChannelId: '456' }));
  h.state.actions = ['rewrite'];
  const service = h.service(); await service.tick();
  assert.equal(h.state.sends, 0);
  assert.equal(h.state.reviews[0].body.action, 'rewrite');
  assert.equal(h.state.refreshes.at(-1).suggestion.status, 'rejected');
  await service.stop();
});

test('conflicting offline reactions stay undecided', async () => {
  const h = harness(); h.state.actions = ['approve', 'reject'];
  const service = h.service(); await service.tick();
  assert.equal(h.state.reviews.length, 0);
  await service.stop();
});

test('crash after sending but before saving the binding does not automatically resend', async () => {
  const records = new Map();
  let failed = false;
  const journal = {
    entries: () => [...records.values()].map(entry => structuredClone(entry)),
    put(entry) {
      if (entry.delivery === 'sent' && !failed) { failed = true; throw new Error('Disk write failed after sending'); }
      records.set(`${entry.suggestion.id}:${entry.suggestion.version}`, structuredClone(entry));
    },
    close() {},
  };
  const h = harness(suggestion(), journal);
  const first = h.service(); await first.tick(); await first.stop();
  assert.equal(h.state.sends, 1);
  assert.equal(journal.entries()[0].delivery, 'unknown');
  const next = h.service(); await next.tick();
  assert.equal(h.state.sends, 1);
  await next.stop();
});

test('terminal status display failures retry without repeating publication', async () => {
  const h = harness(); const service = h.service(); await service.tick();
  await service.reaction(reaction());
  h.state.current = { ...h.state.current, status: 'published', tweetUrl: 'https://x.com/egdata/status/1' };
  h.state.failRefresh = true;
  await service.tick();
  assert.equal(h.state.refreshes.at(-1).suggestion.status, 'publishing');
  h.state.failRefresh = false;
  await service.tick();
  assert.equal(h.state.refreshes.at(-1).suggestion.status, 'published');
  assert.equal(h.state.reviews.length, 1);
  await service.stop();
});

test('mismatched backend Discord binding prevents review', async () => {
  const h = harness(); const service = h.service(); await service.tick();
  h.state.current = { ...h.state.current, discordMessageId: '999', discordChannelId: '456' };
  await service.reaction(reaction());
  assert.equal(h.state.reviews.length, 0);
  await service.tick();
  assert.equal(h.journal.entries()[0].conflict, true);
  await service.stop();
});

test('shutdown drains a started request without starting delivery work', async () => {
  const h = harness(); let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  h.api.list = async () => { await paused; return { items: [h.state.current] }; };
  const service = h.service();
  const tick = service.tick();
  await Promise.resolve();
  const stopping = service.stop();
  resume();
  await Promise.all([tick, stopping]);
  assert.equal(h.state.sends, 0);
  assert.equal(h.state.reviews.length, 0);
});

test('journal restores fsynced delivery and review intent, rejects concurrent writers and torn records', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egdata-social-'));
  const file = path.join(directory, 'suggestions.jsonl');
  try {
    const journal = new FileSuggestionsJournal(file);
    const entry = { suggestion: suggestion(), delivery: 'sent', messageId: '123', channelId: '456', action: 'approve', actionComplete: false };
    journal.put(entry);
    assert.throws(() => new FileSuggestionsJournal(file), /EEXIST/);
    journal.close();
    const restored = new FileSuggestionsJournal(file);
    assert.deepEqual(restored.entries(), [entry]);
    restored.close();
    writeFileSync(file, readFileSync(file, 'utf8') + '{');
    assert.throws(() => new FileSuggestionsJournal(file), /incomplete record/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('review messages retain exact draft, suppress mentions, show clickable evidence and stay within embed limits', () => {
  const s = suggestion({ evidence: [{ id: 'official', kind: 'web', label: 'Official [source] @everyone', url: 'https://store.epicgames.com/p/end-of-abyss', observedAt: '2026-09-30T12:00:00Z' }] });
  const message = suggestionMessage(s);
  assert.equal(message.embeds[0].description, s.text);
  assert.deepEqual(message.allowedMentions.parse, []);
  assert.match(message.embeds[0].fields[1].value, /https:\/\/store.epicgames.com/);
  const large = suggestionMessage(suggestion({ text: 't'.repeat(4096), rationale: 'r'.repeat(1000), evidence: Array.from({ length: 20 }, () => ({ id: 'i'.repeat(100), kind: 'web', label: 'l'.repeat(250), url: 'https://example.com/' + 'u'.repeat(900), observedAt: '2026-09-30T12:00:00Z' })) }));
  const embed = large.embeds[0];
  const length = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(length <= 6000, `Embed length ${length}`);
  assert.ok(embed.fields.length <= 25);
  assert.match(embed.fields.find(field => field.name === 'Additional sources').value, /omitted/);
});

test('backend contract with three DB facts and ten research sources fits Discord limits', () => {
  const observedAt = '2026-09-30T12:00:00.000Z';
  const evidence = [
    ...Array.from({ length: 3 }, (_, index) => ({ id: `db-${index}`, kind: 'database', label: 'Verified store fact.', url: 'https://egdata.app/offers/abc', observedAt })),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `resp_123:source:${index}`, kind: 'web', label: 'Research source ' + 'x'.repeat(160), url: 'https://example.com/' + 'x'.repeat(100), observedAt })),
  ];
  const backend = suggestion({ evidence, updatedAt: observedAt });
  assertSuggestion(backend);
  const embed = suggestionMessage(backend).embeds[0];
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
  const length = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(length <= 6000);
  assert.equal(embed.fields.filter(field => field.name.startsWith('Database observation')).length, 3);
  assert.equal(embed.fields.filter(field => field.name.startsWith('Web source')).length, 10);
});

test('valid long backend source URLs do not prevent delivery and their omission is visible', () => {
  const backend = suggestion({ evidence: [{ id: 'long-url', kind: 'web', label: 'Long official URL', url: 'https://example.com/' + 'q'.repeat(2000), observedAt: '2026-09-30T12:00:00.000Z' }] });
  assertSuggestion(backend);
  assert.match(suggestionMessage(backend).embeds[0].fields.find(field => field.name === 'Additional sources').value, /1 source/);
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'javascript:alert(1)']) {
    assert.throws(() => assertSuggestion(suggestion({ evidence: [{ ...backend.evidence[0], url }] })), /Invalid social suggestion/);
  }
});
