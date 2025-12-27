import { EGDataAgent } from "./agent";

// Export the agent class for Durable Objects
export { EGDataAgent };

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check at root level
		if (url.pathname === "/health") {
			return Response.json({ status: "ok" });
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

			// Get the Durable Object instance for this user
			const id = env.EGDataAgent.idFromName(agentId);
			const stub = env.EGDataAgent.get(id);

			// Forward the request to the agent
			return stub.fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
