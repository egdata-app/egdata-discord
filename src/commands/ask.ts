import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { BaseCommand } from '../types/BaseCommand.js';

export const AI_WORKER_URL = process.env['AI_WORKER_URL'] || 'http://localhost:8787';

// Track session versions per user (resets on bot restart, which is fine)
export const userSessionVersions = new Map<string, number>();

// Track thread ID to session ID mappings for thread-based chat
export const threadSessions = new Map<string, string>();

// Store AI-generated thread titles per session
export const sessionThreadTitles = new Map<string, string>();

// Parse and extract thread title from AI response
export function extractThreadTitle(content: string): { title: string | null; cleanContent: string } {
  const match = content.match(/<thread-title>(.+?)<\/thread-title>/s);
  if (match?.[1]) {
    const title = match[1].trim();
    const cleanContent = content.replace(/<thread-title>.+?<\/thread-title>/s, '').trim();
    return { title, cleanContent };
  }
  return { title: null, cleanContent: content };
}

// Progress event types from the worker
interface ProgressEvent {
  type: 'tool';
  tool: string;
  message: string;
}

interface CompleteEvent {
  type: 'complete';
  text: string;
}

interface ErrorEvent {
  type: 'error';
  message: string;
}

interface ConfirmationEvent {
  type: 'confirmation_required';
  message: string;
  data: {
    country?: string;
    language?: string;
    fact?: string;
  };
}

export type SSEEvent = ProgressEvent | CompleteEvent | ErrorEvent | ConfirmationEvent;

// Track pending confirmations per session
export const pendingConfirmations = new Map<string, ConfirmationEvent>();

export class AskCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask EGData AI about Epic Games Store games, prices, deals, and more.')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('Your question about Epic Games Store')
        .setRequired(true)
    );

  override async execute(interaction: CommandInteraction): Promise<void> {
    const question = interaction.options.get('question')?.value?.toString();

    if (!question) {
      await interaction.reply({
        content: 'Please provide a question.',
        ephemeral: true,
      });
      return;
    }

    // Use user ID + version as session ID for conversation continuity
    const userId = interaction.user.id;
    const version = userSessionVersions.get(userId) || 0;
    const sessionId = `discord-${userId}-v${version}`;

    this.logger.info(`AI question from ${interaction.user.tag}: ${question}`);

    // Defer reply since AI can take a while
    await interaction.deferReply();

    try {
      // Use streaming endpoint for progress updates
      const response = await fetch(`${AI_WORKER_URL}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: question,
          sessionId,
          country: 'US',
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentProgress = 'Thinking...';
      let lastUpdateTime = 0;
      let pendingConfirmation: ConfirmationEvent | undefined;
      const UPDATE_INTERVAL = 1000; // Update at most every 1 second

      // Show initial thinking state
      await this.updateProgress(interaction, currentProgress);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as SSEEvent;
              this.logger.info('AI event:', event);

              if (event.type === 'tool') {
                currentProgress = event.message;
                const now = Date.now();
                // Throttle updates to avoid rate limiting
                if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                  await this.updateProgress(interaction, currentProgress);
                  lastUpdateTime = now;
                }
              } else if (event.type === 'confirmation_required') {
                // Store the confirmation for later
                pendingConfirmation = event;
                pendingConfirmations.set(sessionId, event);
              } else if (event.type === 'complete') {
                if (event.text.trim()) {
                  // Extract and store thread title, display clean content
                  const { title, cleanContent } = extractThreadTitle(event.text);
                  if (title) {
                    sessionThreadTitles.set(sessionId, title);
                  }
                  await this.updateResponse(interaction, cleanContent, sessionId, pendingConfirmation);
                } else {
                  await interaction.editReply({
                    content: 'I couldn\'t generate a response. Please try again.',
                  });
                }
                return;
              } else if (event.type === 'error') {
                await interaction.editReply({
                  content: `AI Error: ${event.message}`,
                });
                return;
              }
            } catch {
              // Ignore parse errors for incomplete JSON
            }
          }
        }
      }

      // If we get here without a complete event, something went wrong
      await interaction.editReply({
        content: 'Response ended unexpectedly. Please try again.',
      });
    } catch (error) {
      this.logger.error('AI chat error:', error);
      await interaction.editReply({
        content: `Failed to get AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  private async updateProgress(
    interaction: CommandInteraction,
    status: string
  ): Promise<void> {
    // Use plain text for progress updates (less intrusive than embeds)
    await interaction.editReply({
      content: `⏳ ${status}`,
      embeds: []
    }).catch(() => {
      // Ignore errors from rate limiting
    });
  }

  private async updateResponse(
    interaction: CommandInteraction,
    content: string,
    sessionId: string,
    confirmation?: ConfirmationEvent
  ): Promise<void> {
    // Discord embed description limit is 4096 characters
    const MAX_LENGTH = 4000;

    let displayContent = content;
    if (content.length > MAX_LENGTH) {
      displayContent = content.slice(0, MAX_LENGTH) + '...';
    }

    const embed = new EmbedBuilder()
      .setDescription(displayContent)
      .setColor(0x00ff00)
      .setFooter({
        text: 'EGData AI',
        iconURL: 'https://egdata.app/logo_simple_white.png',
      })
      .setTimestamp();

    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    // Add button to continue conversation in a thread
    const threadRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`create_thread:${sessionId}`)
        .setLabel('💬 Continue in Thread')
        .setStyle(ButtonStyle.Secondary)
    );
    components.push(threadRow);

    // Clear the progress text and show the embed with buttons
    await interaction.editReply({ content: '', embeds: [embed], components });

    // If there's a pending confirmation, send it as an ephemeral follow-up
    // so only the user who asked can see and interact with it
    if (confirmation) {
      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_save:${sessionId}`)
          .setLabel('✅ Yes, remember this')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_save:${sessionId}`)
          .setLabel('❌ No thanks')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.followUp({
        content: `💾 **Remember this?**\n${confirmation.message}`,
        components: [confirmRow],
        ephemeral: true,
      });
    }
  }
}

export default new AskCommand();
