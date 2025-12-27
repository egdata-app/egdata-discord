# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Discord bot that integrates with the Epic Games Data API (`https://api.egdata.app`) to provide Epic Games Store information within Discord. Built with TypeScript, discord.js, and containerized with Docker.

The repository also contains a Cloudflare Worker (`egdata-ai-worker/`) that provides an AI-powered assistant for Epic Games Store data using Workers AI and the EGData API.

## Commands

### Discord Bot

```bash
# Development - runs TypeScript watcher + bot with auto-reload
pnpm run dev

# Build TypeScript to dist/
pnpm run build

# Production - deploys slash commands then starts bot
pnpm start
```

### Cloudflare Worker (`egdata-ai-worker/`)

```bash
cd egdata-ai-worker

# Development - starts local instance at http://localhost:8787/
pnpm run dev

# Deploy to Cloudflare Workers
pnpm run deploy

# Generate TypeScript types from wrangler config
pnpm run cf-typegen
```

## Architecture

### Entry Points
- `src/index.ts` - Main bot initialization, event handlers, dynamic command loading
- `src/deploy.ts` - Discord slash command registration (runs before bot starts)
- `src/config.ts` - Environment configuration (DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID)

### Command System
Commands live in `src/commands/` and extend `BaseCommand` (src/types/BaseCommand.ts). Each command exports:
- `data` - SlashCommandBuilder defining the command
- `execute(interaction)` - Command handler
- `autocomplete(interaction)` - Optional autocomplete handler

Commands are dynamically loaded at startup and stored in `client.commands` Collection.

Current commands: ping, offer, freebies, assets, regenerate, items, seller, geolocks, ask, clear-chat

**AI Commands:**
- `ask` - Ask EGData AI questions about games, prices, deals (uses AI worker)
- `clear-chat` - Reset AI conversation history for a fresh start

### Event Handlers (in index.ts)
- `InteractionCreate` - Routes slash commands and autocomplete
- `MessageCreate` - Monitors bot mentions and Epic Games Store URLs, triggers data regeneration
- `MessageReactionAdd` - Watches for "EGData" emoji to trigger offer regeneration

### API Integration
Uses axios client (`src/utils/client.ts`) to call `https://api.egdata.app` endpoints:
- `/multisearch/offers`, `/multisearch/items` - Search
- `/offers/{id}`, `/items/{id}` - Single resource details
- `/offers/{id}/price`, `/offers/{id}/media`, `/offers/{id}/tops` - Offer metadata
- `/free-games` - Current giveaways
- `/offers/regen/{slug}` - Trigger data regeneration

### Types
- `src/types/api.ts` - API response types (SearchResponse, PriceResponse, etc.)
- `src/types/offers.ts` - SingleOffer type for full game data
- `src/types/command.ts` - Command interface
- `src/types/discord.d.ts` - Module augmentation adding `commands` to Client

### Health Check
HTTP server on port 3000 (configurable) exposes `/health` endpoint for container orchestration.

### Cloudflare Worker (`egdata-ai-worker/`)

AI-powered assistant built with [Vercel AI SDK](https://sdk.vercel.ai/) and [Mistral AI](https://mistral.ai/).

**Architecture:**
- Vercel AI SDK v6 with `streamText` for streaming responses
- Mistral SDK (`@ai-sdk/mistral`) with `mistral-small-latest` model for function calling
- In-memory conversation history (per session, resets on cold starts)

**Structure:**
- `src/index.ts` - Entry point with chat and health endpoints
- `src/tools.ts` - AI tool definitions with Zod schemas (AI SDK v6 format)
- `src/types.ts` - TypeScript types
- `wrangler.jsonc` - Cloudflare Worker config

**API Endpoints:**
- `POST /api/chat` - Chat with the AI assistant
  - Body: `{ message: string, sessionId?: string, country?: string }`
  - Returns streaming text response
- `POST /api/clear` - Clear conversation history for a session
  - Body: `{ sessionId?: string }`
- `GET /health` - Health check endpoint

**AI Tools (20 tools for EGData API):**
- `search_offers` - Search games using OpenSearch (POST /search/v2/search)
- `get_offer_details` - Get full game details
- `get_offer_price` / `get_offer_price_history` - Current and historical pricing
- `get_free_games` / `get_free_games_history` / `get_free_games_stats` - Giveaway data
- `get_top_sellers` / `get_top_wishlisted` - Top charts
- `get_featured_discounts` - Current deals
- `get_upcoming_games` / `get_latest_releases` - Release info
- `search_sellers` - Publisher/developer search
- `get_promotions` - Sales and events
- `get_store_stats` - Store statistics
- `get_offer_achievements` / `get_offer_reviews_summary` / `get_offer_hltb` - Game metadata
- `get_offer_related` - Related games/DLCs
- `search_items` - DLC and item search

**Features:**
- Stateful conversations with session persistence via Durable Objects
- WebSocket streaming for real-time responses
- Tool calling with automatic execution (up to 10 roundtrips)
- Conversation history maintained across messages
- Auto-generated thread titles via `<thread-title>` tags (parsed by Discord bot)
- Discord markdown formatting (bold, italic, strikethrough, headers, lists, etc.)

**Response Format:**
The AI appends a `<thread-title>Short Title</thread-title>` tag at the end of each response. The Discord bot (`extractThreadTitle` in `src/commands/ask.ts`) strips this tag before displaying and uses it for thread names when users click "Continue in Thread".

## Adding a New Command

1. Create `src/commands/yourcommand.ts`
2. Extend `BaseCommand` and implement required properties:
```typescript
import { BaseCommand } from '../types/BaseCommand';
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

export default class YourCommand extends BaseCommand {
  data = new SlashCommandBuilder()
    .setName('yourcommand')
    .setDescription('Description');

  async execute(interaction: ChatInputCommandInteraction) {
    // Implementation
  }
}
```
3. Command auto-loads on next restart

## Adding an AI Tool

Add the tool to `egdata-ai-worker/src/tools.ts` in the `egdataTools` object using AI SDK v6 format with the `tool()` wrapper:

```typescript
import { tool } from "ai";

your_tool_name: tool({
  description: "Description of what the tool does - be specific for the AI",
  inputSchema: z.object({
    param1: z.string().describe("Parameter description"),
    param2: z.string().optional().describe("Optional parameter"),
  }),
  execute: async ({ param1, param2 }, _options) =>
    apiRequest(`/your-endpoint/${param1}`, { param2: param2 || "" }),
}),
```

Key points:
- Wrap tools with `tool()` from the `ai` package
- Use `inputSchema` with Zod schemas (not `parameters`)
- `execute` receives `(args, options)` - the second parameter has `abortSignal`
- Tools return objects (not strings) - use `apiRequest` helper or return JSON
- `description` helps the AI understand when to use the tool

## Environment Variables

### Discord Bot
Required:
- `DISCORD_TOKEN` - Bot token
- `DISCORD_CLIENT_ID` - Application client ID
- `DISCORD_GUILD_ID` - Server ID for command deployment

Optional:
- `HEALTH_CHECK_PORT` - Default 3000
- `AI_WORKER_URL` - URL of the AI worker (default: `http://localhost:8787`)

### Cloudflare Worker (secrets)
Set via `wrangler secret put <NAME>` in the `egdata-ai-worker/` directory:
- `MISTRAL_API_KEY` - Mistral AI API key (required for AI functionality)

## Conventions

- Use consola for logging (available via `this.logger` in BaseCommand)
- Discord embeds for rich responses (see offer.ts, freebies.ts for examples)
- Ephemeral messages for errors
- Role-based access control for admin commands (see regenerate.ts for allowed roles)

## Error Handling

Critical patterns to prevent bot crashes:
- All event handlers (MessageCreate, MessageReactionAdd, etc.) must wrap their body in try/catch
- In handleCommand, error responses are wrapped in try/catch since interaction.reply can fail
- Autocomplete search calls must have `.catch(() => null)` to prevent crashes on API failures
- Global handlers for `uncaughtException` and `unhandledRejection` log but don't crash
- API calls that shouldn't crash the bot use `.catch(() => null)` pattern
