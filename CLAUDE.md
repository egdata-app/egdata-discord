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

Current commands: ping, offer, freebies, assets, regenerate, items, seller, geolocks

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

AI-powered assistant built with [Hono](https://hono.dev/), [chanfana](https://chanfana.pages.dev/), Workers AI, and [@cloudflare/ai-utils](https://www.npmjs.com/package/@cloudflare/ai-utils).

**Structure:**
- `src/index.ts` - Main router, registers OpenAPI endpoints
- `src/endpoints/aiChat.ts` - AI chat endpoint with tool execution
- `src/tools.ts` - AI tool definitions and execution handlers for EGData API
- `src/types.ts` - TypeScript types
- `wrangler.jsonc` - Cloudflare Worker configuration with AI binding

**API Endpoints:**
- `POST /api/chat` - Chat with the AI assistant
- `GET /health` - Health check endpoint

**AI Tools (30+ tools for EGData API):**
- `search_offers` - Search games using OpenSearch (v2 endpoint)
- `get_offer_details` - Get full game details
- `get_offer_price` / `get_offer_price_history` - Current and historical pricing
- `get_free_games` / `get_free_games_history` - Current and past giveaways
- `get_top_sellers` / `get_top_wishlisted` - Top charts
- `get_featured_discounts` - Current deals
- `get_upcoming_games` / `get_latest_releases` - Release info
- `get_seller_info` / `search_sellers` - Publisher/developer info
- `get_promotions` / `get_promotion_offers` - Sales and events
- `get_store_stats` / `get_homepage_stats` - Store statistics
- `get_collection` - Collection data (top-sellers, etc.)
- `get_offer_achievements` / `get_offer_reviews` / `get_offer_hltb` - Game metadata
- `get_sandbox_info` / `get_sandbox_items` - Sandbox (namespace) data
- `search_items` / `get_item_details` - DLC and item search

**Features:**
- Auto-generated OpenAPI schema at `/`
- Swagger UI for API exploration
- Request validation via Zod schemas
- Workers AI with Llama 3.3 70B model
- Tool calling with automatic execution

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

1. Add the tool definition to `egdata-ai-worker/src/tools.ts` in the `tools` array:
```typescript
{
  name: "your_tool_name",
  description: "Description of what the tool does - be specific for the AI",
  parameters: {
    type: "object" as const,
    properties: {
      param1: {
        type: "string",
        description: "Parameter description",
      },
    },
    required: ["param1"],
  },
},
```

2. Add the execution handler in the `executeTool` switch statement:
```typescript
case "your_tool_name":
  return apiRequest(`/your-endpoint/${args.param1}`);
```

## Environment Variables

Required:
- `DISCORD_TOKEN` - Bot token
- `DISCORD_CLIENT_ID` - Application client ID
- `DISCORD_GUILD_ID` - Server ID for command deployment

Optional:
- `HEALTH_CHECK_PORT` - Default 3000

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
