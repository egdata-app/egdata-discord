import { DurableObject } from "cloudflare:workers";
import { streamText, generateText, stepCountIs, tool } from "ai";
import { mistral } from "@ai-sdk/mistral";
import { z } from "zod";
import { egdataTools } from "./tools";

// Agent state persisted across requests
interface AgentState {
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

// Message format for conversation history
interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

// Human-readable tool names for progress updates
const TOOL_DESCRIPTIONS: Record<string, string> = {
	search_offers: "Searching for games...",
	get_offer_details: "Getting game details...",
	get_offer_price: "Checking current price...",
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
	get_item_assets: "Checking download size...",
	propose_save_context: "Preparing to remember...",
};

// Generate system prompt with current date and user context
function getSystemPrompt(state: AgentState): string {
	const now = new Date();
	const dateStr = now.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	let userContext = "";
	const contextParts: string[] = [];
	if (state.country) contextParts.push(`- User's country: ${state.country} (use this for pricing) - ALREADY SAVED, don't propose saving again`);
	if (state.language) contextParts.push(`- User's preferred language: ${state.language} - ALREADY SAVED, don't propose saving again`);
	if (state.facts.length > 0) contextParts.push(`- Things user has shared: ${state.facts.join("; ")} - ALREADY SAVED`);
	if (state.pendingConfirmation) {
		contextParts.push(`- PENDING CONFIRMATION: ${state.pendingConfirmation.message} - DO NOT propose saving the same info again, wait for user to confirm/reject`);
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
→ Step 2: get_offer_items(offerId: "...") → get item IDs (executables)
→ Step 3: get_item_assets(itemId: "...") → get downloadSizeBytes and installedSizeBytes per platform
→ Convert bytes to GB: divide by 1,073,741,824 (or 1024³)

## Your tools
- search_offers: Find games by name (returns offer IDs)
- get_offer_details: Get game info (needs offer ID)
- get_offer_price: Current price (needs offer ID)
- get_offer_price_history: Historical prices (needs offer ID)
- get_offer_items: Get items/executables for an offer (needs offer ID)
- get_item_assets: Get download/install sizes per platform (needs item ID) - USE THIS FOR SIZE QUESTIONS
- get_free_games: Current free games (no ID needed)
- get_free_games_history: Recent past giveaways (PAGINATED - can't count totals per year!)
- get_free_games_stats: ALL-TIME stats since 2018 (total count & value, NOT year-specific)
- get_top_sellers, get_top_wishlisted: Charts (no ID needed)
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

## Guidelines
- **BE EFFICIENT**: Only call the tools needed to answer the question. Don't call extra tools.
  - Price question → search_offers + get_offer_price (NOT get_offer_items, get_item_assets)
  - Download size question → search_offers + get_offer_items + get_item_assets
  - Game info question → search_offers + get_offer_details
- **ONE GAME PER QUESTION**: When user asks about a specific game, only show info for THAT game.
  - "God of War 1" or "God of War" → only the 2018 God of War game, NOT Ragnarok or soundtracks
  - Pick the best matching result from search, don't list multiple games unless asked
- **propose_save_context**: ONLY use when user EXPLICITLY shares NEW personal info (says "I'm from Spain", "I prefer Spanish", etc.)
  - NEVER call if you already know their country from User Context above
  - NEVER call if there's a PENDING CONFIRMATION
  - NEVER infer country from price queries - only save if user explicitly tells you
  - If user just asks for a price and you show it in their local currency, that's fine - don't ask to save
- ALL PRICES in the API are in CENTS (including totals/stats). ALWAYS divide by 100:
  - 1999 → $19.99
  - 5999 → $59.99
  - 1144566 → $11,445.66 (NOT $1,144,566!)
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
		country: z.string().optional().describe("User's country code (e.g., 'ES' for Spain, 'US' for USA)"),
		language: z.string().optional().describe("User's preferred language"),
		fact: z.string().optional().describe("A preference or fact about the user (e.g., 'loves roguelike games')"),
	}),
	execute: async ({ country, language, fact }: { country?: string; language?: string; fact?: string }) => {
		// This doesn't actually save - it returns a proposal for the user to confirm
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

export class EGDataAgent extends DurableObject<Env> {
	private state: AgentState;
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		// Initialize state from storage or use defaults
		this.state = {
			userId: "",
			facts: [],
		};

		// Initialize SQL tables
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			)
		`);

		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS known_entities (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				title TEXT NOT NULL,
				last_used INTEGER NOT NULL
			)
		`);

		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS user_state (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);

		// Load state from SQL
		this.loadState();
	}

	private loadState() {
		const rows = this.sql.exec("SELECT key, value FROM user_state").toArray();
		for (const row of rows) {
			const key = row.key as string;
			const value = row.value as string;
			if (key === "country") this.state.country = value;
			if (key === "language") this.state.language = value;
			if (key === "userId") this.state.userId = value;
			if (key === "facts") this.state.facts = JSON.parse(value);
			if (key === "pendingConfirmation") this.state.pendingConfirmation = JSON.parse(value);
		}
	}

	private saveState() {
		if (this.state.country) {
			this.sql.exec("INSERT OR REPLACE INTO user_state (key, value) VALUES ('country', ?)", this.state.country);
		}
		if (this.state.language) {
			this.sql.exec("INSERT OR REPLACE INTO user_state (key, value) VALUES ('language', ?)", this.state.language);
		}
		if (this.state.userId) {
			this.sql.exec("INSERT OR REPLACE INTO user_state (key, value) VALUES ('userId', ?)", this.state.userId);
		}
		this.sql.exec("INSERT OR REPLACE INTO user_state (key, value) VALUES ('facts', ?)", JSON.stringify(this.state.facts));
		if (this.state.pendingConfirmation) {
			this.sql.exec("INSERT OR REPLACE INTO user_state (key, value) VALUES ('pendingConfirmation', ?)", JSON.stringify(this.state.pendingConfirmation));
		} else {
			this.sql.exec("DELETE FROM user_state WHERE key = 'pendingConfirmation'");
		}
	}

	// Handle HTTP requests
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Health check
		if (url.pathname === "/health") {
			return Response.json({ status: "ok", userId: this.state.userId });
		}

		// Confirm pending save
		if (url.pathname === "/api/confirm" && request.method === "POST") {
			return this.handleConfirm(request);
		}

		// Reject pending save
		if (url.pathname === "/api/reject" && request.method === "POST") {
			return this.handleReject();
		}

		// Clear conversation
		if (url.pathname === "/api/clear" && request.method === "POST") {
			return this.handleClear();
		}

		// Chat endpoint (streaming)
		if (url.pathname === "/api/chat/stream" && request.method === "POST") {
			return this.handleChatStream(request);
		}

		// Chat endpoint (non-streaming)
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return this.handleChat(request);
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}

	// Get recent conversation history from SQL
	private getConversationHistory(limit = 10): ChatMessage[] {
		const rows = this.sql.exec(`
			SELECT role, content, timestamp
			FROM messages
			ORDER BY timestamp DESC
			LIMIT ?
		`, limit).toArray();
		return rows.reverse().map(row => ({
			role: row.role as "user" | "assistant",
			content: row.content as string,
			timestamp: row.timestamp as number,
		}));
	}

	// Add message to conversation history
	private addMessage(role: "user" | "assistant", content: string) {
		const timestamp = Date.now();
		this.sql.exec(`
			INSERT INTO messages (role, content, timestamp)
			VALUES (?, ?, ?)
		`, role, content, timestamp);

		// Keep only last 50 messages
		this.sql.exec(`
			DELETE FROM messages
			WHERE id NOT IN (
				SELECT id FROM messages ORDER BY timestamp DESC LIMIT 50
			)
		`);
	}

	// Get known entities for context
	private getKnownEntities(): Array<{ id: string; type: string; title: string }> {
		const rows = this.sql.exec(`
			SELECT id, type, title
			FROM known_entities
			ORDER BY last_used DESC
			LIMIT 5
		`).toArray();
		return rows.map(row => ({
			id: row.id as string,
			type: row.type as string,
			title: row.title as string,
		}));
	}

	// Save known entity
	private saveEntity(id: string, type: string, title: string) {
		const now = Date.now();
		this.sql.exec(`
			INSERT OR REPLACE INTO known_entities (id, type, title, last_used)
			VALUES (?, ?, ?, ?)
		`, id, type, title, now);
	}

	// Build entity context for system prompt
	private buildEntityContext(): string {
		const entities = this.getKnownEntities();
		if (entities.length === 0) return "";

		const lines = entities.map((e) => `- ${e.title} (${e.type} ID: ${e.id})`);
		return `\n\n## Known Entities (use these IDs for follow-up questions)\n${lines.join("\n")}`;
	}

	// Extract entities from tool results
	private extractAndSaveEntities(toolName: string, result: unknown) {
		if (!result || typeof result !== "object") return;
		const data = result as Record<string, unknown>;

		// Handle search results
		const searchResults = data.offers || data.hits || data.elements;
		if (toolName === "search_offers" && Array.isArray(searchResults)) {
			for (const hit of searchResults.slice(0, 3)) {
				if (hit && typeof hit === "object" && "id" in hit && "title" in hit) {
					this.saveEntity(String(hit.id), "offer", String(hit.title));
				}
			}
		}

		// Handle single offer details
		if ((toolName === "get_offer_details" || toolName === "get_offer_price") && data.id && data.title) {
			this.saveEntity(String(data.id), "offer", String(data.title));
		}

		// Handle offer items
		if (toolName === "get_offer_items" && Array.isArray(data)) {
			for (const item of data.slice(0, 3)) {
				if (item && typeof item === "object" && "id" in item && "title" in item) {
					this.saveEntity(String(item.id), "item", String(item.title));
				}
			}
		}
	}

	// Handle streaming chat
	private async handleChatStream(request: Request): Promise<Response> {
		const body = (await request.json()) as { message: string; userId?: string };

		if (!body.message) {
			return Response.json({ error: "Message is required" }, { status: 400 });
		}

		// Set userId if provided
		if (body.userId && !this.state.userId) {
			this.state.userId = body.userId;
			this.saveState();
		}

		// Get conversation history and add user message
		const history = this.getConversationHistory();
		this.addMessage("user", body.message);

		// Build system prompt with context
		const entityContext = this.buildEntityContext();
		const systemPrompt = getSystemPrompt(this.state) + entityContext;

		// Prepare messages for AI
		const messages = [
			...history.map((m) => ({ role: m.role, content: m.content })),
			{ role: "user" as const, content: body.message },
		];

		// All tools including the propose_save_context tool
		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
		};

		const encoder = new TextEncoder();
		const agent = this;

		const stream = new ReadableStream({
			async start(controller) {
				try {
					const seenTools = new Set<string>();

					const result = streamText({
						model: mistral("mistral-small-latest"),
						system: systemPrompt,
						messages,
						tools: allTools,
						stopWhen: stepCountIs(10),
						onChunk: ({ chunk }) => {
							if (chunk.type === "tool-call") {
								const toolName = chunk.toolName;
								if (!seenTools.has(toolName)) {
									seenTools.add(toolName);
									const description = TOOL_DESCRIPTIONS[toolName] || `Using ${toolName}...`;
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify({ type: "tool", tool: toolName, message: description })}\n\n`
										)
									);
								}
							}
							if (chunk.type === "tool-result") {
								const tr = chunk as { toolName: string; result?: unknown };
								agent.extractAndSaveEntities(tr.toolName, tr.result);
							}
						},
					});

					let fullText = "";
					for await (const chunk of result.textStream) {
						fullText += chunk;
					}

				// Extract entities and check for confirmations from tool results
					let pendingConfirmation: { message: string; data: { country?: string; language?: string; fact?: string } } | undefined;
					try {
						const steps = await result.steps;
						for (const step of steps) {
							const stepObj = step as unknown as Record<string, unknown>;
							const stepToolResults = stepObj.toolResults as unknown[] | undefined;

							if (stepToolResults) {
								for (const tr of stepToolResults) {
									const typedResult = tr as {
										toolName?: string;
										result?: unknown;
										output?: {
											type?: string;
											message?: string;
											data?: { country?: string; language?: string; fact?: string };
										};
									};

									// Extract entities from tool results (for follow-up context)
									if (typedResult.toolName && typedResult.result) {
										agent.extractAndSaveEntities(typedResult.toolName, typedResult.result);
									}

									// Check for confirmation requests
									if (
										typedResult.toolName === "propose_save_context" &&
										typedResult.output &&
										typedResult.output.type === "confirmation_required"
									) {
										const confirmOutput = typedResult.output;
										agent.state.pendingConfirmation = {
											type: "save_context",
											data: confirmOutput.data || {},
											message: confirmOutput.message || "Would you like me to remember this?",
										};
										agent.saveState();
										pendingConfirmation = {
											message: confirmOutput.message || "Would you like me to remember this?",
											data: confirmOutput.data || {},
										};
										console.log("Found confirmation request:", confirmOutput);
									}
								}
							}
						}
					} catch (e) {
						console.error("Error reading tool results:", e);
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

					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify({ type: "complete", text: fullText })}\n\n`)
					);

					if (fullText.trim()) {
						agent.addMessage("assistant", fullText);
					}

					controller.close();
				} catch (error) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Unknown error" })}\n\n`
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
		const body = (await request.json()) as { message: string; userId?: string };

		if (!body.message) {
			return Response.json({ error: "Message is required" }, { status: 400 });
		}

		if (body.userId && !this.state.userId) {
			this.state.userId = body.userId;
			this.saveState();
		}

		const history = this.getConversationHistory();
		this.addMessage("user", body.message);

		const entityContext = this.buildEntityContext();
		const systemPrompt = getSystemPrompt(this.state) + entityContext;

		const messages = [
			...history.map((m) => ({ role: m.role, content: m.content })),
			{ role: "user" as const, content: body.message },
		];

		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
		};

		try {
			const result = await generateText({
				model: mistral("mistral-small-latest"),
				system: systemPrompt,
				messages,
				tools: allTools,
				stopWhen: stepCountIs(10),
			});

			const responseText = result.text;

			// Extract entities from tool results
			for (const step of result.steps) {
				if (step.toolResults) {
					for (const toolResult of step.toolResults) {
						const tr = toolResult as { toolName: string; result?: unknown };
						this.extractAndSaveEntities(tr.toolName, tr.result);
					}
				}
			}

			if (responseText.trim()) {
				this.addMessage("assistant", responseText);
			}

			return new Response(responseText, {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		} catch (error) {
			console.error("Chat error:", error);
			return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
		}
	}

	// Handle confirmation of pending save
	private async handleConfirm(request: Request): Promise<Response> {
		const pending = this.state.pendingConfirmation;

		if (!pending || pending.type !== "save_context") {
			return Response.json({ error: "No pending confirmation" }, { status: 400 });
		}

		const { country, language, fact } = pending.data;
		const newState = { ...this.state, pendingConfirmation: undefined };

		if (country) newState.country = country;
		if (language) newState.language = language;
		if (fact) {
			newState.facts = [...this.state.facts];
			if (!newState.facts.includes(fact)) {
				newState.facts.push(fact);
				if (newState.facts.length > 10) {
					newState.facts = newState.facts.slice(-10);
				}
			}
		}

		this.state = newState;
		this.saveState();

		return Response.json({
			success: true,
			message: "Got it! I'll remember that for our future conversations.",
			saved: { country, language, fact },
		});
	}

	// Handle rejection of pending save
	private handleReject(): Response {
		this.state.pendingConfirmation = undefined;
		this.saveState();
		return Response.json({
			success: true,
			message: "No problem, I won't save that.",
		});
	}

	// Handle clearing conversation
	private handleClear(): Response {
		this.sql.exec("DELETE FROM messages");
		this.sql.exec("DELETE FROM known_entities");
		return Response.json({ success: true });
	}
}
