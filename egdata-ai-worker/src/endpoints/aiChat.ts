import { OpenAPIRoute, Str } from "chanfana";
import { z } from "zod";
import { type AppContext } from "../types";
import { tools } from "../tools";
import { runWithTools } from "@cloudflare/ai-utils";

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

export class AIChat extends OpenAPIRoute {
	schema = {
		tags: ["AI"],
		summary: "Chat with EGData AI assistant",
		description:
			"Send messages to the AI assistant to get information about Epic Games Store games, prices, deals, and more.",
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
				description: "AI response",
				content: {
					"application/json": {
						schema: z.object({
							response: Str({ description: "AI assistant response" }),
						}),
					},
				},
			},
			"500": {
				description: "Error",
				content: {
					"application/json": {
						schema: z.object({
							error: Str(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		try {
			const data = await this.getValidatedData<typeof this.schema>();
			const { messages, country = "US" } = data.body;

			// Prepare messages with system prompt
			const chatMessages = [
				{
					role: "system" as const,
					content: `${SYSTEM_PROMPT}\n\nThe user's country code is: ${country}. Use this for regional pricing when relevant.`,
				},
				...messages.map((m) => ({
					role: m.role as "user" | "assistant" | "system",
					content: m.content,
				})),
			];

			// Run AI with tools using @cloudflare/ai-utils
			// biome-ignore lint/suspicious/noExplicitAny: Type mismatch between workers-types versions
			const response = await runWithTools(
				c.env.AI as any,
				"@hf/nousresearch/hermes-2-pro-mistral-7b",
				{
					messages: chatMessages,
					tools,
				},
				{
					maxRecursiveToolRuns: 5,
					verbose: true,
				},
			);

			// Extract the final response content
			let responseContent = "";
			if (typeof response === "string") {
				responseContent = response;
			} else if (typeof response === "object" && response !== null) {
				if ("response" in response) {
					responseContent = response.response as string;
				} else if ("content" in response) {
					responseContent = response.content as string;
				}
			}

			return {
				response: responseContent || "I apologize, but I couldn't generate a response. Please try again.",
			};
		} catch (error) {
			console.error("AI Chat error:", error);
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "An error occurred while processing your request",
				},
				{ status: 500 },
			);
		}
	}
}
