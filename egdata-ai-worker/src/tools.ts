const API_BASE = "https://api.egdata.app";

// Helper to make API requests - returns stringified JSON for AI consumption
async function apiRequest(path: string, params?: Record<string, string>): Promise<string> {
	const url = new URL(`${API_BASE}${path}`);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") {
				url.searchParams.set(key, value);
			}
		}
	}
	const response = await fetch(url.toString());
	if (!response.ok) {
		return JSON.stringify({ error: `API request failed: ${response.status} ${response.statusText}` });
	}
	const data = await response.json();
	return JSON.stringify(data);
}

// Tool definitions for AI with inline execution functions
export const tools = [
	{
		name: "search_offers",
		description:
			"Search for games, DLCs, bundles, and other offers in the Epic Games Store. Use this to find games by name, filter by type, tags, price range, or sort by various criteria.",
		parameters: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "Search query for game title",
				},
				offerType: {
					type: "string",
					description: "Filter by offer type: BASE_GAME, DLC, BUNDLE, ADD_ON, EDITION, etc.",
				},
				tags: {
					type: "string",
					description: "Comma-separated tag IDs to filter by",
				},
				minPrice: {
					type: "number",
					description: "Minimum price in cents",
				},
				maxPrice: {
					type: "number",
					description: "Maximum price in cents",
				},
				sortBy: {
					type: "string",
					description:
						"Sort by: releaseDate, lastModifiedDate, effectiveDate, creationDate, viewableDate, pcReleaseDate, upcoming, price, currentPrice, discount",
				},
				sortDir: {
					type: "string",
					description: "Sort direction: asc or desc",
				},
				limit: {
					type: "number",
					description: "Number of results (max 50)",
				},
				page: {
					type: "number",
					description: "Page number for pagination",
				},
				country: {
					type: "string",
					description: "Country code for regional pricing (e.g., US, GB, DE)",
				},
			},
			required: [] as string[],
		},
		function: async (args: Record<string, unknown>): Promise<string> => {
			const body: Record<string, unknown> = {};
			if (args.query) body.title = args.query;
			if (args.offerType) body.offerType = args.offerType;
			if (args.tags) body.tags = (args.tags as string).split(",");
			if (args.minPrice !== undefined || args.maxPrice !== undefined) {
				body.price = {};
				if (args.minPrice !== undefined)
					(body.price as Record<string, number>).min = args.minPrice as number;
				if (args.maxPrice !== undefined)
					(body.price as Record<string, number>).max = args.maxPrice as number;
			}
			if (args.sortBy) body.sortBy = args.sortBy;
			if (args.sortDir) body.sortDir = args.sortDir;
			if (args.limit) body.limit = args.limit;
			if (args.page) body.page = args.page;
			if (args.country) body.country = args.country;

			const response = await fetch(`${API_BASE}/search/v2/search`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json();
			return JSON.stringify(data);
		},
	},
	{
		name: "get_offer_details",
		description:
			"Get detailed information about a specific game/offer including description, images, developer, publisher, release date, and more. Use the offer ID from search results.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID to get details for",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string }) => {
			return apiRequest(`/offers/${args.offerId}`);
		},
	},
	{
		name: "get_offer_price",
		description: "Get current pricing information for a specific offer in a given region.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID to get price for",
				},
				country: {
					type: "string",
					description: "Country code for regional pricing (default: US)",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string; country?: string }) => {
			return apiRequest(`/offers/${args.offerId}/price`, {
				country: args.country || "US",
			});
		},
	},
	{
		name: "get_offer_price_history",
		description:
			"Get historical pricing data for a game to see past discounts and price changes over time.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID to get price history for",
				},
				country: {
					type: "string",
					description: "Country code for regional pricing (default: US)",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string; country?: string }) => {
			return apiRequest(`/offers/${args.offerId}/price-history`, {
				country: args.country || "US",
			});
		},
	},
	{
		name: "get_free_games",
		description:
			"Get currently free games on Epic Games Store, including both PC and mobile giveaways.",
		parameters: {
			type: "object" as const,
			properties: {
				country: {
					type: "string",
					description: "Country code for regional info (default: US)",
				},
			},
			required: [] as string[],
		},
		function: async (args: { country?: string }) => {
			return apiRequest("/free-games", {
				country: args.country || "US",
			});
		},
	},
	{
		name: "get_free_games_history",
		description:
			"Get history of past free game giveaways on Epic Games Store with pagination.",
		parameters: {
			type: "object" as const,
			properties: {
				country: {
					type: "string",
					description: "Country code (default: US)",
				},
				limit: {
					type: "number",
					description: "Results per page (max 25)",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: [] as string[],
		},
		function: async (args: { country?: string; limit?: number; page?: number }) => {
			return apiRequest("/free-games/history", {
				country: args.country || "US",
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_free_games_stats",
		description:
			"Get aggregated statistics about all Epic Games Store giveaways including total value, count, and seller stats.",
		parameters: {
			type: "object" as const,
			properties: {
				country: {
					type: "string",
					description: "Country code (default: US)",
				},
			},
			required: [] as string[],
		},
		function: async (args: { country?: string }) => {
			return apiRequest("/free-games/stats", {
				country: args.country || "US",
			});
		},
	},
	{
		name: "get_top_sellers",
		description:
			"Get the current top selling games on Epic Games Store with their ranking positions.",
		parameters: {
			type: "object" as const,
			properties: {
				limit: {
					type: "number",
					description: "Number of results (default: 10)",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: [] as string[],
		},
		function: async (args: { limit?: number; page?: number }) => {
			return apiRequest("/offers/top-sellers", {
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_top_wishlisted",
		description: "Get the most wishlisted games on Epic Games Store.",
		parameters: {
			type: "object" as const,
			properties: {
				limit: {
					type: "number",
					description: "Number of results (default: 10)",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: [] as string[],
		},
		function: async (args: { limit?: number; page?: number }) => {
			return apiRequest("/offers/top-wishlisted", {
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_featured_discounts",
		description: "Get currently featured games with active discounts.",
		parameters: {
			type: "object" as const,
			properties: {},
			required: [] as string[],
		},
		function: async () => {
			return apiRequest("/offers/featured-discounts");
		},
	},
	{
		name: "get_upcoming_games",
		description: "Get upcoming game releases on Epic Games Store.",
		parameters: {
			type: "object" as const,
			properties: {
				limit: {
					type: "number",
					description: "Number of results",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: [] as string[],
		},
		function: async (args: { limit?: number; page?: number }) => {
			return apiRequest("/offers/upcoming", {
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_latest_releases",
		description: "Get the most recently released games on Epic Games Store.",
		parameters: {
			type: "object" as const,
			properties: {
				limit: {
					type: "number",
					description: "Number of results",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: [] as string[],
		},
		function: async (args: { limit?: number; page?: number }) => {
			return apiRequest("/offers/latest-released", {
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_seller_info",
		description:
			"Get information about a game seller/publisher including their offers and statistics.",
		parameters: {
			type: "object" as const,
			properties: {
				sellerId: {
					type: "string",
					description: "The seller ID",
				},
				country: {
					type: "string",
					description: "Country code for pricing (default: US)",
				},
				limit: {
					type: "number",
					description: "Number of offers to return",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: ["sellerId"],
		},
		function: async (args: { sellerId: string; country?: string; limit?: number; page?: number }) => {
			return apiRequest(`/sellers/${args.sellerId}`, {
				country: args.country || "US",
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_seller_stats",
		description:
			"Get statistics for a seller including offer count, games count, and free games count.",
		parameters: {
			type: "object" as const,
			properties: {
				sellerId: {
					type: "string",
					description: "The seller ID",
				},
			},
			required: ["sellerId"],
		},
		function: async (args: { sellerId: string }) => {
			return apiRequest(`/sellers/${args.sellerId}/stats`);
		},
	},
	{
		name: "search_sellers",
		description: "Search for game sellers/publishers by name.",
		parameters: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "Search query for seller name",
				},
			},
			required: ["query"],
		},
		function: async (args: { query: string }) => {
			return apiRequest("/multisearch/sellers", {
				query: args.query,
			});
		},
	},
	{
		name: "get_promotions",
		description: "Get active promotional events and sales on Epic Games Store.",
		parameters: {
			type: "object" as const,
			properties: {},
			required: [] as string[],
		},
		function: async () => {
			return apiRequest("/promotions");
		},
	},
	{
		name: "get_promotion_offers",
		description: "Get offers associated with a specific promotional event.",
		parameters: {
			type: "object" as const,
			properties: {
				promotionId: {
					type: "string",
					description: "The promotion/event ID",
				},
				country: {
					type: "string",
					description: "Country code for pricing",
				},
				limit: {
					type: "number",
					description: "Number of results",
				},
				page: {
					type: "number",
					description: "Page number",
				},
				sortBy: {
					type: "string",
					description: "Sort field",
				},
			},
			required: ["promotionId"],
		},
		function: async (args: { promotionId: string; country?: string; limit?: number; page?: number; sortBy?: string }) => {
			return apiRequest(`/promotions/${args.promotionId}`, {
				country: args.country || "US",
				limit: String(args.limit || 10),
				page: String(args.page || 1),
				sortBy: args.sortBy || "lastModifiedDate",
			});
		},
	},
	{
		name: "get_store_stats",
		description:
			"Get overall Epic Games Store statistics including total offers, items, and historical data.",
		parameters: {
			type: "object" as const,
			properties: {},
			required: [] as string[],
		},
		function: async () => {
			return apiRequest("/stats");
		},
	},
	{
		name: "get_homepage_stats",
		description:
			"Get homepage statistics including offer count, price changes, active discounts, and giveaways.",
		parameters: {
			type: "object" as const,
			properties: {
				country: {
					type: "string",
					description: "Country code (default: US)",
				},
			},
			required: [] as string[],
		},
		function: async (args: { country?: string }) => {
			return apiRequest("/stats/homepage", {
				country: args.country || "US",
			});
		},
	},
	{
		name: "get_collection",
		description:
			"Get offers from a specific collection (e.g., top-sellers, top-wishlisted) with pagination.",
		parameters: {
			type: "object" as const,
			properties: {
				slug: {
					type: "string",
					description: "Collection slug (e.g., top-sellers, top-wishlisted)",
				},
				country: {
					type: "string",
					description: "Country code for pricing",
				},
				limit: {
					type: "number",
					description: "Number of results",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: ["slug"],
		},
		function: async (args: { slug: string; country?: string; limit?: number; page?: number }) => {
			return apiRequest(`/collections/${args.slug}`, {
				country: args.country || "US",
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_offer_achievements",
		description: "Get achievement information for a game including achievement sets and stats.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string }) => {
			return apiRequest(`/offers/${args.offerId}/achievements`);
		},
	},
	{
		name: "get_offer_reviews",
		description: "Get user reviews for a game with ratings and recommendation data.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID",
				},
				limit: {
					type: "number",
					description: "Number of reviews to return",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string; limit?: number; page?: number }) => {
			return apiRequest(`/offers/${args.offerId}/reviews`, {
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_offer_reviews_summary",
		description:
			"Get aggregated review statistics for a game including average score and recommendation percentage.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string }) => {
			return apiRequest(`/offers/${args.offerId}/reviews-summary`);
		},
	},
	{
		name: "get_offer_hltb",
		description: "Get HowLongToBeat data for a game showing expected playtime.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string }) => {
			return apiRequest(`/offers/${args.offerId}/hltb`);
		},
	},
	{
		name: "get_genres",
		description: "Get all available genres with sample games for each.",
		parameters: {
			type: "object" as const,
			properties: {},
			required: [] as string[],
		},
		function: async () => {
			return apiRequest("/offers/genres");
		},
	},
	{
		name: "get_events",
		description: "Get active event tags with associated games.",
		parameters: {
			type: "object" as const,
			properties: {},
			required: [] as string[],
		},
		function: async () => {
			return apiRequest("/offers/events");
		},
	},
	{
		name: "get_sandbox_info",
		description:
			"Get information about a game sandbox including items, offers, and builds. A sandbox is Epic's container for a game's content.",
		parameters: {
			type: "object" as const,
			properties: {
				sandboxId: {
					type: "string",
					description: "The sandbox ID (namespace)",
				},
			},
			required: ["sandboxId"],
		},
		function: async (args: { sandboxId: string }) => {
			return apiRequest(`/sandboxes/${args.sandboxId}`);
		},
	},
	{
		name: "get_sandbox_items",
		description: "Get items (DLC, add-ons, entitlements) within a game sandbox.",
		parameters: {
			type: "object" as const,
			properties: {
				sandboxId: {
					type: "string",
					description: "The sandbox ID",
				},
				limit: {
					type: "number",
					description: "Number of results",
				},
				page: {
					type: "number",
					description: "Page number",
				},
			},
			required: ["sandboxId"],
		},
		function: async (args: { sandboxId: string; limit?: number; page?: number }) => {
			return apiRequest(`/sandboxes/${args.sandboxId}/items`, {
				limit: String(args.limit || 10),
				page: String(args.page || 1),
			});
		},
	},
	{
		name: "get_offer_related",
		description: "Get related offers/games from the same namespace or franchise.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string }) => {
			return apiRequest(`/offers/${args.offerId}/related`);
		},
	},
	{
		name: "get_offer_dlc",
		description: "Get DLC and add-on content available for a base game.",
		parameters: {
			type: "object" as const,
			properties: {
				offerId: {
					type: "string",
					description: "The offer ID of the base game",
				},
				country: {
					type: "string",
					description: "Country code for pricing",
				},
			},
			required: ["offerId"],
		},
		function: async (args: { offerId: string; country?: string }) => {
			return apiRequest(`/offers/${args.offerId}/items`, {
				country: args.country || "US",
			});
		},
	},
	{
		name: "get_item_details",
		description:
			"Get detailed information about a specific item (DLC, entitlement, add-on).",
		parameters: {
			type: "object" as const,
			properties: {
				itemId: {
					type: "string",
					description: "The item ID",
				},
			},
			required: ["itemId"],
		},
		function: async (args: { itemId: string }) => {
			return apiRequest(`/items/${args.itemId}`);
		},
	},
	{
		name: "search_items",
		description: "Search for items (DLCs, add-ons, entitlements) in the Epic Games Store.",
		parameters: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "Search query",
				},
				type: {
					type: "string",
					description: "Entitlement type filter",
				},
			},
			required: ["query"],
		},
		function: async (args: { query: string; type?: string }) => {
			return apiRequest("/multisearch/items", {
				query: args.query,
				type: args.type || "",
			});
		},
	},
];
