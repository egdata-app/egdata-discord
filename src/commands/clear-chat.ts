import { SlashCommandBuilder, type CommandInteraction } from 'discord.js';
import { BaseCommand } from '../types/BaseCommand.js';
import { userSessionVersions } from './ask.js';

const AI_WORKER_URL = process.env['AI_WORKER_URL'] || 'http://localhost:8787';

export class ClearChatCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('clear-chat')
    .setDescription('Clear your AI conversation history to start fresh.');

  override async execute(interaction: CommandInteraction): Promise<void> {
    const userId = interaction.user.id;

    this.logger.info(`Clearing AI chat for ${interaction.user.tag}`);

    // Increment the session version to create a new conversation
    const currentVersion = userSessionVersions.get(userId) || 0;
    const oldSessionId = `discord-${userId}-v${currentVersion}`;
    userSessionVersions.set(userId, currentVersion + 1);

    // Also clear on the worker side
    try {
      await fetch(`${AI_WORKER_URL}/api/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: oldSessionId }),
      });
    } catch {
      // Ignore errors - the session version change is enough
    }

    await interaction.reply({
      content: 'Your AI conversation history has been cleared. Your next `/ask` will start a fresh conversation.',
      ephemeral: true,
    });
  }
}

export default new ClearChatCommand();
