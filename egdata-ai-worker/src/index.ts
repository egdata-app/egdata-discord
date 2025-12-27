import { fromHono } from "chanfana";
import { Hono } from "hono";
import { AIChat } from "./endpoints/aiChat";
import { AIChatStream } from "./endpoints/aiChatStream";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "EGData AI API",
			version: "1.0.0",
			description:
				"AI-powered assistant for Epic Games Store data. Chat with the AI to get information about games, prices, deals, free games, and more.",
		},
	},
});

// Register AI chat endpoints
openapi.post("/api/chat", AIChat);
openapi.post("/api/chat/stream", AIChatStream);

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok" }));

// Export the Hono app
export default app;
