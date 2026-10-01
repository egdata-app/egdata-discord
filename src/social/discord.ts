import { createHash } from 'node:crypto';
import { ChannelType, escapeMarkdown, type Client, type Message, type MessageCreateOptions } from 'discord.js';
import type { JournalEntry } from './journal.js';
import type { DiscordSuggestions } from './service.js';
import { REVIEW_REACTIONS, suggestionKey, type ReviewAction, type SocialSuggestion } from './types.js';

function marker(suggestion: SocialSuggestion): string { return `EGDATA suggestion ${suggestionKey(suggestion)}`; }

export function suggestionMessage(suggestion: SocialSuggestion, entry?: JournalEntry): MessageCreateOptions {
  const status = suggestion.status;
  let detail: string = status;
  if (entry?.conflict) detail = 'Held for manual reconciliation; no further approval will be submitted from this message.';
  else if (entry?.action && !entry.actionComplete) detail = `${entry.action} queued; waiting for the API. Publication is not confirmed.`;
  else if (status === 'published') detail = suggestion.tweetUrl ? `Published: ${suggestion.tweetUrl}` : 'Published (link unavailable).';
  else if (status === 'approved' || status === 'publishing') detail = 'Publishing; waiting for confirmed publication.';
  else if (status === 'publication_unknown') detail = 'Publication outcome unknown; backend reconciliation required.';
  else if (status === 'failed') detail = `Publication failed${suggestion.error ? `: ${escapeMarkdown(suggestion.error).slice(0, 300)}` : '.'}`;
  else if (status === 'pending') detail = '✅ Publish · ❌ Dismiss · 🔄 Suggest different wording';
  const fields = [{ name: 'Why this matters', value: escapeMarkdown(suggestion.rationale || 'No rationale provided.').slice(0, 1000) }];
  const tail = [{ name: 'Expires', value: suggestion.expiresAt }, { name: 'Status', value: detail.slice(0, 300) }];
  const title = `Tweet suggestion · version ${suggestion.version}`;
  const footer = marker(suggestion);
  // Evidence is presented as individual escaped links; only HTTPS URLs are accepted by the API client.
  let evidenceBudget = Math.max(0, 5900 - suggestion.text.length - title.length - footer.length
    - [...fields, ...tail].reduce((sum, field) => sum + field.name.length + field.value.length, 0));
  let omittedSources = 0;
  for (const evidence of suggestion.evidence) {
    const label = escapeMarkdown(evidence.label);
    const source = evidence.url ? `[${label}](${evidence.url.replaceAll(')', '%29').replaceAll('(', '%28')})` : label;
    const value = `${source}\nObserved: ${evidence.observedAt}`;
    const name = `${evidence.kind === 'web' ? 'Web source' : 'Database observation'} · ${escapeMarkdown(evidence.id).slice(0, 100)}`;
    // Reserve the two tail fields and an optional omitted-source notice within Discord's 25-field limit.
    if (fields.length >= 22 || name.length + value.length > evidenceBudget || value.length > 1024) {
      omittedSources++;
      continue;
    }
    fields.push({ name, value });
    evidenceBudget -= name.length + value.length;
  }
  if (omittedSources) fields.push({ name: 'Additional sources', value: `${omittedSources} source(s) omitted from this card due to Discord display limits.` });
  fields.push(...tail);
  return {
    allowedMentions: { parse: [], repliedUser: false },
    embeds: [{ title, description: suggestion.text,
      fields, footer: { text: footer }, color: status === 'published' ? 0x57f287 : 0x5865f2 }],
  };
}

export class DiscordSuggestionsAdapter implements DiscordSuggestions {
  constructor(private readonly client: Client, private readonly reviewerId: string, private readonly signal?: AbortSignal) {}

  private assertActive(): void { this.signal?.throwIfAborted(); }

  private matches(message: Message, suggestion: SocialSuggestion): boolean {
    return message.author.id === this.client.user?.id && message.channel.type === ChannelType.DM
      && message.embeds.length === 1 && message.embeds[0]?.footer?.text === marker(suggestion)
      && message.embeds[0]?.description === suggestion.text;
  }

  async send(suggestion: SocialSuggestion): Promise<{ messageId: string; channelId: string }> {
    this.assertActive();
    const user = await this.client.users.fetch(this.reviewerId);
    this.assertActive();
    const nonce = createHash('sha256').update(suggestionKey(suggestion)).digest('hex').slice(0, 24);
    const message = await user.send({ ...suggestionMessage(suggestion), nonce, enforceNonce: true });
    // Reactions are added during reconciliation, after the message binding is durable.
    return { messageId: message.id, channelId: message.channelId };
  }

  async find(suggestion: SocialSuggestion): Promise<{ messageId: string; channelId: string } | undefined> {
    this.assertActive();
    const user = await this.client.users.fetch(this.reviewerId);
    this.assertActive();
    const channel = await user.createDM();
    this.assertActive();
    const messages = await channel.messages.fetch({ limit: 100 });
    const matches = [...messages.values()].filter(message => this.matches(message, suggestion));
    if (matches.length !== 1 || !matches[0]) return undefined;
    return { messageId: matches[0].id, channelId: matches[0].channelId };
  }

  private async message(entry: JournalEntry): Promise<Message | undefined> {
    if (!entry.channelId || !entry.messageId) return undefined;
    this.assertActive();
    const user = await this.client.users.fetch(this.reviewerId);
    this.assertActive();
    const dm = await user.createDM();
    if (dm.id !== entry.channelId) return undefined;
    this.assertActive();
    return dm.messages.fetch(entry.messageId);
  }

  async verify(entry: JournalEntry): Promise<boolean> {
    const message = await this.message(entry);
    return Boolean(message && this.matches(message, entry.suggestion));
  }

  async refresh(entry: JournalEntry): Promise<void> {
    const message = await this.message(entry);
    if (!message || !this.matches(message, entry.suggestion)) throw new Error('Suggestion DM mismatch');
    const rendered = suggestionMessage(entry.suggestion, entry);
    const next = rendered.embeds?.[0] as { title: string; description: string; color: number; fields: Array<{ name: string; value: string }>; footer: { text: string } };
    const current = message.embeds[0];
    const comparable = (embed: typeof next) => JSON.stringify([embed.title, embed.description, embed.color,
      embed.footer?.text, embed.fields.map(field => [field.name, field.value])]);
    if (!current || comparable({ title: current.title || '', description: current.description || '', color: current.color || 0,
      footer: { text: current.footer?.text || '' }, fields: current.fields }) !== comparable(next)) {
      this.assertActive();
      await message.edit({ embeds: rendered.embeds, allowedMentions: { parse: [], repliedUser: false } });
    }
    if (entry.suggestion.status === 'pending' && !entry.action && !entry.conflict && Date.parse(entry.suggestion.expiresAt) > Date.now()) {
      for (const emoji of Object.keys(REVIEW_REACTIONS)) {
        this.assertActive();
        if (!message.reactions.cache.find(reaction => reaction.emoji.name === emoji && reaction.me)) await message.react(emoji);
      }
    }
  }

  async selectedActions(entry: JournalEntry): Promise<ReviewAction[]> {
    const message = await this.message(entry);
    if (!message || !this.matches(message, entry.suggestion)) return [];
    const actions: ReviewAction[] = [];
    for (const [emoji, action] of Object.entries(REVIEW_REACTIONS)) {
      const reaction = message.reactions.cache.find(item => item.emoji.name === emoji);
      if (!reaction) continue;
      // Only one human reviewer can access this DM. Fetch users to recover offline reactions.
      this.assertActive();
      const users = await reaction.users.fetch({ limit: 100 });
      if (users.has(this.reviewerId)) actions.push(action);
    }
    return actions;
  }
}
