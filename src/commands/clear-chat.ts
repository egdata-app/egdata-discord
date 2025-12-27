import { SlashCommandBuilder, type CommandInteraction, ChannelType } from 'discord.js';
import { BaseCommand } from '../types/BaseCommand.js';
import { threadSessions, AI_WORKER_URL } from './ask.js';

export class ClearChatCommand extends BaseCommand {
  override data = new SlashCommandBuilder()
    .setName('clear-chat')
    .setDescription('Clear the AI conversation history in the current thread.');

  override async execute(interaction: CommandInteraction): Promise<void> {
    this.logger.info(`Clear chat request from ${interaction.user.tag}`);

    // Check if we're in a thread with an active AI session
    if (interaction.channel?.type === ChannelType.PublicThread ||
        interaction.channel?.type === ChannelType.PrivateThread) {
      const sessionId = threadSessions.get(interaction.channel.id);

      if (sessionId) {
        // Clear the session on the worker side
        try {
          await fetch(`${AI_WORKER_URL}/api/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
        } catch {
          // Ignore errors
        }

        // Remove the thread-session mapping so it's treated as a fresh start
        threadSessions.delete(interaction.channel.id);

        await interaction.reply({
          content: 'This thread\'s AI conversation history has been cleared. Future messages in this thread will start a fresh conversation.',
          ephemeral: true,
        });
        return;
      }
    }

    // Not in an AI thread - inform user that /ask is already fresh
    await interaction.reply({
      content: 'Each `/ask` command already starts a fresh conversation. Use `/clear-chat` inside an AI thread to clear that thread\'s conversation history.',
      ephemeral: true,
    });
  }
}

export default new ClearChatCommand();
