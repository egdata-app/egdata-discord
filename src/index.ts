import fs from 'node:fs';
import path from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  Collection,
  ActivityType,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  ChannelType,
  inlineCode,
} from 'discord.js';
import { token, healthCheckPort } from './config.js';
import { fileURLToPath } from 'node:url';
import { Command } from './types/command.js';
import { setupHealthCheckServer } from './utils/healthCheck.js';
import { logger } from './utils/logger.js';
import consola from 'consola';
import { client as apiClient } from './utils/client.js';
import { threadSessions, sessionThreadTitles, extractThreadTitle, AI_WORKER_URL, type SSEEvent } from './commands/ask.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize Discord client with proper typing
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Properly type the commands collection
client.commands = new Collection<string, Command>();

// Load commands
async function loadCommands() {
  const commandsFolder = path.join(__dirname, 'commands');
  logger.info(`Loading commands from ${commandsFolder}`);

  try {
    const commandFiles = fs
      .readdirSync(commandsFolder)
      .filter((file) => file.endsWith('.js'));

    for (const file of commandFiles) {
      const commandPath = path.join(commandsFolder, file);
      const command = await import(`file://${commandPath}`).then(
        (module) => module.default
      );

      if ('data' in command && ('execute' in command || 'autocomplete' in command)) {
        client.commands.set(command.data.name, command);
        logger.info(`Loaded command: ${command.data.name}`);
      } else {
        logger.error(`Invalid command structure in ${file}`);
      }
    }
  } catch (error) {
    logger.error('Failed to load commands:', error);
    throw error;
  }
}

// Handle command execution
async function handleCommand(interaction: ChatInputCommandInteraction) {
  const command = client.commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Error executing command ${interaction.commandName}:`, error);
    const errorMessage = 'There was an error while executing this command!';

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (replyError) {
      logger.error(`Failed to send error response for ${interaction.commandName}:`, replyError);
    }
  }
}

// Handle autocomplete
async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const command = client.commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    if (command.autocomplete) {
      await command.autocomplete(interaction);
    }
  } catch (error) {
    logger.error(`Error handling autocomplete for ${interaction.commandName}:`, error);
  }
}

// Event handlers
client.once(Events.ClientReady, (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}`);
  client.user?.setActivity('EGS changes...', { type: ActivityType.Watching });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

// Handle button interactions
async function handleButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(':');
  const action = parts[0];
  const sessionId = parts[1];

  if (action === 'create_thread' && sessionId) {
    try {
      // Check if we're in a guild text channel
      if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: 'Threads can only be created in text channels.',
          ephemeral: true,
        });
        return;
      }

      // Get AI-generated title or fall back to default
      const aiTitle = sessionThreadTitles.get(sessionId);
      const threadName = aiTitle || `Chat with ${interaction.user.displayName}`;

      // Create a thread from the message
      const thread = await interaction.message.startThread({
        name: threadName.slice(0, 100), // Discord thread name limit is 100 chars
        autoArchiveDuration: 60, // Archive after 1 hour of inactivity
      });

      // Clean up the stored title
      if (aiTitle) {
        sessionThreadTitles.delete(sessionId);
      }

      // Map thread ID to session ID for conversation continuity
      threadSessions.set(thread.id, sessionId);

      // Remove the button from the original message
      await interaction.update({
        components: [],
      });

      // Send welcome message in thread
      await thread.send({
        content: `💬 **Chat started!** Just type your messages here and I'll respond. Your conversation context is preserved from the original question.`,
      });

      logger.info(`Created AI chat thread ${thread.id} for session ${sessionId}`);
    } catch (error) {
      logger.error('Error creating thread:', error);
      await interaction.reply({
        content: 'Failed to create thread. Please try again.',
        ephemeral: true,
      }).catch(() => {});
    }
  } else if (action === 'confirm_save' && sessionId) {
    // Validate that the user clicking is the owner of the session
    // Session ID format: discord-{userId}-{timestamp}-{random}
    const sessionUserMatch = sessionId.match(/^discord-(\d+)-[a-z0-9]+-[a-z0-9]+$/);
    const sessionUserId = sessionUserMatch ? sessionUserMatch[1] : null;

    if (sessionUserId && sessionUserId !== interaction.user.id) {
      await interaction.reply({
        content: "❌ You can only manage your own preferences.",
        ephemeral: true,
      });
      return;
    }

    // User confirmed saving their context
    try {
      const response = await fetch(`${AI_WORKER_URL}/api/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      if (response.ok) {
        const result = await response.json() as { message: string };
        // Update the ephemeral message to show confirmation, then delete it
        await interaction.update({
          content: `✅ ${result.message}`,
          components: [],
        });
        // Delete the ephemeral message after a short delay
        setTimeout(() => {
          interaction.deleteReply().catch(() => {});
        }, 2000);
      } else {
        await interaction.update({
          content: '❌ Failed to save. Please try again.',
          components: [],
        });
      }
    } catch (error) {
      logger.error('Error confirming save:', error);
      await interaction.update({
        content: '❌ Failed to save. Please try again.',
        components: [],
      }).catch(() => {});
    }
  } else if (action === 'reject_save' && sessionId) {
    // Validate that the user clicking is the owner of the session
    const sessionUserMatch = sessionId.match(/^discord-(\d+)-[a-z0-9]+-[a-z0-9]+$/);
    const sessionUserId = sessionUserMatch ? sessionUserMatch[1] : null;

    if (sessionUserId && sessionUserId !== interaction.user.id) {
      await interaction.reply({
        content: "❌ You can only manage your own preferences.",
        ephemeral: true,
      });
      return;
    }

    // User rejected saving their context
    try {
      await fetch(`${AI_WORKER_URL}/api/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      // Update the ephemeral message to show rejection, then delete it
      await interaction.update({
        content: "👍 No problem, I won't remember that.",
        components: [],
      });
      // Delete the ephemeral message after a short delay
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 2000);
    } catch (error) {
      logger.error('Error rejecting save:', error);
      await interaction.update({
        content: '❌ Something went wrong.',
        components: [],
      }).catch(() => {});
    }
  }
}

// Handle bot mentions
async function processEpicGamesUrl(message: string) {
  consola.debug('Processing message:', message);
  // Epic Games Store URL pattern
  const epicStoreRegex = /https?:\/\/(?:store\.)?epicgames\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:p|product)\/[a-zA-Z0-9-]+/g;

  const matches = message.match(epicStoreRegex);
  if (matches) {
    const url = new URL(matches[0]);
    consola.debug('URL:', url);

    // Extract the slug from the pathname
    const pathSegments = url.pathname.split('/');
    const pIndex = pathSegments.findIndex(segment => segment === 'p' || segment === 'product');
    if (pIndex !== -1 && pathSegments[pIndex + 1]) {
      const slug = pathSegments[pIndex + 1];
      if (slug) {
        consola.info('Product slug:', slug);

        const result = await apiClient.put<{ message: string }>(`/offers/regen/${slug}`).catch((error) => {
          logger.error('Request failed:', error);
          return null;
        });

        if (result) {
          return slug;
        }
      }
    }
  }
  return null;
}

client.on(Events.MessageCreate, async (message) => {
  try {
    consola.trace('Message created:', message.content);

    // Handle AI chat in threads
    if (message.channel.isThread() && !message.author.bot) {
      const sessionId = threadSessions.get(message.channel.id);
      if (sessionId) {
        await handleThreadMessage(message, sessionId);
        return;
      }
    }

    // Check if the message mentions the bot
    if (message.mentions.has(client.user!)) {
      consola.debug('Regenerate command received:', message);
      if (message.reference) {
        const originalMessage = await message.channel.messages.fetch(message.reference.messageId as string);
        const slug = await processEpicGamesUrl(originalMessage.content);
        if (slug) {
          await message.reply({
            content: `🚀 Received request to regenerate offer for slug ${inlineCode(slug)}`,
          });
        }
      }
    }
  } catch (error) {
    logger.error('Error handling message:', error);
  }
});

// Handle messages in AI chat threads
async function handleThreadMessage(message: import('discord.js').Message, sessionId: string) {
  const question = message.content.trim();
  if (!question) return;

  // Ensure channel supports typing
  const channel = message.channel;
  if (!('sendTyping' in channel)) return;

  logger.info(`Thread AI question from ${message.author.tag}: ${question}`);

  try {
    // Show typing indicator
    await channel.sendTyping();

    // Stream response from AI worker
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
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL = 1500;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent;

            if (event.type === 'tool') {
              const now = Date.now();
              if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                lastUpdateTime = now;
                // Keep typing indicator active
                await channel.sendTyping().catch(() => {});
              }
            } else if (event.type === 'complete') {
              if (event.text.trim()) {
                // Strip thread title from response
                const { cleanContent } = extractThreadTitle(event.text);

                // Discord message limit is 2000 characters
                const MAX_LENGTH = 1900;
                let responseText = cleanContent;

                if (responseText.length > MAX_LENGTH) {
                  responseText = responseText.slice(0, MAX_LENGTH) + '...';
                }

                await message.reply({
                  content: responseText,
                  allowedMentions: { repliedUser: false },
                });
              } else {
                await message.reply({
                  content: "I couldn't generate a response. Please try again.",
                  allowedMentions: { repliedUser: false },
                });
              }
              return;
            } else if (event.type === 'error') {
              await message.reply({
                content: `❌ AI Error: ${event.message}`,
                allowedMentions: { repliedUser: false },
              });
              return;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    // If we get here without a complete event
    await message.reply({
      content: 'Response ended unexpectedly. Please try again.',
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    logger.error('Thread AI chat error:', error);
    await message.reply({
      content: `Failed to get AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  }
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    // Handle partial reactions
    if (reaction.partial) {
      await reaction.fetch();
    }

    logger.info('Reaction added:', {
      emoji: reaction.emoji.name,
      userId: user.id,
      messageId: reaction.message.id
    });

    // If someone adds a reaction with the emoji `<:EGData:1263952305485779106>`, do the same as the reply in the message
    if (reaction.emoji.name === 'EGData') {
      const message = await reaction.message.fetch();

      // Check if the message already has a checkmark reaction
      const checkmarkReaction = message.reactions.cache.find(r => r.emoji.name === '✅');
      if (checkmarkReaction) {
        logger.info('Message already has a checkmark reaction, skipping regeneration');
        return;
      }

      const slug = await processEpicGamesUrl(message.content);
      if (slug) {
        await message.react('✅');
      }
    }
  } catch (error) {
    logger.error('Error handling reaction:', error);
  }
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM. Shutting down gracefully...');
  await client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT. Shutting down gracefully...');
  await client.destroy();
  process.exit(0);
});

// Initialize the bot
async function initialize() {
  try {
    await loadCommands();
    setupHealthCheckServer(client, healthCheckPort);
    await client.login(token);
  } catch (error) {
    logger.error('Failed to initialize bot:', error);
    process.exit(1);
  }
}

initialize();
