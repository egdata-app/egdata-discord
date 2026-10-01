import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { assertSuggestion, suggestionKey, type ReviewAction, type SocialSuggestion } from './types.js';

export interface JournalEntry {
  suggestion: SocialSuggestion;
  delivery: 'unknown' | 'sent' | 'acknowledged';
  messageId?: string;
  channelId?: string;
  action?: ReviewAction;
  actionComplete?: boolean;
  conflict?: boolean;
  displayedState?: string;
}

export interface SuggestionsJournal {
  entries(): JournalEntry[];
  put(entry: JournalEntry): void;
  close(): void;
}

/** One writer, synchronous fsync before side effects. An incomplete record fails closed. */
export class FileSuggestionsJournal implements SuggestionsJournal {
  private readonly records = new Map<string, JournalEntry>();
  private readonly fd: number;
  private readonly lockPath: string;
  private closed = false;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.lockPath = `${filePath}.lock`;
    const lockFd = openSync(this.lockPath, 'wx', 0o600);
    writeSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fsyncSync(lockFd);
    closeSync(lockFd);
    try {
      if (existsSync(filePath)) {
        const contents = readFileSync(filePath, 'utf8');
        if (contents && !contents.endsWith('\n')) throw new Error('Social journal has an incomplete record; recover it before starting');
        for (const line of contents.split('\n').filter(Boolean)) {
          const entry = JSON.parse(line) as JournalEntry;
          assertSuggestion(entry.suggestion);
          if (!['unknown', 'sent', 'acknowledged'].includes(entry.delivery)
            || (entry.delivery !== 'unknown' && (!entry.messageId || !entry.channelId))
            || (entry.action && !['approve', 'reject', 'rewrite'].includes(entry.action))) throw new Error('Invalid social journal record');
          this.records.set(suggestionKey(entry.suggestion), entry);
        }
      }
      this.fd = openSync(filePath, 'a', 0o600);
    } catch (error) {
      unlinkSync(this.lockPath);
      throw error;
    }
  }

  entries(): JournalEntry[] { return [...this.records.values()].map(entry => structuredClone(entry)); }

  put(entry: JournalEntry): void {
    if (this.closed) throw new Error('Social journal is closed');
    const line = Buffer.from(`${JSON.stringify(entry)}\n`);
    let offset = 0;
    while (offset < line.length) offset += writeSync(this.fd, line, offset, line.length - offset);
    fsyncSync(this.fd);
    this.records.set(suggestionKey(entry.suggestion), structuredClone(entry));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    unlinkSync(this.lockPath);
  }
}
