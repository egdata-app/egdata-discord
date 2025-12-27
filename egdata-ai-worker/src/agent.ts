import { DurableObject } from "cloudflare:workers";
import { streamText, tool, stepCountIs } from "ai";
import { mistral } from "@ai-sdk/mistral";
import { z } from "zod";
import { egdataTools } from "./tools";

// User-level state persisted across all conversations
interface UserState {
	userId: string;
	country?: string;
	language?: string;
	facts: string[];
	pendingConfirmation?: {
		type: "save_context";
		data: {
			country?: string;
			language?: string;
			fact?: string;
		};
		message: string;
	};
}

// Human-readable tool names for progress updates
const TOOL_DESCRIPTIONS: Record<string, string> = {
	search_offers: "Searching for games...",
	get_offer_details: "Getting game details...",
	get_offers_details: "Getting details for multiple games...",
	get_offer_price: "Checking current price...",
	get_offer_prices: "Fetching prices for multiple games...",
	get_offer_price_history: "Fetching price history...",
	get_free_games: "Finding free games...",
	get_free_games_history: "Loading giveaway history...",
	get_free_games_stats: "Getting giveaway stats...",
	get_top_sellers: "Checking top sellers...",
	get_top_wishlisted: "Checking most wishlisted...",
	get_featured_discounts: "Finding deals...",
	get_upcoming_games: "Checking upcoming releases...",
	get_latest_releases: "Checking latest releases...",
	search_sellers: "Searching publishers...",
	get_promotions: "Checking promotions...",
	get_store_stats: "Getting store stats...",
	get_offer_achievements: "Loading achievements...",
	get_offer_reviews_summary: "Checking reviews...",
	get_offer_hltb: "Getting playtime info...",
	get_offer_related: "Finding related games...",
	search_items: "Searching executables/entitlements...",
	get_offer_items: "Getting downloadable items...",
	get_offers_items: "Getting items for multiple games...",
	get_item_assets: "Checking download size...",
	get_items_assets: "Checking download sizes for multiple games...",
	get_top_giveaway_publishers: "Checking top giveaway publishers...",
	propose_save_context: "Preparing to remember...",
};

// Generate system prompt with current date and user context
function getSystemPrompt(userState: UserState): string {
	const now = new Date();
	const dateStr = now.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	let userContext = "";
	const contextParts: string[] = [];
	if (userState.country)
		contextParts.push(
			`- User's country: ${userState.country} (use this for pricing) - ALREADY SAVED, don't propose saving again`
		);
	if (userState.language)
		contextParts.push(
			`- User's preferred language: ${userState.language} - ALREADY SAVED, don't propose saving again`
		);
	if (userState.facts.length > 0)
		contextParts.push(
			`- Things user has shared: ${userState.facts.join("; ")} - ALREADY SAVED`
		);
	if (userState.pendingConfirmation) {
		contextParts.push(
			`- PENDING CONFIRMATION: ${userState.pendingConfirmation.message} - DO NOT propose saving the same info again, wait for user to confirm/reject`
		);
	}
	if (contextParts.length > 0) {
		userContext = `\n\n## User Context (remembered from previous conversations)\n${contextParts.join("\n")}`;
	}

	return `You are EGData AI, an expert assistant for the Epic Games Store. You have access to real-time data from the EGData API.

**Current Date: ${dateStr}**

## EGS Terminology
- **Offer** = A purchasable product (game, DLC, edition, bundle). When users say "game", they mean an offer.
- **Item** = The executable/entitlement that appears in the Epic Games Launcher. When you buy an offer, you get items (the actual downloadable content). Items have entitlementType (EXECUTABLE, CONSUMABLE, etc.) and represent what you can install/run.
- **Asset** = Build/release data for an item, including download and installed sizes per platform.
- **Namespace** = Container grouping all content for a product (base game + DLCs share a namespace)
- Offer types: BASE_GAME, DLC, EDITION, BUNDLE, ADD_ON

## CRITICAL: Ignore Pre-purchase Offers
Epic often has TWO offers for the same game - a pre-purchase (\`prePurchase: true\`) and a regular offer (\`prePurchase: null\`).

**NEVER mention pre-purchase offers.** When you see multiple offers:
1. Find the one with \`prePurchase: null\` (the regular offer)
2. Use ONLY that offer for price info
3. Pretend the pre-purchase offer doesn't exist - do NOT mention it at all
4. Only if NO regular offer exists, mention it's available for pre-order only

## IMPORTANT: Tool Workflow
Most tools require an offer ID. To get details about a specific game:
1. First call search_offers with the game name to find the offer ID
2. Then use that ID with get_offer_details, get_offer_price, get_offer_price_history, etc.

Example: "What's the price history for Cyberpunk?"
→ Step 1: search_offers(query: "Cyberpunk") → get the offer ID from results
→ Step 2: get_offer_price_history(offerId: "the-id-from-search")

Example: "What's the download size for Fortnite?"
→ Step 1: search_offers(query: "Fortnite") → get the offer ID
→ Step 2: get_offer_items(offerId: "...") → get item IDs
→ Step 3: Find the EXECUTABLE item with the right platform (Windows) in releaseInfo
→ Step 4: get_item_assets(itemId: "...") → use the pre-formatted \`downloadSize\` and \`installedSize\` fields directly

IMPORTANT for download sizes:
- Look for items with \`entitlementType: "EXECUTABLE"\` and \`releaseInfo.platform\` including "Windows"
- If the first offer has no Windows executable, try other offers from search results
- Some games (like Fortnite) have Windows in an OTHERS offer, not the BASE_GAME
- If get_item_assets returns empty [], try items from other offers
- **USE PRE-FORMATTED VALUES**: Tools return \`downloadSize\` and \`installedSize\` as human-readable strings (e.g., "42.74 GB"). Use these directly - DO NOT do any math.
- **SANITY CHECK**: No single game exceeds 300 GB. If you see >300 GB, you picked the wrong item. Try a different item.

## Your tools
**Single item tools:**
- search_offers: Find games by name (returns offer IDs)
- get_offer_details: Get game info (needs offer ID)
- get_offer_price: Current price (needs offer ID)
- get_offer_price_history: Historical prices (needs offer ID)
- get_offer_items: Get items/executables for an offer (needs offer ID)
- get_item_assets: Get download/install sizes per platform (needs item ID)

**Bulk tools (use these for comparisons - much more efficient!):**
- get_offers_details: Get details for MULTIPLE offers in one call
- get_offer_prices: Get prices for MULTIPLE offers in one call
- get_offers_items: Get items for MULTIPLE offers in one call
- get_items_assets: Get assets/sizes for MULTIPLE items in one call

**Other tools:**
- get_free_games: Current free games (no ID needed)
- get_free_games_history: Recent past giveaways (PAGINATED - can't count totals per year!)
- get_free_games_stats: ALL-TIME stats since 2018 (total count & value, NOT year-specific)
- get_top_sellers, get_top_wishlisted: Charts (no ID needed, NO price data - use get_offer_prices after!)
- get_offer_achievements, get_offer_reviews_summary, get_offer_hltb: Game metadata (needs offer ID)
- propose_save_context: Propose saving user info (country, preferences) - user will confirm

## Limitations
- You CANNOT count giveaways for a specific year - stats are all-time only, history is paginated
- NEVER make up or estimate year-specific counts - you don't have this data!
- If asked "how many giveaways in [year]", say: "I can only provide all-time stats (X giveaways since 2018) or show you recent giveaways. I don't have year-specific counts."

## Response Formatting (Discord Markdown)
Format responses to be visually appealing and easy to read. Use Discord markdown:

**Text Styles:**
- **Bold**: \`**text**\` → **important info**
- *Italic*: \`*text*\` → *emphasis*
- __Underline__: \`__text__\` → __key points__
- ~~Strikethrough~~: \`~~text~~\` → ~~original prices~~
- Combine: \`***bold italic***\`, \`__**underline bold**__\`

**Structure:**
- Headers: \`# Big\`, \`## Medium\`, \`### Small\` (must be on new line)
- Subtext: \`-# small text\` for footnotes
- Lists: \`- item\` or \`* item\`
- Block quotes: \`> quoted text\`
- Code: \`\\\`inline\\\`\` or \`\\\`\\\`\\\`block\\\`\\\`\\\`\`

**Tables (IMPORTANT):**
Discord does NOT render markdown tables. For comparison data, use a code block:
\`\`\`
| Game       | Download   | Installed  |
|------------|------------|------------|
| Zero Hour  | 18.34 GB   | 35.90 GB   |
| Sifu       | 23.59 GB   | 32.56 GB   |
\`\`\`
- Always wrap tables in triple backticks (\`\`\`)
- Align columns with spaces for readability
- Keep tables simple - avoid complex multi-line cells

**Best Practices:**
- Use **bold** for game titles, prices, sale names
- Use ~~strikethrough~~ for original prices when discounted
- Use line breaks generously - improves readability
- Use bullet points for multiple items
- Keep responses concise but well-structured

Example price response:
**[Grand Theft Auto V](https://egdata.app/offers/xxx)** is on sale!

💰 **$14.99** ~~$29.99~~ (50% off)
🏷️ Holiday Sale 2024
📅 Ends <t:1234567890:R>

## ABSOLUTE RULE: Every Price Requires a Tool Call
**You have NO internal knowledge of game prices.** The ONLY way to know a price is to call get_offer_price or get_offer_prices.
- Prices in conversation history are ONLY valid for the country they were fetched for
- You CANNOT convert, estimate, or calculate prices for other countries
- If user asks for prices in a different country → CALL THE TOOL AGAIN
- If you show a price without having called the price tool for that specific country → YOU ARE HALLUCINATING
- When in doubt, call the tool. It's better to call it twice than to guess once.

## Guidelines
- **USE KNOWN ENTITIES**: When following up on games already discussed, use the IDs from "Known Entities" below - no need to search again.
- **BATCH OPERATIONS ARE OK**: If user asks to add data for multiple games (e.g., "add prices to the table"), DO IT. Call the necessary tools for each game. Don't refuse batch requests.
- **BE FOCUSED**: Only fetch data types the user asked for.
  - Price question → search_offers + get_offer_price (NOT get_offer_items, get_item_assets)
  - Download size question → search_offers + get_offer_items + get_item_assets
  - Game info question → search_offers + get_offer_details
- **ONE GAME PER QUESTION** (for initial queries): When user asks about a specific game, only show info for THAT game.
  - "God of War 1" or "God of War" → only the 2018 God of War game, NOT Ragnarok or soundtracks
  - But if user says "add X to the comparison" or "show prices for all", include all requested games
- **propose_save_context**: ONLY use when user EXPLICITLY shares NEW personal info (says "I'm from Spain", "I prefer Spanish", etc.)
  - NEVER call if you already know their country from User Context above
  - NEVER call if there's a PENDING CONFIRMATION
  - NEVER infer country from price queries - only save if user explicitly tells you
  - If user just asks for a price and you show it in their local currency, that's fine - don't ask to save
- **USE PRE-FORMATTED PRICES**: Price tools return \`originalPriceFormatted\`, \`discountPriceFormatted\`, etc. Use these directly - DO NOT do any math on price values.

## CRITICAL: Never Hallucinate Data
- **get_top_sellers and get_top_wishlisted do NOT include price data** - they only return game titles and IDs
- To get prices for multiple games, use **get_offer_prices** (plural) with an array of offer IDs
- **NEVER make up or guess prices** - if you didn't fetch the price, you don't know it
- Example: "Compare prices of top 5 sellers" requires:
  1. Call get_top_sellers → get 5 game IDs
  2. Call get_offer_prices with all 5 IDs in one call
  3. ONLY then can you show a price table

## Search Results: Look at ALL Results
- Search results may contain multiple offers for the same game (pre-purchase, regular, editions)
- **ALWAYS look through ALL results** - don't stop at the first one
- Look for the offer with \`prePurchase: null\` (the regular offer) - this is the one to use
- A game EXISTS if ANY result has \`prePurchase: null\`, even if the first result is pre-purchase

## Stay On Topic
- If a search returns results, USE those results - don't claim the game doesn't exist
- **NEVER suggest unrelated games** when the user asks about a specific game
- If you can't find a game, say "I couldn't find [game name] in the Epic Games Store" - don't pivot to free games or other suggestions
- Only suggest alternatives if the user explicitly asks for recommendations

## Unsupported Queries
These data types are NOT available - be honest about it:
- "Most played games" / player counts - NOT AVAILABLE (only have top sellers and wishlisted)
- Year-specific giveaway counts - NOT AVAILABLE (only have all-time stats)
- Real-time player numbers - NOT AVAILABLE
If user asks for unavailable data, clearly explain what IS available as an alternative.
- DISCOUNT PERCENTAGE means the price you PAY, not the discount. 80% = you pay 80% = 20% off. 25% = you pay 25% = 75% off.
- When showing prices, always lead with the CURRENT/DISCOUNTED price, with the original in parenthesis:
  - ✅ "$14.99 (originally $29.99)" or "€23.19 (originally €28.99)"
  - ❌ "originally $29.99, now $14.99"
- For free games, just call get_free_games once
- Always search first if you need an offer ID
- Include links to EGData when mentioning offers/items/sandboxes using markdown:
  - Offers: [Game Title](https://egdata.app/offers/{offerId})
  - Items: [Item Name](https://egdata.app/items/{itemId})
  - Sandboxes: [Sandbox](https://egdata.app/sandboxes/{sandboxId})
- Dates in API responses include pre-computed Unix timestamps: { _isoDate: "...", _unixTimestamp: 1767196800 }
  - Use the _unixTimestamp value directly for Discord format: <t:UNIX_TIMESTAMP:FORMAT>
  - Formats: F (full), f (short), D (date), d (short date), R (relative)
  - Example: <t:1767196800:R> for relative time like "in 3 days"

## Thread Title (IMPORTANT)
At the END of EVERY response, add a thread title in this exact format:
<thread-title>Short Topic Title</thread-title>

The title should be:
- 3-6 words summarizing what the conversation is about
- Based on the user's question and your answer
- No emoji, no quotes, just plain text
- Examples: "GTA V Price Check", "Free Games This Week", "Cyberpunk Download Size", "Top Wishlisted Games"${userContext}`;
}

// Tool for proposing to save user context (human-in-the-loop)
const proposeSaveContextTool = tool({
	description:
		"Propose saving information about the user for future conversations. Use this when the user tells you their country, language, or preferences. The user will be asked to confirm before saving.",
	inputSchema: z.object({
		country: z
			.string()
			.optional()
			.describe("User's country code (e.g., 'ES' for Spain, 'US' for USA)"),
		language: z.string().optional().describe("User's preferred language"),
		fact: z
			.string()
			.optional()
			.describe(
				"A preference or fact about the user (e.g., 'loves roguelike games')"
			),
	}),
	execute: async ({
		country,
		language,
		fact,
	}: { country?: string; language?: string; fact?: string }) => {
		const parts: string[] = [];
		if (country) parts.push(`country: ${country}`);
		if (language) parts.push(`language: ${language}`);
		if (fact) parts.push(`preference: ${fact}`);

		return {
			type: "confirmation_required",
			message: `Would you like me to remember: ${parts.join(", ")}?`,
			data: { country, language, fact },
		};
	},
});

// Message format for conversation history
interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	sessionId: string;
}

export class EGDataAgent extends DurableObject<Env> {
	// User-level state (persists across all sessions for this user)
	private userState: UserState = {
		userId: "",
		facts: [],
	};
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		// Initialize user state table
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS user_state (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);

		// Check schema version and migrate if needed
		const SCHEMA_VERSION = 2; // Increment this when schema changes
		let currentVersion = 0;
		try {
			const rows = this.sql
				.exec(`SELECT value FROM user_state WHERE key = 'schema_version'`)
				.toArray() as { value: string }[];
			if (rows.length > 0) {
				currentVersion = parseInt(rows[0].value, 10) || 0;
			}
		} catch {
			// Table might not exist yet
		}

		if (currentVersion < SCHEMA_VERSION) {
			// Drop old tables and recreate with new schema
			this.sql.exec(`DROP TABLE IF EXISTS messages`);
			this.sql.exec(`DROP TABLE IF EXISTS known_entities`);
			this.sql.exec(
				`INSERT OR REPLACE INTO user_state (key, value) VALUES ('schema_version', ?)`,
				String(SCHEMA_VERSION)
			);
		}

		// Initialize messages table (per-session context)
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			)
		`);

		// Initialize known entities table (per-session context)
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS known_entities (
				id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				title TEXT NOT NULL,
				last_used INTEGER NOT NULL,
				PRIMARY KEY (id, session_id)
			)
		`);

		// Load user state from SQL
		this.loadUserState();
	}

	// Get recent conversation history from SQL (isolated per session)
	private getConversationHistory(sessionId: string, limit = 20): ChatMessage[] {
		const rows = this.sql
			.exec(
				`SELECT id, role, content, timestamp, session_id as sessionId
				FROM messages
				WHERE session_id = ?
				ORDER BY timestamp DESC
				LIMIT ?`,
				sessionId,
				limit
			)
			.toArray() as unknown as ChatMessage[];
		return rows.reverse();
	}

	// Add message to conversation history (isolated per session)
	private addMessage(
		sessionId: string,
		role: "user" | "assistant",
		content: string
	): string {
		const id = crypto.randomUUID();
		const timestamp = Date.now();
		this.sql.exec(
			`INSERT INTO messages (id, session_id, role, content, timestamp)
			VALUES (?, ?, ?, ?, ?)`,
			id,
			sessionId,
			role,
			content,
			timestamp
		);

		// Keep only last 50 messages per session
		this.sql.exec(
			`DELETE FROM messages
			WHERE session_id = ? AND id NOT IN (
				SELECT id FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50
			)`,
			sessionId,
			sessionId
		);

		return id;
	}

	private loadUserState() {
		const rows = this.sql
			.exec(`SELECT key, value FROM user_state`)
			.toArray() as { key: string; value: string }[];
		for (const row of rows) {
			if (row.key === "country") this.userState.country = row.value;
			if (row.key === "language") this.userState.language = row.value;
			if (row.key === "userId") this.userState.userId = row.value;
			if (row.key === "facts") this.userState.facts = JSON.parse(row.value);
			if (row.key === "pendingConfirmation")
				this.userState.pendingConfirmation = JSON.parse(row.value);
		}
	}

	private saveUserState() {
		if (this.userState.country) {
			this.sql.exec(
				`INSERT OR REPLACE INTO user_state (key, value) VALUES ('country', ?)`,
				this.userState.country
			);
		}
		if (this.userState.language) {
			this.sql.exec(
				`INSERT OR REPLACE INTO user_state (key, value) VALUES ('language', ?)`,
				this.userState.language
			);
		}
		if (this.userState.userId) {
			this.sql.exec(
				`INSERT OR REPLACE INTO user_state (key, value) VALUES ('userId', ?)`,
				this.userState.userId
			);
		}
		this.sql.exec(
			`INSERT OR REPLACE INTO user_state (key, value) VALUES ('facts', ?)`,
			JSON.stringify(this.userState.facts)
		);
		if (this.userState.pendingConfirmation) {
			this.sql.exec(
				`INSERT OR REPLACE INTO user_state (key, value) VALUES ('pendingConfirmation', ?)`,
				JSON.stringify(this.userState.pendingConfirmation)
			);
		} else {
			this.sql.exec(`DELETE FROM user_state WHERE key = 'pendingConfirmation'`);
		}
	}

	// Get known entities for context (isolated per session)
	private getKnownEntities(
		sessionId: string
	): Array<{ id: string; type: string; title: string }> {
		return this.sql
			.exec(
				`SELECT id, type, title
				FROM known_entities
				WHERE session_id = ?
				ORDER BY last_used DESC
				LIMIT 5`,
				sessionId
			)
			.toArray() as Array<{ id: string; type: string; title: string }>;
	}

	// Save known entity (isolated per session)
	private saveEntity(
		sessionId: string,
		id: string,
		type: string,
		title: string
	) {
		const now = Date.now();
		this.sql.exec(
			`INSERT OR REPLACE INTO known_entities (id, session_id, type, title, last_used)
			VALUES (?, ?, ?, ?, ?)`,
			id,
			sessionId,
			type,
			title,
			now
		);
	}

	// Build entity context for system prompt (isolated per session)
	private buildEntityContext(sessionId: string): string {
		const entities = this.getKnownEntities(sessionId);
		if (entities.length === 0) return "";

		const lines = entities.map((e) => `- ${e.title} (${e.type} ID: ${e.id})`);
		return `\n\n## Known Entities (use these IDs for follow-up questions)\n${lines.join("\n")}`;
	}

	// Extract entities from tool results
	private extractAndSaveEntities(
		sessionId: string,
		toolName: string,
		result: unknown
	) {
		if (!result || typeof result !== "object") return;
		const data = result as Record<string, unknown>;

		// Handle search results
		const searchResults = data.offers || data.hits || data.elements;
		if (toolName === "search_offers" && Array.isArray(searchResults)) {
			for (const hit of searchResults.slice(0, 3)) {
				if (hit && typeof hit === "object" && "id" in hit && "title" in hit) {
					this.saveEntity(
						sessionId,
						String(hit.id),
						"offer",
						String(hit.title)
					);
				}
			}
		}

		// Handle single offer details
		if (
			(toolName === "get_offer_details" || toolName === "get_offer_price") &&
			data.id &&
			data.title
		) {
			this.saveEntity(sessionId, String(data.id), "offer", String(data.title));
		}

		// Handle offer items
		if (toolName === "get_offer_items" && Array.isArray(data)) {
			for (const item of data.slice(0, 3)) {
				if (item && typeof item === "object" && "id" in item && "title" in item) {
					this.saveEntity(
						sessionId,
						String(item.id),
						"item",
						String(item.title)
					);
				}
			}
		}
	}

	// Handle HTTP requests
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Health check
		if (url.pathname === "/health") {
			return Response.json({ status: "ok", userId: this.userState.userId });
		}

		// Confirm pending save
		if (url.pathname === "/api/confirm" && request.method === "POST") {
			return this.handleConfirm();
		}

		// Reject pending save
		if (url.pathname === "/api/reject" && request.method === "POST") {
			return this.handleReject();
		}

		// Clear conversation (session-level only)
		if (url.pathname === "/api/clear" && request.method === "POST") {
			const body = (await request.json()) as { sessionId?: string };
			const sessionId = body.sessionId || "default";
			return this.handleClear(sessionId);
		}

		// Custom streaming endpoint for Discord bot (SSE format)
		if (url.pathname === "/api/chat/stream" && request.method === "POST") {
			return this.handleChatStream(request);
		}

		// Non-streaming chat endpoint
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return this.handleChat(request);
		}

		// Unknown endpoint
		return new Response("Not found", { status: 404 });
	}

	// Handle streaming chat with SSE format for Discord bot
	private async handleChatStream(request: Request): Promise<Response> {
		const body = (await request.json()) as {
			message: string;
			sessionId?: string;
			userId?: string;
		};

		if (!body.message) {
			return Response.json({ error: "Message is required" }, { status: 400 });
		}

		const sessionId = body.sessionId || "default";

		// Build system prompt with user context and entity context
		const entityContext = this.buildEntityContext(sessionId);
		const systemPrompt = getSystemPrompt(this.userState) + entityContext;

		// All tools including the propose_save_context tool
		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
		};

		const agent = this;
		const encoder = new TextEncoder();
		const seenTools = new Set<string>();

		// Get conversation history and add user message
		const history = this.getConversationHistory(sessionId);
		this.addMessage(sessionId, "user", body.message);

		// Convert to model messages format
		const modelMessages = [
			...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
			{ role: "user" as const, content: body.message },
		];

		const stream = new ReadableStream({
			async start(controller) {
				try {
					let pendingConfirmation:
						| {
								message: string;
								data: { country?: string; language?: string; fact?: string };
						  }
						| undefined;

					const result = streamText({
						model: mistral("mistral-large-latest"),
						system: systemPrompt,
						messages: modelMessages,
						tools: allTools,
						stopWhen: stepCountIs(10),
						onStepFinish: async ({ toolCalls, toolResults }) => {
							// Send tool progress events
							if (toolCalls) {
								for (const tc of toolCalls) {
									if (!seenTools.has(tc.toolName)) {
										seenTools.add(tc.toolName);
										const description =
											TOOL_DESCRIPTIONS[tc.toolName] ||
											`Using ${tc.toolName}...`;
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify({
													type: "tool",
													tool: tc.toolName,
													message: description,
												})}\n\n`
											)
										);
									}
								}
							}

							// Extract entities and check for confirmations from tool results
							if (toolResults) {
								for (const tr of toolResults) {
									agent.extractAndSaveEntities(sessionId, tr.toolName, tr.output);

									// Check for confirmation requests
									if (tr.toolName === "propose_save_context") {
										const output = tr.output as {
											type?: string;
											message?: string;
											data?: {
												country?: string;
												language?: string;
												fact?: string;
											};
										};
										if (output?.type === "confirmation_required") {
											agent.userState.pendingConfirmation = {
												type: "save_context",
												data: output.data || {},
												message:
													output.message ||
													"Would you like me to remember this?",
											};
											agent.saveUserState();
											pendingConfirmation = {
												message:
													output.message ||
													"Would you like me to remember this?",
												data: output.data || {},
											};
										}
									}
								}
							}
						},
					});

					let fullText = "";
					for await (const chunk of result.textStream) {
						fullText += chunk;
					}

					// Send confirmation event if we have one
					if (pendingConfirmation) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									type: "confirmation_required",
									message: pendingConfirmation.message,
									data: pendingConfirmation.data,
								})}\n\n`
							)
						);
					}

					// Send complete event
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "complete", text: fullText })}\n\n`
						)
					);

					// Save assistant response
					if (fullText.trim()) {
						agent.addMessage(sessionId, "assistant", fullText);
					}

					controller.close();
				} catch (error) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								type: "error",
								message:
									error instanceof Error ? error.message : "Unknown error",
							})}\n\n`
						)
					);
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	// Handle non-streaming chat
	private async handleChat(request: Request): Promise<Response> {
		const body = (await request.json()) as {
			message: string;
			sessionId?: string;
			userId?: string;
		};

		if (!body.message) {
			return Response.json({ error: "Message is required" }, { status: 400 });
		}

		const sessionId = body.sessionId || "default";

		// Build system prompt with user context and entity context
		const entityContext = this.buildEntityContext(sessionId);
		const systemPrompt = getSystemPrompt(this.userState) + entityContext;

		// All tools including the propose_save_context tool
		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
		};

		// Get conversation history and add user message
		const history = this.getConversationHistory(sessionId);
		this.addMessage(sessionId, "user", body.message);

		// Convert to model messages format
		const modelMessages = [
			...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
			{ role: "user" as const, content: body.message },
		];

		try {
			const { generateText } = await import("ai");
			const result = await generateText({
				model: mistral("mistral-small-latest"),
				system: systemPrompt,
				messages: modelMessages,
				tools: allTools,
				stopWhen: stepCountIs(10),
			});

			const responseText = result.text;

			// Extract entities from tool results
			for (const step of result.steps) {
				if (step.toolResults) {
					for (const tr of step.toolResults) {
						this.extractAndSaveEntities(
							sessionId,
							tr.toolName,
							tr.output
						);
					}
				}
			}

			// Save assistant response
			if (responseText.trim()) {
				this.addMessage(sessionId, "assistant", responseText);
			}

			return new Response(responseText, {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		} catch (error) {
			console.error("Chat error:", error);
			return Response.json(
				{ error: error instanceof Error ? error.message : "Unknown error" },
				{ status: 500 }
			);
		}
	}

	// Handle confirmation of pending save
	private handleConfirm(): Response {
		const pending = this.userState.pendingConfirmation;

		if (!pending || pending.type !== "save_context") {
			return Response.json({ error: "No pending confirmation" }, { status: 400 });
		}

		const { country, language, fact } = pending.data;

		if (country) this.userState.country = country;
		if (language) this.userState.language = language;
		if (fact) {
			if (!this.userState.facts.includes(fact)) {
				this.userState.facts.push(fact);
				if (this.userState.facts.length > 10) {
					this.userState.facts = this.userState.facts.slice(-10);
				}
			}
		}

		this.userState.pendingConfirmation = undefined;
		this.saveUserState();

		return Response.json({
			success: true,
			message: "Got it! I'll remember that for our future conversations.",
			saved: { country, language, fact },
		});
	}

	// Handle rejection of pending save
	private handleReject(): Response {
		this.userState.pendingConfirmation = undefined;
		this.saveUserState();
		return Response.json({
			success: true,
			message: "No problem, I won't save that.",
		});
	}

	// Handle clearing conversation (only clears session-level context, not user preferences)
	private handleClear(sessionId: string): Response {
		// Clear messages for this session
		this.sql.exec(`DELETE FROM messages WHERE session_id = ?`, sessionId);
		// Clear known entities for this session
		this.sql.exec(`DELETE FROM known_entities WHERE session_id = ?`, sessionId);
		return Response.json({ success: true });
	}
}

