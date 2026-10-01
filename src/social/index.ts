import type { Client } from 'discord.js';
import { SignedSuggestionsApi } from './api.js';
import { readSocialConfig } from './config.js';
import { DiscordSuggestionsAdapter } from './discord.js';
import { FileSuggestionsJournal } from './journal.js';
import { SocialSuggestionsService } from './service.js';

export function createSocialSuggestions(client: Client, log: (message: string, error?: unknown) => void): SocialSuggestionsService | undefined {
  const config = readSocialConfig();
  if (!config) return undefined;
  const abort = new AbortController();
  const journal = new FileSuggestionsJournal(config.journalPath);
  return new SocialSuggestionsService(config, new SignedSuggestionsApi(config, abort.signal),
    new DiscordSuggestionsAdapter(client, config.reviewerId, abort.signal), journal, abort, log);
}
