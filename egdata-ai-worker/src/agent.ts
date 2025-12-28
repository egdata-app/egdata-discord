import {
	Agent,
	type Connection,
	type ConnectionContext,
	routeAgentRequest,
	getAgentByName,
} from "agents";

// Re-export for use in index.ts
export { routeAgentRequest, getAgentByName };
import { streamText, generateText, tool, stepCountIs } from "ai";
import {
	google,
	type GoogleGenerativeAIProviderOptions,
} from "@ai-sdk/google";
import { z } from "zod";
import { egdataTools } from "./tools";
import type {
	ClientMessage,
	AgentMessage,
	PendingQuestion,
} from "./websocket-types";

// User-level state persisted across all conversations (managed by Agent.state)
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

// Initial state for new agents
const initialState: UserState = {
	userId: "",
	facts: [],
};

// Dynamic tool descriptions based on arguments
type ToolArgs = Record<string, unknown>;

function getToolDescription(toolName: string, args: ToolArgs): string {
	// Helper to truncate long strings
	const truncate = (s: string, max = 30) =>
		s.length > max ? s.slice(0, max - 1) + "…" : s;

	// Helper to get query/title from args
	const query = args.query as string | undefined;
	const offerId = args.offerId as string | undefined;
	const count = args.count as number | undefined;
	const page = args.page as number | undefined;

	switch (toolName) {
		// Search tools - show what's being searched
		case "search_offers":
			return query
				? `Searching "${truncate(query)}"...`
				: "Searching games...";
		case "search_sellers":
			return query
				? `Finding publisher "${truncate(query)}"...`
				: "Searching publishers...";
		case "search_items":
			return query
				? `Searching items "${truncate(query)}"...`
				: "Searching items...";

		// Single offer tools - could show ID prefix
		case "get_offer_details":
			return offerId
				? `Loading details [${offerId.slice(0, 8)}...]`
				: "Getting game details...";
		case "get_offer_price":
			return offerId
				? `Checking price [${offerId.slice(0, 8)}...]`
				: "Checking price...";
		case "get_offer_price_history":
			return "Loading price history...";
		case "get_offer_achievements":
			return "Loading achievements...";
		case "get_offer_reviews_summary":
			return "Checking reviews...";
		case "get_offer_hltb":
			return "Getting playtime estimates...";
		case "get_offer_related":
			return "Finding related games...";
		case "get_offer_items":
			return "Getting downloadable files...";
		case "get_item_assets":
			return "Checking download size...";

		// Batch tools - show count
		case "get_offers_details": {
			const ids = args.offerIds as string[] | undefined;
			return ids?.length
				? `Loading ${ids.length} game details...`
				: "Getting details for multiple games...";
		}
		case "get_offer_prices": {
			const ids = args.offerIds as string[] | undefined;
			return ids?.length
				? `Fetching ${ids.length} prices...`
				: "Fetching prices...";
		}
		case "get_offers_items": {
			const ids = args.offerIds as string[] | undefined;
			return ids?.length
				? `Getting items for ${ids.length} games...`
				: "Getting items...";
		}
		case "get_items_assets": {
			const ids = args.itemIds as string[] | undefined;
			return ids?.length
				? `Checking ${ids.length} download sizes...`
				: "Checking download sizes...";
		}

		// Top lists - show count if specified
		case "get_top_sellers":
			return count
				? `Finding top ${count} sellers...`
				: "Checking top sellers...";
		case "get_top_wishlisted":
			return count
				? `Finding top ${count} wishlisted...`
				: "Checking most wishlisted...";

		// Free games
		case "get_free_games":
			return "Finding current free games...";
		case "get_free_games_history":
			return page && page > 1
				? `Loading giveaway history (page ${page})...`
				: "Loading giveaway history...";
		case "get_free_games_stats":
			return "Calculating giveaway stats...";
		case "get_top_giveaway_publishers": {
			const pubQuery = args.query as string | undefined;
			return pubQuery
				? `Finding "${truncate(pubQuery)}" giveaways...`
				: "Ranking giveaway publishers...";
		}

		// Other
		case "get_featured_discounts":
			return "Finding current deals...";
		case "get_upcoming_games":
			return page && page > 1
				? `Checking upcoming (page ${page})...`
				: "Checking upcoming releases...";
		case "get_latest_releases":
			return page && page > 1
				? `Checking releases (page ${page})...`
				: "Checking latest releases...";
		case "get_promotions":
			return "Checking active promotions...";
		case "get_store_stats":
			return "Getting store statistics...";

		// Human-in-the-loop
		case "propose_save_context":
			return "Preparing to remember...";
		case "ask_user":
			return "Waiting for your response...";

		default:
			return `Using ${toolName}...`;
	}
}

// Generate system prompt with current date and user context
function getSystemPrompt(userState: UserState, hasAskUser: boolean): string {
	const now = new Date();
	const dateStr = now.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	});

	// Build user context section
	const contextParts: string[] = [];
	if (userState.country)
		contextParts.push(`- Country: "${userState.country}" (USE IN ALL price/region tool calls)`);
	if (userState.language)
		contextParts.push(`- Language: "${userState.language}"`);
	if (userState.facts.length > 0)
		contextParts.push(`- Facts: ${userState.facts.join("; ")}`);
	if (userState.pendingConfirmation)
		contextParts.push(`- PENDING: ${userState.pendingConfirmation.message}`);

	const userContext = contextParts.length > 0
		? `\n## User Context\n${contextParts.join("\n")}\n`
		: "";

	const askUserSection = hasAskUser
		? `\n## Clarification (ask_user)\nUse ONLY when truly ambiguous: "God of War" (2018 or Ragnarök?), vague preferences ("cheap game" → ask genre/budget).\n`
		: "";

	// Optimized prompt: context first, then guidelines, strict rules at END (Gemini anchors on final instructions)
	return `You are EGData AI, an Epic Games Store assistant.
**Current: ${dateStr}**
${userContext}
## Core Rules
- **Data First**: No internal knowledge. Only use tool results.
- **Silent Execution**: No narration ("Let me check..."). Output final answer only.
- **Parallel Calls**: When comparing multiple games, call tools for ALL games simultaneously in ONE step.

## Key Concepts
- **Offer** = Store page (prices, details, requirements). Tools: \`search_offers\`, \`get_offer_details\`, \`get_offer_price\`
- **Item** = Downloadable file (sizes). Tools: \`get_offer_items\` → \`get_item_assets\`
- **Regional Availability**: \`countriesBlacklist\` = countries where game is UNAVAILABLE (banned/restricted). \`countriesWhitelist\` = if set, ONLY these countries can access. If whitelist is null and blacklist exists, game is available everywhere EXCEPT blacklisted countries.

## Efficient Tool Usage
- **Multiple games?** Use batch tools: \`get_offer_prices\`, \`get_offers_details\`, \`get_offers_items\`
- **Top sellers/wishlisted with prices?** Call \`get_top_sellers\` then \`get_offer_prices\` with all IDs
- **Pagination**: Tools return ~10 results. For "Top 20", call with page=1 AND page=2 in parallel.
${askUserSection}
## Output Format
- **Prices**: **$14.99** ~~$59.99~~ (-75%) — discounted first
- **Dates**: Use Discord timestamps: <t:1735480000:R> (renders as "in 2 days")
- **Tables**: MUST be in code blocks (Discord doesn't render markdown tables)

## Limitations
- No real-time player counts
- Cannot check user's library/inventory
- HowLongToBeat estimates only (no actual playtime)

## STRICT RULES (NEVER BREAK)
1. **Regional Pricing**: If user country is set, ALWAYS pass it to price tools. Never default to US.
2. **Ignore Pre-Purchase**: Skip offers with \`prePurchase: true\` if a released version exists.
3. **No Manual Math**: Use pre-formatted price strings from API, never calculate discounts.
4. **Thread Title**: ALWAYS end response with \`<thread-title>Short Title</thread-title>\`
5. **Tables in Code Blocks**: \`\`\`markdown tables\`\`\` or they break in Discord.

<thread-title>Example Title</thread-title>`;
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

export class EGDataAgent extends Agent<Env, UserState> {
	// Initial state for new agents
	initialState: UserState = initialState;

	// Pending questions waiting for user response (keyed by requestId)
	private pendingQuestions = new Map<string, PendingQuestion>();

	// Active connections (keyed by sessionId)
	private activeConnections = new Map<string, Connection>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// Initialize messages table (per-session context)
		this.sql`
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			)
		`;

		// Initialize known entities table (per-session context)
		this.sql`
			CREATE TABLE IF NOT EXISTS known_entities (
				id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				title TEXT NOT NULL,
				last_used INTEGER NOT NULL,
				PRIMARY KEY (id, session_id)
			)
		`;
	}

	// ==========================================================================
	// WebSocket Handlers (using Agents SDK Connection type)
	// ==========================================================================

	// Handle new WebSocket connection
	override onConnect(connection: Connection, ctx: ConnectionContext): void {
		// Extract session ID from query params
		const url = new URL(ctx.request.url);
		const sessionId = url.searchParams.get("sessionId") || "default";
		this.activeConnections.set(sessionId, connection);
		console.log(`WebSocket connected: ${sessionId}`);
	}

	// Handle incoming WebSocket message
	override async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") {
			return; // Only handle string messages
		}

		try {
			const data = JSON.parse(message) as ClientMessage;

			switch (data.type) {
				case "chat":
					await this.handleWebSocketChat(connection, data.message, data.sessionId);
					break;

				case "user_response":
					this.handleUserResponse(data.requestId, data.response);
					break;

				default:
					this.sendToConnection(connection, {
						type: "error",
						message: `Unknown message type: ${(data as { type: string }).type}`,
					});
			}
		} catch (error) {
			console.error("WebSocket message error:", error);
			this.sendToConnection(connection, {
				type: "error",
				message: error instanceof Error ? error.message : "Invalid message",
			});
		}
	}

	// Handle WebSocket close
	override onClose(connection: Connection): void {
		// Remove from active connections
		for (const [sessionId, conn] of this.activeConnections.entries()) {
			if (conn.id === connection.id) {
				this.activeConnections.delete(sessionId);
				console.log(`WebSocket disconnected: ${sessionId}`);
				break;
			}
		}

		// Reject any pending questions for this connection
		for (const [requestId, pending] of this.pendingQuestions.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("WebSocket disconnected"));
			this.pendingQuestions.delete(requestId);
		}
	}

	// Send message via Connection
	private sendToConnection(connection: Connection, message: AgentMessage): void {
		connection.send(JSON.stringify(message));
	}

	// Handle user response to a pending question
	private handleUserResponse(requestId: string, response: string): void {
		const pending = this.pendingQuestions.get(requestId);
		if (pending) {
			clearTimeout(pending.timeout);
			pending.resolve(response);
			this.pendingQuestions.delete(requestId);
		}
	}

	// Create ask_user tool for a specific connection
	private createAskUserTool(connection: Connection) {
		const agent = this;
		type ToolOptions = { abortSignal?: AbortSignal };

		return tool({
			description:
				"Ask the user a clarifying question and wait for their response. Use sparingly - only when the request is truly ambiguous. Returns the user's response as a string.",
			inputSchema: z.object({
				question: z.string().describe("The question to ask the user"),
				options: z
					.array(z.string())
					.optional()
					.describe(
						'Predefined options for the user to choose from (e.g., ["God of War (2018)", "God of War Ragnarök"]). If not provided, defaults to yes/no.'
					),
				allowText: z
					.boolean()
					.optional()
					.describe(
						"If true, allow free text input in addition to predefined options"
					),
			}),
			execute: async (
				{ question, options, allowText },
				_options: ToolOptions
			) => {
				const requestId = crypto.randomUUID();
				const timeoutMs = 60000; // 60 second timeout

				// Send question to client
				agent.sendToConnection(connection, {
					type: "ask_user",
					requestId,
					question,
					options: options || ["Yes", "No"],
					allowText: allowText ?? false,
					timeout: timeoutMs,
				});

				// Wait for response with timeout
				const response = await new Promise<string>((resolve, reject) => {
					const timeout = setTimeout(() => {
						agent.pendingQuestions.delete(requestId);
						reject(new Error("User did not respond in time (60s timeout)"));
					}, timeoutMs);

					agent.pendingQuestions.set(requestId, {
						requestId,
						question,
						options,
						allowText,
						resolve,
						reject,
						timeout,
					});
				});

				return { userResponse: response };
			},
		});
	}

	// Handle chat via WebSocket (with ask_user support)
	private async handleWebSocketChat(
		connection: Connection,
		message: string,
		sessionId: string
	): Promise<void> {
		// Build system prompt with ask_user enabled
		const entityContext = this.buildEntityContext(sessionId);
		const systemPrompt = getSystemPrompt(this.state, true) + entityContext;

		// All tools including ask_user
		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
			ask_user: this.createAskUserTool(connection),
		};

		// Get conversation history and add user message
		const history = this.getConversationHistory(sessionId);
		this.addMessage(sessionId, "user", message);

		// Convert to model messages format
		const modelMessages = [
			...history.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
			{ role: "user" as const, content: message },
		];

		const seenTools = new Set<string>();
		const agent = this;

		try {
			const result = streamText({
				model: google("gemini-3-flash-preview"),
				system: systemPrompt,
				messages: modelMessages,
				tools: allTools,
				stopWhen: stepCountIs(15),
				// Gemini 3 thinking for better multi-step reasoning
				providerOptions: {
					google: {
						thinkingConfig: {
							thinkingLevel: "low", // Balance between speed and reasoning quality
						},
					} satisfies GoogleGenerativeAIProviderOptions,
				},
				// toolChoice: 'required' forces tool use - not needed as model handles this well
				onStepFinish: async ({ toolCalls, toolResults }) => {
					// Send tool progress events with dynamic descriptions
					if (toolCalls) {
						for (const tc of toolCalls) {
							if (!seenTools.has(tc.toolName)) {
								seenTools.add(tc.toolName);
								// Access args from the tool call (may be 'args' or 'input' depending on SDK version)
								const toolArgs =
									"args" in tc
										? (tc.args as ToolArgs)
										: "input" in tc
											? (tc.input as ToolArgs)
											: {};
								const description = getToolDescription(tc.toolName, toolArgs);
								agent.sendToConnection(connection, {
									type: "tool_progress",
									tool: tc.toolName,
									message: description,
								});
							}
						}
					}

					// Extract entities from tool results
					if (toolResults) {
						for (const tr of toolResults) {
							agent.extractAndSaveEntities(sessionId, tr.toolName, tr.output);

							// Check for confirmation requests (propose_save_context)
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
									agent.updateState({
										pendingConfirmation: {
											type: "save_context",
											data: output.data || {},
											message:
												output.message || "Would you like me to remember this?",
										},
									});
								}
							}
						}
					}
				},
			});

			let fullText = "";
			for await (const chunk of result.textStream) {
				fullText += chunk;
				// Send text deltas for real-time display
				this.sendToConnection(connection, { type: "text_delta", text: chunk });
			}

			// Send complete event
			this.sendToConnection(connection, { type: "complete", text: fullText });

			// Save assistant response
			if (fullText.trim()) {
				this.addMessage(sessionId, "assistant", fullText);
			}
		} catch (error) {
			console.error("WebSocket chat error:", error);
			this.sendToConnection(connection, {
				type: "error",
				message: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// ==========================================================================
	// Database Helpers
	// ==========================================================================

	private getConversationHistory(sessionId: string, limit = 20): ChatMessage[] {
		const rows = this.sql<ChatMessage>`
			SELECT id, role, content, timestamp, session_id as sessionId
			FROM messages
			WHERE session_id = ${sessionId}
			ORDER BY timestamp DESC
			LIMIT ${limit}
		`;
		return [...rows].reverse();
	}

	private addMessage(
		sessionId: string,
		role: "user" | "assistant",
		content: string
	): string {
		const id = crypto.randomUUID();
		const timestamp = Date.now();
		this.sql`
			INSERT INTO messages (id, session_id, role, content, timestamp)
			VALUES (${id}, ${sessionId}, ${role}, ${content}, ${timestamp})
		`;

		// Keep only last 50 messages per session
		this.sql`
			DELETE FROM messages
			WHERE session_id = ${sessionId} AND id NOT IN (
				SELECT id FROM messages WHERE session_id = ${sessionId} ORDER BY timestamp DESC LIMIT 50
			)
		`;

		return id;
	}

	private updateState(updates: Partial<UserState>) {
		this.setState({
			...this.state,
			...updates,
		});
	}

	private getKnownEntities(
		sessionId: string
	): Array<{ id: string; type: string; title: string }> {
		return this.sql<{ id: string; type: string; title: string }>`
			SELECT id, type, title
			FROM known_entities
			WHERE session_id = ${sessionId}
			ORDER BY last_used DESC
			LIMIT 5
		`;
	}

	private saveEntity(
		sessionId: string,
		id: string,
		type: string,
		title: string
	) {
		const now = Date.now();
		this.sql`
			INSERT OR REPLACE INTO known_entities (id, session_id, type, title, last_used)
			VALUES (${id}, ${sessionId}, ${type}, ${title}, ${now})
		`;
	}

	private buildEntityContext(sessionId: string): string {
		const entities = this.getKnownEntities(sessionId);
		if (entities.length === 0) return "";

		const lines = entities.map((e) => `- ${e.title} (${e.type} ID: ${e.id})`);
		return `\n\n## Known Entities (use these IDs for follow-up questions)\n${lines.join("\n")}`;
	}

	private extractAndSaveEntities(
		sessionId: string,
		toolName: string,
		result: unknown
	) {
		if (!result || typeof result !== "object") return;
		const data = result as Record<string, unknown>;

		const searchResults = data.offers || data.hits || data.elements;
		if (toolName === "search_offers" && Array.isArray(searchResults)) {
			for (const hit of searchResults.slice(0, 3)) {
				if (hit && typeof hit === "object" && "id" in hit && "title" in hit) {
					this.saveEntity(sessionId, String(hit.id), "offer", String(hit.title));
				}
			}
		}

		if (
			(toolName === "get_offer_details" || toolName === "get_offer_price") &&
			data.id &&
			data.title
		) {
			this.saveEntity(sessionId, String(data.id), "offer", String(data.title));
		}

		if (toolName === "get_offer_items" && Array.isArray(data)) {
			for (const item of data.slice(0, 3)) {
				if (item && typeof item === "object" && "id" in item && "title" in item) {
					this.saveEntity(sessionId, String(item.id), "item", String(item.title));
				}
			}
		}
	}

	// ==========================================================================
	// HTTP Handlers (kept for backward compatibility)
	// Note: WebSocket upgrades are handled automatically by the Agents SDK
	// ==========================================================================

	override async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Health check
		if (url.pathname === "/health") {
			return Response.json({ status: "ok", userId: this.state.userId });
		}

		// Confirm pending save
		if (url.pathname === "/api/confirm" && request.method === "POST") {
			return this.handleConfirm();
		}

		// Reject pending save
		if (url.pathname === "/api/reject" && request.method === "POST") {
			return this.handleReject();
		}

		// Clear conversation
		if (url.pathname === "/api/clear" && request.method === "POST") {
			const body = (await request.json()) as { sessionId?: string };
			const sessionId = body.sessionId || "default";
			return this.handleClear(sessionId);
		}

		// SSE streaming endpoint (no ask_user support)
		if (url.pathname === "/api/chat/stream" && request.method === "POST") {
			return this.handleChatStream(request);
		}

		// Non-streaming chat endpoint (no ask_user support)
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return this.handleChat(request);
		}

		return new Response("Not found", { status: 404 });
	}

	// SSE streaming handler (kept for backward compatibility, no ask_user)
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
		const entityContext = this.buildEntityContext(sessionId);
		const systemPrompt = getSystemPrompt(this.state, false) + entityContext;

		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
		};

		const agent = this;
		const encoder = new TextEncoder();
		const seenTools = new Set<string>();

		const history = this.getConversationHistory(sessionId);
		this.addMessage(sessionId, "user", body.message);

		const modelMessages = [
			...history.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
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
						model: google("gemini-3-flash-preview"),
						system: systemPrompt,
						messages: modelMessages,
						tools: allTools,
						stopWhen: stepCountIs(15),
						providerOptions: {
							google: {
								thinkingConfig: {
									thinkingLevel: "low",
								},
							} satisfies GoogleGenerativeAIProviderOptions,
						},
						onStepFinish: async ({ toolCalls, toolResults }) => {
							if (toolCalls) {
								for (const tc of toolCalls) {
									if (!seenTools.has(tc.toolName)) {
										seenTools.add(tc.toolName);
										const toolArgs =
											"args" in tc
												? (tc.args as ToolArgs)
												: "input" in tc
													? (tc.input as ToolArgs)
													: {};
										const description = getToolDescription(tc.toolName, toolArgs);
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

							if (toolResults) {
								for (const tr of toolResults) {
									agent.extractAndSaveEntities(sessionId, tr.toolName, tr.output);

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
											agent.updateState({
												pendingConfirmation: {
													type: "save_context",
													data: output.data || {},
													message:
														output.message ||
														"Would you like me to remember this?",
												},
											});
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
						encoder.encode(
							`data: ${JSON.stringify({ type: "complete", text: fullText })}\n\n`
						)
					);

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

	// Non-streaming handler (kept for backward compatibility, no ask_user)
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
		const entityContext = this.buildEntityContext(sessionId);
		const systemPrompt = getSystemPrompt(this.state, false) + entityContext;

		const allTools = {
			...egdataTools,
			propose_save_context: proposeSaveContextTool,
		};

		const history = this.getConversationHistory(sessionId);
		this.addMessage(sessionId, "user", body.message);

		const modelMessages = [
			...history.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
			{ role: "user" as const, content: body.message },
		];

		try {
			const result = await generateText({
				model: google("gemini-3-flash-preview"),
				system: systemPrompt,
				messages: modelMessages,
				tools: allTools,
				stopWhen: stepCountIs(15),
				providerOptions: {
					google: {
						thinkingConfig: {
							thinkingLevel: "low",
						},
					} satisfies GoogleGenerativeAIProviderOptions,
				},
			});

			const responseText = result.text;

			for (const step of result.steps) {
				if (step.toolResults) {
					for (const tr of step.toolResults) {
						this.extractAndSaveEntities(sessionId, tr.toolName, tr.output);
					}
				}
			}

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

	private handleConfirm(): Response {
		const pending = this.state.pendingConfirmation;

		if (!pending || pending.type !== "save_context") {
			return Response.json(
				{ error: "No pending confirmation" },
				{ status: 400 }
			);
		}

		const { country, language, fact } = pending.data;
		const updates: Partial<UserState> = { pendingConfirmation: undefined };

		if (country) updates.country = country;
		if (language) updates.language = language;
		if (fact) {
			const currentFacts = this.state.facts || [];
			if (!currentFacts.includes(fact)) {
				updates.facts = [...currentFacts, fact].slice(-10);
			}
		}

		this.updateState(updates);

		return Response.json({
			success: true,
			message: "Got it! I'll remember that for our future conversations.",
			saved: { country, language, fact },
		});
	}

	private handleReject(): Response {
		this.updateState({ pendingConfirmation: undefined });
		return Response.json({
			success: true,
			message: "No problem, I won't save that.",
		});
	}

	private handleClear(sessionId: string): Response {
		this.sql`DELETE FROM messages WHERE session_id = ${sessionId}`;
		this.sql`DELETE FROM known_entities WHERE session_id = ${sessionId}`;
		return Response.json({ success: true });
	}
}
