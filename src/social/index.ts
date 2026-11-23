import type { Client } from 'discord.js';
import { SignedSuggestionsApi } from './api.js';
import { readSocialConfig } from './config.js';
import { DiscordSuggestionsAdapter } from './discord.js';
import { FileSuggestionsJournal, type JournalEntry, type SuggestionsJournal } from './journal.js';
import { SocialSuggestionsService } from './service.js';

class DeferredSuggestionsJournal implements SuggestionsJournal {
  private inner?: FileSuggestionsJournal;

  constructor(private readonly filePath: string) {}

  private acquire(): FileSuggestionsJournal {
    if (!this.inner) {
      this.inner = new FileSuggestionsJournal(this.filePath);
    }
    return this.inner;
  }

  entries(): JournalEntry[] {
    return this.acquire().entries();
  }

  put(entry: JournalEntry): void {
    this.acquire().put(entry);
  }

  close(): void {
    this.inner?.close();
  }
}

export function createSocialSuggestions(client: Client, log: (message: string, error?: unknown) => void): SocialSuggestionsService | undefined {
  const config = readSocialConfig();
  if (!config) return undefined;
  const abort = new AbortController();
  const journal = new DeferredSuggestionsJournal(config.journalPath);
  return new SocialSuggestionsService(config, new SignedSuggestionsApi(config, abort.signal),
    new DiscordSuggestionsAdapter(client, config.reviewerId, abort.signal), journal, abort, log);
}
