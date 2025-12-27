import { OpenAPIRoute, Str } from "chanfana";
import { z } from "zod";
import { type AppContext } from "../types";
import { tools as rawTools } from "../tools";

const MessageSchema = z.object({
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
});

const SYSTEM_PROMPT = `You are EGData AI, an expert assistant for the Epic Games Store. You have access to real-time data from the EGData API to help users find information about games, prices, deals, free games, and more.

Your capabilities include:
- Searching for games, DLCs, and bundles
- Getting current prices and price history
- Finding current and past free game giveaways
- Checking top sellers and wishlisted games
- Finding deals and discounts
- Getting game details including reviews, achievements, and playtime estimates
- Finding publisher/developer information

When users ask about games or the Epic Games Store:
1. Use the appropriate tools to fetch real data
2. Present information clearly and concisely
3. Include relevant details like prices, discounts, and ratings when available
4. If a game isn't found, suggest alternatives or ask for clarification

Always be helpful, accurate, and up-to-date with the latest Epic Games Store information.`;

// Tool name to friendly description mapping
const TOOL_DESCRIPTIONS: Record<string, string> = {
	search_offers: "Searching for games",
	get_offer_details: "Getting game details",
	get_offer_price: "Checking current price",
	get_offer_price_history: "Looking up price history",
	get_free_games: "Checking free games",
	get_free_games_history: "Looking up past giveaways",
	get_free_games_stats: "Getting giveaway statistics",
	get_top_sellers: "Checking top sellers",
	get_top_wishlisted: "Checking most wishlisted",
	get_featured_discounts: "Finding current deals",
	get_upcoming_games: "Looking for upcoming releases",
	get_latest_releases: "Checking latest releases",
	get_seller_info: "Getting publisher info",
	get_seller_stats: "Getting publisher statistics",
	search_sellers: "Searching publishers",
	get_promotions: "Checking active promotions",
	get_promotion_offers: "Getting promotion details",
	get_store_stats: "Getting store statistics",
	get_homepage_stats: "Getting homepage stats",
	get_collection: "Loading collection",
	get_offer_achievements: "Checking achievements",
	get_offer_reviews: "Loading reviews",
	get_offer_reviews_summary: "Getting review summary",
	get_offer_hltb: "Checking playtime data",
	get_genres: "Loading genres",
	get_events: "Checking events",
	get_sandbox_info: "Getting sandbox info",
	get_sandbox_items: "Loading sandbox items",
	get_offer_related: "Finding related games",
	get_offer_dlc: "Looking for DLC",
	get_item_details: "Getting item details",
	search_items: "Searching items",
};

// Message type for AI conversation (includes tool messages)
type ChatMessage = {
	role: string;
	content: string;
	tool_calls?: unknown[];
	name?: string;
};

export class AIChatStream extends OpenAPIRoute {
	schema = {
		tags: ["AI"],
		summary: "Chat with EGData AI assistant (streaming)",
		description:
			"Send messages to the AI assistant with Server-Sent Events streaming for real-time updates on tool calls and responses.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							messages: z
								.array(MessageSchema)
								.describe("Array of chat messages"),
							country: z
								.string()
								.optional()
								.describe("Country code for regional pricing (default: US)"),
						}),
					},
				},
			},
		},
		responses: {
			"200": {
				description: "SSE stream with tool call updates and final response",
				content: {
					"text/event-stream": {
						schema: z.object({
							type: z.enum(["thinking", "tool_start", "tool_end", "response", "error"]),
							data: z.unknown(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { messages, country = "US" } = data.body;

		// Create a TransformStream for SSE
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();

		const sendEvent = async (type: string, eventData: unknown) => {
			const event = `event: ${type}\ndata: ${JSON.stringify(eventData)}\n\n`;
			await writer.write(encoder.encode(event));
		};

		// Process in background
		(async () => {
			try {
				await sendEvent("thinking", { message: "Processing your request..." });

				// Prepare messages with flexible type for tool messages
				const chatMessages: ChatMessage[] = [
					{
						role: "system",
						content: `${SYSTEM_PROMPT}\n\nThe user's country code is: ${country}. Use this for regional pricing when relevant.`,
					},
					...messages.map((m) => ({
						role: m.role,
						content: m.content,
					})),
				];

				// Wrap tools to emit events
				const wrappedTools = rawTools.map((tool) => ({
					...tool,
					function: async (args: Record<string, unknown>) => {
						const friendlyName = TOOL_DESCRIPTIONS[tool.name] || tool.name;
						await sendEvent("tool_start", {
							tool: tool.name,
							friendlyName,
							args,
						});

						try {
							// biome-ignore lint/suspicious/noExplicitAny: Tool function types vary
							const result = await tool.function(args as any);
							await sendEvent("tool_end", {
								tool: tool.name,
								friendlyName,
								success: true,
							});
							return result;
						} catch (error) {
							await sendEvent("tool_end", {
								tool: tool.name,
								friendlyName,
								success: false,
								error: error instanceof Error ? error.message : "Unknown error",
							});
							throw error;
						}
					},
				}));

				// Strip functions for the initial AI call
				const toolsForAI = wrappedTools.map(({ function: _, ...rest }) => rest);

				let continueLoop = true;
				let iterations = 0;
				const maxIterations = 5;

				while (continueLoop && iterations < maxIterations) {
					iterations++;

					// Call AI
					// biome-ignore lint/suspicious/noExplicitAny: Workers AI type compatibility
					const response = await (c.env.AI as any).run(
						"@hf/nousresearch/hermes-2-pro-mistral-7b",
						{
							messages: chatMessages,
							tools: toolsForAI,
						}
					);

					// Check if we have tool calls
					if (response.tool_calls && response.tool_calls.length > 0) {
						// Execute tool calls
						for (const toolCall of response.tool_calls) {
							const tool = wrappedTools.find((t) => t.name === toolCall.name);
							if (tool) {
								try {
									const result = await tool.function(toolCall.arguments);
									// Add assistant message with tool call
									chatMessages.push({
										role: "assistant",
										content: "",
										tool_calls: [toolCall],
									});
									// Add tool response
									chatMessages.push({
										role: "tool",
										name: toolCall.name,
										content: result,
									});
								} catch (error) {
									chatMessages.push({
										role: "tool",
										name: toolCall.name,
										content: JSON.stringify({
											error: error instanceof Error ? error.message : "Tool execution failed",
										}),
									});
								}
							}
						}
					} else {
						// No more tool calls, we have the final response
						continueLoop = false;
						await sendEvent("response", {
							content: response.response || response.content || "",
						});
					}
				}

				if (iterations >= maxIterations) {
					await sendEvent("response", {
						content: "I apologize, but I reached the maximum number of steps. Please try a simpler query.",
					});
				}
			} catch (error) {
				console.error("Stream error:", error);
				await sendEvent("error", {
					message: error instanceof Error ? error.message : "An error occurred",
				});
			} finally {
				await writer.close();
			}
		})();

		return new Response(readable, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}
