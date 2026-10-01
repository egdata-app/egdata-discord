import { createHash } from 'node:crypto';
import { JobApiError } from './api.js';
import type { SocialConfig } from './config.js';
import type { JournalEntry, SuggestionsJournal } from './journal.js';
import { REVIEW_REACTIONS, suggestionKey, type ReviewAction, type SocialSuggestion, type SuggestionsApi } from './types.js';

export interface DiscordSuggestions {
  send(suggestion: SocialSuggestion): Promise<{ messageId: string; channelId: string }>;
  find(suggestion: SocialSuggestion): Promise<{ messageId: string; channelId: string } | undefined>;
  verify(entry: JournalEntry): Promise<boolean>;
  refresh(entry: JournalEntry): Promise<void>;
  selectedActions(entry: JournalEntry): Promise<ReviewAction[]>;
}

export interface SuggestionReaction {
  userId: string;
  userBot: boolean;
  isDm: boolean;
  messageId: string;
  channelId: string;
  emoji: string;
}

function mutationKey(entry: JournalEntry, operation: string): string {
  const digest = createHash('sha256').update(`${suggestionKey(entry.suggestion)}:${entry.channelId}:${entry.messageId}:${operation}`).digest('hex');
  return `social-${operation}-${digest}`;
}

function displayState(entry: JournalEntry): string {
  return JSON.stringify([entry.suggestion.status, entry.suggestion.tweetUrl, entry.suggestion.error,
    entry.action, entry.actionComplete, entry.conflict]);
}

export class SocialSuggestionsService {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private cursor?: string;
  private monitorOffset = 0;

  constructor(
    private readonly config: SocialConfig,
    private readonly api: SuggestionsApi,
    private readonly discord: DiscordSuggestions,
    private readonly journal: SuggestionsJournal,
    private readonly abort: AbortController,
    private readonly log: (message: string, error?: unknown) => void,
  ) {}

  private serialize(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(async () => { if (!this.stopped) await operation(); });
    this.queue = task.catch(error => { this.log('Social suggestions operation failed', error); });
    return this.queue;
  }

  start(): void {
    void this.tick().finally(() => this.schedule());
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().finally(() => this.schedule()); }, this.config.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    await this.queue;
    this.journal.close();
  }

  tick(): Promise<void> {
    return this.serialize(async () => {
      const page = await this.api.list(this.cursor);
      this.cursor = page.nextCursor;
      for (const suggestion of page.items) {
        if (this.stopped) return;
        if (suggestion.recipientId !== this.config.reviewerId || suggestion.status !== 'pending') continue;
        try { await this.ensureDelivered(suggestion); }
        catch (error) { this.log(`Social delivery paused for ${suggestionKey(suggestion)}`, error); }
      }
      // Monitor a bounded rotating batch, including older messages after restarts.
      const monitored = this.journal.entries().filter(entry => entry.displayedState !== displayState(entry) || (!entry.conflict &&
        (entry.delivery !== 'acknowledged' || (entry.action && !entry.actionComplete) ||
          ['pending', 'approved', 'publishing', 'publication_unknown'].includes(entry.suggestion.status))));
      const batch = [...monitored.slice(this.monitorOffset), ...monitored.slice(0, this.monitorOffset)].slice(0, 25);
      this.monitorOffset = monitored.length ? (this.monitorOffset + batch.length) % monitored.length : 0;
      for (const entry of batch) {
        if (this.stopped) return;
        try { await this.reconcile(entry); }
        catch (error) { this.log(`Social reconciliation paused for ${suggestionKey(entry.suggestion)}`, error); }
      }
    });
  }

  private async ensureDelivered(suggestion: SocialSuggestion): Promise<void> {
    if (Date.parse(suggestion.expiresAt) <= Date.now()) return;
    const existing = this.journal.entries().find(entry => suggestionKey(entry.suggestion) === suggestionKey(suggestion));
    if (existing) return;
    const entry: JournalEntry = { suggestion, delivery: 'unknown' };
    if (suggestion.discordMessageId && suggestion.discordChannelId) {
      entry.messageId = suggestion.discordMessageId;
      entry.channelId = suggestion.discordChannelId;
      entry.delivery = 'acknowledged';
      this.journal.put(entry);
      return;
    }
    // This intent is durable BEFORE sending. A crash/timeout must never trigger an automatic resend.
    this.journal.put(entry);
    if (this.stopped) return;
    const sent = await this.discord.send(suggestion);
    this.journal.put({ ...entry, ...sent, delivery: 'sent' });
  }

  private async acknowledge(entry: JournalEntry): Promise<JournalEntry> {
    if (!entry.messageId || !entry.channelId || this.stopped) return entry;
    if (entry.delivery === 'sent') {
      await this.api.deliver(entry.suggestion.id, {
        version: entry.suggestion.version, recipientId: this.config.reviewerId,
        discordMessageId: entry.messageId, discordChannelId: entry.channelId,
      }, mutationKey(entry, 'delivery'));
      entry = { ...entry, delivery: 'acknowledged' };
      this.journal.put(entry);
    }
    return entry;
  }

  private async reconcile(entry: JournalEntry): Promise<void> {
    if (entry.conflict) {
      await this.refresh(entry);
      return;
    }
    const current = await this.api.get(entry.suggestion.id);
    if (this.stopped) return;
    if (current.version !== entry.suggestion.version || current.text !== entry.suggestion.text
      || current.recipientId !== this.config.reviewerId
      || (entry.messageId && current.discordMessageId && entry.messageId !== current.discordMessageId)
      || (entry.channelId && current.discordChannelId && entry.channelId !== current.discordChannelId)) {
      entry = { ...entry, conflict: true };
      this.journal.put(entry);
      this.log(`Social draft changed unexpectedly; held ${suggestionKey(entry.suggestion)}`);
      await this.refresh(entry);
      return;
    }
    entry = { ...entry, suggestion: current };
    this.journal.put(entry);
    if (entry.delivery === 'unknown') {
      const found = current.discordMessageId && current.discordChannelId
        ? { messageId: current.discordMessageId, channelId: current.discordChannelId }
        : await this.discord.find(current);
      if (!found) {
        this.log(`Social DM delivery unknown; held ${suggestionKey(current)} for manual reconciliation`);
        return;
      }
      if (this.stopped) return;
      entry = { ...entry, ...found, delivery: current.discordMessageId ? 'acknowledged' : 'sent' };
      this.journal.put(entry);
    }
    if (!await this.discord.verify(entry)) {
      this.journal.put({ ...entry, conflict: true });
      this.log(`Social DM does not match stored draft; held ${suggestionKey(current)}`);
      return;
    }
    if (this.stopped) return;
    entry = await this.acknowledge(entry);
    if (entry.action && !entry.actionComplete) entry = await this.submitReview(entry);
    await this.refresh(entry);
    if (!entry.action && current.status === 'pending' && Date.parse(current.expiresAt) > Date.now()) {
      const actions = await this.discord.selectedActions(entry);
      if (actions.length === 1 && actions[0]) await this.choose(entry, actions[0]);
      else if (actions.length > 1) this.log(`Conflicting offline reactions on ${suggestionKey(current)}; remove all but one to select`);
    }
  }

  reaction(event: SuggestionReaction): Promise<void> {
    if (event.userBot || event.userId !== this.config.reviewerId || !event.isDm) return Promise.resolve();
    const action = REVIEW_REACTIONS[event.emoji as keyof typeof REVIEW_REACTIONS];
    if (!action) return Promise.resolve();
    return this.serialize(async () => {
      const entry = this.journal.entries().find(e => e.messageId === event.messageId && e.channelId === event.channelId);
      if (!entry || entry.action || entry.conflict) return;
      const current = await this.api.get(entry.suggestion.id);
      if (this.stopped) return;
      if (current.version !== entry.suggestion.version || current.text !== entry.suggestion.text
        || current.recipientId !== this.config.reviewerId || current.status !== 'pending'
        || (current.discordMessageId && current.discordMessageId !== event.messageId)
        || (current.discordChannelId && current.discordChannelId !== event.channelId)
        || Date.parse(current.expiresAt) <= Date.now()) return;
      if (!await this.discord.verify(entry)) return;
      await this.choose({ ...entry, suggestion: current }, action);
    });
  }

  private async choose(entry: JournalEntry, action: ReviewAction): Promise<void> {
    if (this.stopped) return;
    entry = { ...entry, action, actionComplete: false };
    // Capture the first selected action durably; future reactions cannot change it during a retry.
    this.journal.put(entry);
    entry = await this.acknowledge(entry);
    entry = await this.submitReview(entry);
    await this.refresh(entry);
  }

  private async refresh(entry: JournalEntry): Promise<void> {
    if (this.stopped || !entry.messageId || !entry.channelId) return;
    await this.discord.refresh(entry);
    this.journal.put({ ...entry, displayedState: displayState(entry) });
  }

  private async submitReview(entry: JournalEntry): Promise<JournalEntry> {
    if (!entry.action || !entry.messageId || !entry.channelId || this.stopped) return entry;
    try {
      const suggestion = await this.api.review(entry.suggestion.id, {
        version: entry.suggestion.version, action: entry.action, actorId: this.config.reviewerId,
        discordMessageId: entry.messageId, discordChannelId: entry.channelId,
      }, mutationKey(entry, `review-${entry.action}`));
      entry = { ...entry, suggestion, actionComplete: true };
    } catch (error) {
      if (error instanceof JobApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        entry = { ...entry, actionComplete: true, conflict: true };
        this.log(`Social review refused; held ${suggestionKey(entry.suggestion)}`, error);
      } else throw error;
    }
    this.journal.put(entry);
    return entry;
  }
}
