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
  inlineCode,
} from 'discord.js';
import { token, healthCheckPort } from './config.js';
import { fileURLToPath } from 'node:url';
import { Command } from './types/command.js';
import { setupHealthCheckServer } from './utils/healthCheck.js';
import { logger } from './utils/logger.js';
import consola from 'consola';
import { client as apiClient } from './utils/client.js';

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
  }
});

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
