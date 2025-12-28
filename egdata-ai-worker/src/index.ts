import { EGDataAgent, routeAgentRequest, getAgentByName } from "./agent";

// Export the agent class for Durable Objects
export { EGDataAgent };

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check at root level
		if (url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}

		// Handle WebSocket connections via partyserver routing
		// URL pattern: /parties/egdataagent/{agentId} or /agents/{agentId}
		if (request.headers.get("Upgrade") === "websocket") {
			// Extract agent ID from query params
			const agentId = url.searchParams.get("agentId") || "default";

			// Use getAgentByName to properly route to the agent
			const agent = await getAgentByName(env.EGDataAgent, agentId);
			return agent.fetch(request);
		}

		// Try partyserver routing first (handles WebSocket upgrades via URL pattern)
		const agentResponse = await routeAgentRequest(request, env, { cors: true });
		if (agentResponse) {
			return agentResponse;
		}

		// API endpoints that need to be routed to the agent
		if (url.pathname.startsWith("/api/")) {
			// Extract user/session ID from request body to route to correct agent instance
			let agentId = "default";

			if (request.method === "POST") {
				try {
					// Clone request to read body without consuming it
					const clonedRequest = request.clone();
					const body = (await clonedRequest.json()) as {
						sessionId?: string;
						userId?: string;
					};

					if (body.sessionId) {
						// Extract user ID from session ID (format: discord-{userId}-{timestamp}-{random})
						const match = body.sessionId.match(/^discord-(\d+)/);
						agentId = match ? match[1] : body.sessionId;
					} else if (body.userId) {
						agentId = body.userId;
					}
				} catch {
					// If we can't parse the body, use default
				}
			}

			// Use getAgentByName to properly route to the agent
			const agent = await getAgentByName(env.EGDataAgent, agentId);
			return agent.fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
