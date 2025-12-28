import {
  SlashCommandBuilder,
  type CommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { BaseCommand } from '../types/BaseCommand.js';
import {
  AIWebSocketClient,
  type AskUserMessage,
  type CompleteMessage,
  type ToolProgressMessage,
  type ErrorMessage,
} from '../utils/ai-websocket.js';

export const AI_WORKER_URL = process.env['AI_WORKER_URL'] || 'http://localhost:8787';

// Track thread ID to session ID mappings for thread-based chat
export const threadSessions = new Map<string, string>();

// Generate a unique session ID for each /ask command
function generateSessionId(userId: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `discord-${userId}-${timestamp}-${random}`;
}

// Store AI-generated thread titles per session
export const sessionThreadTitles = new Map<string, string>();

// Store pending ask_user requests per session (for button interactions)
export const pendingAskUserRequests = new Map<
  string,
  {
    requestId: string;
    question: string;
    options: string[];
    wsClient: AIWebSocketClient;
    resolve: () => void;
  }
>();

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

    const sessionId = generateSessionId(interaction.user.id);

    this.logger.info(`AI question from ${interaction.user.tag}: ${question}`);

    await interaction.deferReply();

    try {
      // Create WebSocket connection
      const wsClient = new AIWebSocketClient(AI_WORKER_URL, sessionId);

      let currentProgress = 'Thinking...';
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 1000;
      let fullText = '';
      let completed = false;
      let error: string | null = null;

      // Set up event handlers
      wsClient.on('tool_progress', (msg: ToolProgressMessage) => {
        currentProgress = msg.message;
        const now = Date.now();
        if (now - lastUpdateTime >= UPDATE_INTERVAL) {
          this.updateProgress(interaction, currentProgress).catch(() => {});
          lastUpdateTime = now;
        }
      });

      wsClient.on('ask_user', async (msg: AskUserMessage) => {
        // Store the pending request for button handling
        await this.handleAskUser(interaction, sessionId, msg, wsClient);
      });

      wsClient.on('text_delta', () => {
        // We could show typing indicator here, but we wait for complete
      });

      wsClient.on('complete', (msg: CompleteMessage) => {
        fullText = msg.text;
        completed = true;
      });

      wsClient.on('error', (msg: ErrorMessage) => {
        error = msg.message;
        completed = true;
      });

      // Connect and send message
      await wsClient.connect();
      wsClient.sendChat(question);

      // Show initial progress
      await this.updateProgress(interaction, currentProgress);

      // Wait for completion (with timeout)
      const timeout = 120000; // 2 minutes
      const startTime = Date.now();

      await new Promise<void>((resolve) => {
        const checkComplete = () => {
          if (completed || Date.now() - startTime > timeout) {
            resolve();
          } else {
            setTimeout(checkComplete, 100);
          }
        };
        checkComplete();
      });

      // Clean up
      wsClient.disconnect();

      if (error) {
        await interaction.editReply({
          content: `AI Error: ${error}`,
        });
        return;
      }

      if (!fullText.trim()) {
        await interaction.editReply({
          content: "I couldn't generate a response. Please try again.",
        });
        return;
      }

      // Extract and store thread title
      const { title, cleanContent } = extractThreadTitle(fullText);
      if (title) {
        sessionThreadTitles.set(sessionId, title);
      }

      await this.updateResponse(interaction, cleanContent, sessionId);
    } catch (err) {
      this.logger.error('AI chat error:', err);
      await interaction.editReply({
        content: `Failed to get AI response: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    }
  }

  private async updateProgress(interaction: CommandInteraction, status: string): Promise<void> {
    await interaction
      .editReply({
        content: `\`💭 ${status}\``,
        embeds: [],
      })
      .catch(() => {});
  }

  private async handleAskUser(
    interaction: CommandInteraction,
    sessionId: string,
    msg: AskUserMessage,
    wsClient: AIWebSocketClient
  ): Promise<void> {
    // Create buttons for the options
    const buttons = msg.options?.slice(0, 5).map((option, index) =>
      new ButtonBuilder()
        .setCustomId(`ask_user_response:${sessionId}:${msg.requestId}:${index}`)
        .setLabel(option.length > 80 ? option.slice(0, 77) + '...' : option)
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ) || [
      new ButtonBuilder()
        .setCustomId(`ask_user_response:${sessionId}:${msg.requestId}:0`)
        .setLabel('Yes')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ask_user_response:${sessionId}:${msg.requestId}:1`)
        .setLabel('No')
        .setStyle(ButtonStyle.Danger),
    ];

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    // Store pending request for button handler
    const pendingPromise = new Promise<void>((resolve) => {
      pendingAskUserRequests.set(`${sessionId}:${msg.requestId}`, {
        requestId: msg.requestId,
        question: msg.question,
        options: msg.options || ['Yes', 'No'],
        wsClient,
        resolve,
      });

      // Auto-timeout after 60 seconds
      setTimeout(() => {
        if (pendingAskUserRequests.has(`${sessionId}:${msg.requestId}`)) {
          pendingAskUserRequests.delete(`${sessionId}:${msg.requestId}`);
          resolve();
        }
      }, 60000);
    });

    // Show the question with buttons
    await interaction.editReply({
      content: `❓ **${msg.question}**`,
      components: [row],
    });

    // Wait for user response
    await pendingPromise;
  }

  private async updateResponse(
    interaction: CommandInteraction,
    content: string,
    sessionId: string
  ): Promise<void> {
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

    const threadRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`create_thread:${sessionId}`)
        .setLabel('💬 Continue in Thread')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: '',
      embeds: [embed],
      components: [threadRow],
    });
  }
}

export default new AskCommand();
