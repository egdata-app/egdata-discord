import fs from 'node:fs';
import path from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Collection,
  ActivityType,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  ChannelType,
  inlineCode,
  REST,
  Routes,
} from 'discord.js';
import { token, healthCheckPort, clientId } from './config.js';
import { fileURLToPath } from 'node:url';
import { Command } from './types/command.js';
import { setupHealthCheckServer } from './utils/healthCheck.js';
import { logger } from './utils/logger.js';
import consola from 'consola';
import { client as apiClient } from './utils/client.js';
import { threadSessions, sessionThreadTitles, extractThreadTitle, AI_WORKER_URL, pendingAskUserRequests } from './commands/ask.js';

const IS_DEV = process.env['DEV_MODE'] === 'true';

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
  partials: [
    Partials.Channel, // Required to receive events from uncached channels/threads
    Partials.Message, // Required to receive events from uncached messages
    Partials.ThreadMember, // Required to receive events from threads after restart
  ],
});

// Properly type the commands collection
client.commands = new Collection<string, Command>();

// Load commands
async function loadCommands() {
  // In dev mode, we're running from src/, in prod from dist/
  const ext = IS_DEV ? '.ts' : '.js';
  const commandsFolder = path.join(__dirname, 'commands');
  logger.info(`Loading commands from ${commandsFolder} (ext: ${ext})`);

  try {
    const commandFiles = fs
      .readdirSync(commandsFolder)
      .filter((file) => file.endsWith(ext));

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

// Deploy commands to Discord
async function deployCommands() {
  const ext = IS_DEV ? '.ts' : '.js';
  const commandsFolder = path.join(__dirname, 'commands');
  const commands: any[] = [];

  const commandFiles = fs
    .readdirSync(commandsFolder)
    .filter((file) => file.endsWith(ext));

  for (const file of commandFiles) {
    const commandPath = path.join(commandsFolder, file);
    const command = await import(`file://${commandPath}?t=${Date.now()}`).then(
      (module) => module.default
    );

    if ('data' in command && ('execute' in command || 'autocomplete' in command)) {
      const data = command.data.toJSON();
      commands.push({
        ...data,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
      });
    }
  }

  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info(`Deployed ${commands.length} commands to Discord`);
}

// Hot reload a single command (dev mode only)
async function reloadCommand(filename: string) {
  const commandPath = path.join(__dirname, 'commands', filename);

  try {
    // Import with cache-busting timestamp
    const command = await import(`file://${commandPath}?t=${Date.now()}`).then(
      (module) => module.default
    );

    if ('data' in command && ('execute' in command || 'autocomplete' in command)) {
      client.commands.set(command.data.name, command);
      logger.info(`🔄 Hot-reloaded command: ${command.data.name}`);
      return command;
    } else {
      logger.error(`Invalid command structure in ${filename}`);
      return null;
    }
  } catch (error) {
    logger.error(`Failed to reload command ${filename}:`, error);
    return null;
  }
}

// Watch commands folder for changes (dev mode only)
function watchCommands() {
  const commandsFolder = path.join(__dirname, 'commands');
  logger.info(`👀 Watching commands folder for changes: ${commandsFolder}`);

  // Debounce map to prevent multiple reloads for the same file
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  fs.watch(commandsFolder, async (_eventType, filename) => {
    if (!filename || !filename.endsWith('.ts')) return;

    // Debounce: wait 100ms before reloading to handle rapid file changes
    const existingTimer = debounceTimers.get(filename);
    if (existingTimer) clearTimeout(existingTimer);

    debounceTimers.set(filename, setTimeout(async () => {
      debounceTimers.delete(filename);

      logger.info(`📝 Detected change in ${filename}`);

      const command = await reloadCommand(filename);
      if (command) {
        // Re-deploy all commands to Discord
        // Note: Discord has rate limits, so we deploy all at once rather than individually
        try {
          await deployCommands();
          logger.info(`✅ Commands deployed to Discord`);
        } catch (error) {
          logger.error('Failed to deploy commands to Discord:', error);
        }
      }
    }, 100));
  });
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
client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}`);
  client.user?.setActivity('EGS changes...', { type: ActivityType.Watching });

  // Join active threads created by the bot to receive messages after restart
  try {
    for (const guild of readyClient.guilds.cache.values()) {
      // Fetch active threads in the guild
      const activeThreads = await guild.channels.fetchActiveThreads();

      let joinedCount = 0;
      let recoveredCount = 0;
      for (const thread of activeThreads.threads.values()) {
        // Only process threads created by the bot
        if (thread.ownerId !== readyClient.user.id) {
          continue;
        }

        // Join if not already a member
        if (!thread.joined) {
          try {
            await thread.join();
            joinedCount++;
            logger.debug(`Joined thread: ${thread.name} (${thread.id})`);
          } catch {
            // Ignore errors (bot might not have permission)
            continue;
          }
        }

        // Proactively recover session if not in memory
        if (!threadSessions.has(thread.id)) {
          const recovered = await recoverThreadSession(thread);
          if (recovered) {
            recoveredCount++;
          }
        }
      }

      if (joinedCount > 0 || recoveredCount > 0) {
        logger.info(`${guild.name}: joined ${joinedCount} threads, recovered ${recoveredCount} sessions`);
      }
    }
  } catch (error) {
    logger.error('Error joining active threads:', error);
  }
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

      // Send welcome message in thread (include session ID for recovery after bot restart)
      await thread.send({
        content: `💬 **Chat started!** Just type your messages here and I'll respond. Your conversation context is preserved from the original question.\n-# Session: \`${sessionId}\``,
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
  } else if (action === 'ask_user_response') {
    // Handle ask_user tool response
    // Format: ask_user_response:{sessionId}:{requestId}:{optionIndex}
    const requestId = parts[2];
    const optionIndex = parseInt(parts[3] || '0', 10);

    if (!sessionId || !requestId) {
      await interaction.reply({
        content: '❌ Invalid request.',
        ephemeral: true,
      });
      return;
    }

    // Validate user owns this session
    const sessionUserMatch = sessionId.match(/^discord-(\d+)-[a-z0-9]+-[a-z0-9]+$/);
    const sessionUserId = sessionUserMatch ? sessionUserMatch[1] : null;

    if (sessionUserId && sessionUserId !== interaction.user.id) {
      await interaction.reply({
        content: "❌ You can only respond to your own questions.",
        ephemeral: true,
      });
      return;
    }

    const pendingKey = `${sessionId}:${requestId}`;
    const pending = pendingAskUserRequests.get(pendingKey);

    if (!pending) {
      await interaction.reply({
        content: '❌ This question has expired. Please try again.',
        ephemeral: true,
      });
      return;
    }

    // Get the selected option
    const selectedOption = pending.options[optionIndex] || 'Unknown';

    // Send response via WebSocket
    pending.wsClient.sendUserResponse(requestId, selectedOption);

    // Update the message to show the selected option
    await interaction.update({
      content: `✅ You selected: **${selectedOption}**\n\n*Continuing...*`,
      components: [],
    });

    // Clean up and resolve
    pendingAskUserRequests.delete(pendingKey);
    pending.resolve();
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

// Try to recover session ID from thread's welcome message (for bot restarts)
async function recoverThreadSession(thread: import('discord.js').ThreadChannel): Promise<string | null> {
  try {
    // Fetch messages from the START of the thread (after: thread.id gets oldest messages first)
    // Thread ID is also the ID of the starter message, so fetching after it gets the first messages
    const messages = await thread.messages.fetch({ after: thread.id, limit: 10 });

    logger.debug(`Fetched ${messages.size} messages from thread ${thread.id} for recovery`);

    // Look for the bot's welcome message containing the session ID
    for (const msg of messages.values()) {
      logger.debug(`Checking message from ${msg.author.tag}: ${msg.content.slice(0, 100)}...`);
      if (msg.author.id === client.user?.id) {
        // Match the session ID pattern - with or without backticks
        // Format: Session: `discord-{userId}-{timestamp}-{random}` or Session: discord-...
        const match = msg.content.match(/Session:\s*`?(discord-\d+-[a-z0-9]+-[a-z0-9]+)`?/);
        if (match?.[1]) {
          logger.info(`Recovered session ${match[1]} for thread ${thread.id}`);
          threadSessions.set(thread.id, match[1]);
          return match[1];
        }
      }
    }

    logger.debug(`No session ID found in thread ${thread.id} messages`);
  } catch (error) {
    logger.error(`Failed to recover session for thread ${thread.id}:`, error);
  }
  return null;
}

client.on(Events.MessageCreate, async (message) => {
  try {
    // Debug: Log ALL incoming messages to verify event is firing
    logger.debug(`MessageCreate: channel=${message.channel.id} type=${message.channel.type} isThread=${message.channel.isThread()} author=${message.author?.tag || 'unknown'}`);

    // Handle partial messages (from uncached channels after restart)
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        logger.warn('Failed to fetch partial message');
        return;
      }
    }

    consola.trace('Message created:', message.content);

    // Handle AI chat in threads (only for bot-owned threads)
    if (message.channel.isThread() && !message.author.bot && message.channel.ownerId === client.user?.id) {
      logger.debug(`Thread message received in ${message.channel.id}: ${message.content.slice(0, 50)}...`);

      let sessionId: string | undefined = threadSessions.get(message.channel.id);

      // If session not in memory, try to recover it from the thread's welcome message
      if (!sessionId) {
        logger.debug(`Session not in memory for thread ${message.channel.id}, attempting recovery...`);
        const recovered = await recoverThreadSession(message.channel);
        if (recovered) sessionId = recovered;
      }

      if (sessionId) {
        await handleThreadMessage(message, sessionId);
        return;
      } else {
        logger.debug(`No session found for thread ${message.channel.id}, ignoring message`);
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

// Handle messages in AI chat threads (using WebSocket for consistent context)
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

    // Use WebSocket for consistent context with /ask command
    const { AIWebSocketClient } = await import('./utils/ai-websocket.js');
    const wsClient = new AIWebSocketClient(AI_WORKER_URL, sessionId);

    let fullText = '';
    let completed = false;
    let error: string | null = null;
    let lastTypingTime = 0;
    const TYPING_INTERVAL = 5000;

    // Set up event handlers
    wsClient.on('tool_progress', () => {
      const now = Date.now();
      if (now - lastTypingTime >= TYPING_INTERVAL) {
        lastTypingTime = now;
        channel.sendTyping().catch(() => {});
      }
    });

    wsClient.on('text_delta', () => {
      // Keep typing indicator active during streaming
      const now = Date.now();
      if (now - lastTypingTime >= TYPING_INTERVAL) {
        lastTypingTime = now;
        channel.sendTyping().catch(() => {});
      }
    });

    wsClient.on('complete', (msg) => {
      fullText = msg.text;
      completed = true;
    });

    wsClient.on('error', (msg) => {
      error = msg.message;
      completed = true;
    });

    // Connect and send message
    await wsClient.connect();
    wsClient.sendChat(question);

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
      await message.reply({
        content: `❌ AI Error: ${error}`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    if (!fullText.trim()) {
      await message.reply({
        content: "I couldn't generate a response. Please try again.",
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    // Strip thread title from response
    const { cleanContent } = extractThreadTitle(fullText);

    // Discord message limit is 2000 characters - split into multiple messages for threads
    const MAX_LENGTH = 1900;

    if (cleanContent.length <= MAX_LENGTH) {
      await message.reply({
        content: cleanContent,
        allowedMentions: { repliedUser: false },
      });
    } else {
      // Split into multiple messages at natural break points
      const chunks: string[] = [];
      let remaining = cleanContent;

      while (remaining.length > 0) {
        if (remaining.length <= MAX_LENGTH) {
          chunks.push(remaining);
          break;
        }

        // Find a good break point (paragraph, line, or space)
        let breakPoint = MAX_LENGTH;
        const searchRegion = remaining.slice(MAX_LENGTH - 300, MAX_LENGTH);

        // Priority: double newline > single newline > space
        const paragraphBreak = searchRegion.lastIndexOf('\n\n');
        if (paragraphBreak !== -1) {
          breakPoint = MAX_LENGTH - 300 + paragraphBreak + 2;
        } else {
          const lineBreak = searchRegion.lastIndexOf('\n');
          if (lineBreak !== -1) {
            breakPoint = MAX_LENGTH - 300 + lineBreak + 1;
          } else {
            const space = searchRegion.lastIndexOf(' ');
            if (space !== -1) {
              breakPoint = MAX_LENGTH - 300 + space + 1;
            }
          }
        }

        chunks.push(remaining.slice(0, breakPoint).trimEnd());
        remaining = remaining.slice(breakPoint).trimStart();
      }

      // Send first chunk as reply, rest as follow-up messages
      await message.reply({
        content: chunks[0],
        allowedMentions: { repliedUser: false },
      });

      for (let i = 1; i < chunks.length; i++) {
        await channel.send({
          content: chunks[i],
        });
      }
    }
  } catch (err) {
    logger.error('Thread AI chat error:', err);
    await message.reply({
      content: `Failed to get AI response: ${err instanceof Error ? err.message : 'Unknown error'}`,
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

    // In dev mode, deploy commands on startup and watch for changes
    if (IS_DEV) {
      logger.info('🛠️  Dev mode enabled');
      await deployCommands();
      watchCommands();
    }

    setupHealthCheckServer(client, healthCheckPort);
    await client.login(token);
  } catch (error) {
    logger.error('Failed to initialize bot:', error);
    process.exit(1);
  }
}

initialize();
