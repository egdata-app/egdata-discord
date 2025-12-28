import { tool } from "ai";
import { z } from "zod";

const API_BASE = "https://api.egdata.app";

// Helper type for tool options
type ToolOptions = { abortSignal?: AbortSignal };

// Max size for tool results - Gemini Flash 3 supports 1M tokens, so we can be generous
const MAX_RESULT_LENGTH = 500000;

// Format bytes to human-readable size (GB, MB, etc.)
function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	const size = bytes / Math.pow(k, i);
	return `${size.toFixed(2)} ${units[i]}`;
}

// Format cents to currency string
function formatPrice(cents: number, currencyCode = "USD"): string {
	const amount = cents / 100;
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: currencyCode,
		}).format(amount);
	} catch {
		// Fallback for unknown currency codes
		return `${currencyCode} ${amount.toFixed(2)}`;
	}
}

// Add formatted prices to price objects from the API
// Looks for common price fields (in cents) and adds formatted versions
function addFormattedPrices(obj: unknown, currencyCode = "USD"): unknown {
	if (typeof obj !== "object" || obj === null) return obj;

	if (Array.isArray(obj)) {
		return obj.map((item) => addFormattedPrices(item, currencyCode));
	}

	const record = obj as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	// Extract currency code if present in the object
	const currency = (record.currencyCode as string) || currencyCode;

	// Price fields that are in cents and need formatting
	const priceFields = [
		"originalPrice",
		"discountPrice",
		"basePayoutPrice",
		"basePayoutCurrencyCode",
		"totalPrice",
		"discountAmount",
		"voucherDiscount",
		"total", // often used in stats
		"totalOriginalPrice", // in price history
	];

	for (const [key, value] of Object.entries(record)) {
		if (priceFields.includes(key) && typeof value === "number") {
			// Add formatted version alongside the original
			result[key] = value;
			result[`${key}Formatted`] = formatPrice(value, currency);
		} else if (typeof value === "object" && value !== null) {
			// Recursively process nested objects
			result[key] = addFormattedPrices(value, currency);
		} else {
			result[key] = value;
		}
	}

	return result;
}

// Filter out pre-purchase offers from arrays
function filterUnwantedOffers(arr: unknown[]): unknown[] {
	return arr.filter((item) => {
		if (typeof item === "object" && item !== null) {
			const record = item as Record<string, unknown>;
			// Filter out pre-purchase offers
			if (record.prePurchase === true) return false;
		}
		return true;
	});
}

// Process results - filter pre-purchase offers and simplify items
function truncateResult(obj: unknown): unknown {
	// Filter pre-purchase offers from arrays
	let filtered = obj;
	if (Array.isArray(obj)) {
		filtered = filterUnwantedOffers(obj);
	} else if (typeof obj === "object" && obj !== null) {
		const record = obj as Record<string, unknown>;
		if (Array.isArray(record.elements)) {
			filtered = { ...record, elements: filterUnwantedOffers(record.elements) };
		} else if (Array.isArray(record.hits)) {
			filtered = { ...record, hits: filterUnwantedOffers(record.hits) };
		} else if (Array.isArray(record.offers)) {
			filtered = { ...record, offers: filterUnwantedOffers(record.offers) };
		}
	}

	// Simplify items to reduce token usage, but don't truncate count
	if (Array.isArray(filtered)) {
		return filtered.map((item) => simplifyItem(item));
	}

	if (typeof filtered === "object" && filtered !== null && !Array.isArray(filtered)) {
		const record = filtered as Record<string, unknown>;
		if (Array.isArray(record.elements)) {
			return {
				...record,
				elements: (record.elements as unknown[]).map((item) => simplifyItem(item)),
			};
		}
		if (Array.isArray(record.hits)) {
			return {
				...record,
				hits: (record.hits as unknown[]).map((item) => simplifyItem(item)),
			};
		}
		if (Array.isArray(record.offers)) {
			return {
				...record,
				offers: (record.offers as unknown[]).map((item) => simplifyItem(item)),
			};
		}
		return simplifyItem(filtered);
	}

	return filtered;
}

// Convert ISO date strings to Unix timestamps for Discord formatting
function convertDatesToUnix(obj: unknown): unknown {
	if (typeof obj === "string") {
		// Check if it's an ISO date string
		if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
			const timestamp = Math.floor(new Date(obj).getTime() / 1000);
			return { _isoDate: obj, _unixTimestamp: timestamp };
		}
		return obj;
	}
	if (Array.isArray(obj)) {
		return obj.map(convertDatesToUnix);
	}
	if (typeof obj === "object" && obj !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = convertDatesToUnix(value);
		}
		return result;
	}
	return obj;
}

// Simplify an item to only essential fields
function simplifyItem(item: unknown): unknown {
	if (typeof item !== "object" || item === null) return item;

	const record = item as Record<string, unknown>;
	const simplified: Record<string, unknown> = {};

	// Keep only essential fields for games/offers
	const essentialFields = [
		"id",
		"title",
		"name",
		"description",
		"shortDescription",
		"price",
		"originalPrice",
		"discountPrice",
		"discount",
		"discountPercentage",
		"seller",
		"developer",
		"publisher",
		"releaseDate",
		"effectiveDate",
		"offerType",
		"type",
		"url",
		"slug",
		"namespace",
		"currentPrice",
		"totalPrice",
		"fmtPrice",
		"appliedRules",
		"startDate",
		"endDate",
		"upcoming",
		"giveaway",
		"prePurchase", // true = pre-purchase offer (no discounts), null = regular offer
		"status",
		"score",
		"reviewCount",
		"averageRating",
		// Tags, genres, and categories
		"tags",
		"genres",
		"categories",
		"features",
		// Platform and technical info
		"platform",
		"platforms",
		"downloadSizeBytes",
		"installedSizeBytes",
		// Item/asset specific
		"entitlementType",
		"itemType",
		"releaseInfo",
		// Regional availability
		"countriesBlacklist",
		"countriesWhitelist",
	];

	for (const field of essentialFields) {
		if (field in record && record[field] !== null && record[field] !== undefined) {
			const value = record[field];
			// For nested objects like price, simplify further
			if (typeof value === "object" && !Array.isArray(value)) {
				simplified[field] = simplifyItem(value);
			} else if (Array.isArray(value)) {
				// For arrays like tags, extract just the names if objects have name property
				if (value.length > 0 && typeof value[0] === "object" && value[0] !== null && "name" in value[0]) {
					simplified[field] = value.map((item: { name: string }) => item.name).slice(0, 15);
				} else {
					simplified[field] = value.slice(0, 10); // Limit array size
				}
			} else if (typeof value === "string" && value.length > 500) {
				// Truncate long strings
				simplified[field] = value.substring(0, 500) + "...";
			} else {
				simplified[field] = value;
			}
		}
	}

	// If we got nothing useful, return a subset of original keys
	if (Object.keys(simplified).length === 0) {
		const keys = Object.keys(record).slice(0, 10);
		for (const key of keys) {
			simplified[key] = record[key];
		}
	}

	return simplified;
}

// Helper to make API requests with truncation and date conversion
async function apiRequest(
	path: string,
	params?: Record<string, string>
): Promise<unknown> {
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
		return {
			error: `API request failed: ${response.status} ${response.statusText}`,
		};
	}
	const data = await response.json();
	const truncated = truncateResult(data);
	return convertDatesToUnix(truncated);
}

// Tool definitions using AI SDK v6 format with tool() wrapper and inputSchema
export const egdataTools = {
	search_offers: tool({
		description:
			"Search for games in Epic Games Store by name. Returns offer IDs needed for other tools. " +
			"IMPORTANT: Use offerType='BASE_GAME' for prices/sizes (not DLC/editions). " +
			"PARALLEL TIP: When comparing multiple games (e.g., 'Cyberpunk vs Witcher'), make SEPARATE search calls for each game in the SAME step. " +
			"NEXT STEP: After getting IDs, call get_offer_price or get_offer_prices for pricing.",
		inputSchema: z.object({
			query: z.string().optional().describe("Game title to search"),
			offerType: z
				.string()
				.optional()
				.describe(
					"Filter: BASE_GAME, DLC, BUNDLE, ADD_ON, EDITION. Use BASE_GAME for accurate prices/sizes."
				),
			sortBy: z
				.string()
				.optional()
				.describe("Sort: releaseDate, lastModifiedDate, price, discount"),
			sortDir: z.string().optional().describe("asc or desc"),
			limit: z.number().optional().describe("Results per page (max 10)"),
			page: z.number().optional().describe("Page number. For 'top 20', call page=1 AND page=2 in parallel."),
			country: z
				.string()
				.optional()
				.describe("Country code (US, GB, DE, etc.)"),
		}),
		execute: async (args, _options: ToolOptions) => {
			const body: Record<string, unknown> = {};
			if (args.query) body.title = args.query;
			if (args.offerType) body.offerType = args.offerType;
			if (args.sortBy) body.sortBy = args.sortBy;
			if (args.sortDir) body.sortDir = args.sortDir;
			// Limit results to avoid token overflow
			const limitNum = Math.min(args.limit || 5, 10);
			body.limit = limitNum;
			const pageNum = args.page || 1;
			body.page = pageNum;
			if (args.country) body.country = args.country;

			const response = await fetch(`${API_BASE}/search/v2/search`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json();
			const truncated = truncateResult(data);
			const result = convertDatesToUnix(truncated);

			// Add pagination warnings
			const elements = (result as { hits?: unknown[]; elements?: unknown[] })?.hits ||
				(result as { elements?: unknown[] })?.elements || [];
			const elementsArray = Array.isArray(elements) ? elements : [];

			return {
				...result as object,
				_pagination: {
					currentPage: pageNum,
					resultsOnPage: elementsArray.length,
					hasMore: elementsArray.length === limitNum,
					nextPage: elementsArray.length === limitNum ? pageNum + 1 : null,
				},
				_hint: elementsArray.length === limitNum
					? `This is page ${pageNum} (${elementsArray.length} results). More results available - call again with page=${pageNum + 1}.`
					: `This is page ${pageNum} (${elementsArray.length} results).`,
			};
		},
	}),

	get_offer_details: tool({
		description:
			"Get full details for ONE game (description, requirements, release date, regional availability). " +
			"For MULTIPLE games, use get_offers_details instead. " +
			"Returns: title, description, releaseDate, seller, tags, systemRequirements, countriesBlacklist, countriesWhitelist.",
		inputSchema: z.object({
			offerId: z.string().describe("Offer ID from search_offers"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}`),
	}),

	get_offers_details: tool({
		description:
			"Get details for MULTIPLE games in ONE call (includes regional availability). Use when comparing games. " +
			"ALWAYS prefer this over multiple get_offer_details calls. " +
			"PARALLEL TIP: If you also need prices, call get_offer_prices simultaneously.",
		inputSchema: z.object({
			offerIds: z.array(z.string()).describe("Array of offer IDs"),
		}),
		execute: async ({ offerIds }, _options: ToolOptions) => {
			const results = await Promise.all(
				offerIds.map(async (offerId) => {
					try {
						const data = await apiRequest(`/offers/${offerId}`);
						return { offerId, ...data as object };
					} catch (error) {
						return { offerId, error: "Failed to fetch details" };
					}
				})
			);
			return results;
		},
	}),

	get_offer_price: tool({
		description:
			"Get current price for ONE game. Returns: originalPrice, discountPrice, discount%. " +
			"For MULTIPLE games, use get_offer_prices instead. " +
			"Use BASE_GAME offer IDs only (not DLC/editions).",
		inputSchema: z.object({
			offerId: z.string().describe("Offer ID (BASE_GAME type)"),
			country: z
				.string()
				.optional()
				.describe("Country code (default: US). MUST use user's country if set."),
		}),
		execute: async ({ offerId, country }, _options: ToolOptions) => {
			const data = await apiRequest(`/offers/${offerId}/price`, { country: country || "US" });
			return addFormattedPrices(data);
		},
	}),

	get_offer_prices: tool({
		description:
			"Get prices for MULTIPLE games in ONE call. ALWAYS use this for comparisons or lists. " +
			"REQUIRED after get_top_sellers or get_top_wishlisted (they don't include prices). " +
			"Returns: originalPrice, discountPrice, discount% for each game.",
		inputSchema: z.object({
			offerIds: z.array(z.string()).describe("Array of offer IDs (BASE_GAME type)"),
			country: z
				.string()
				.optional()
				.describe("Country code (default: US). MUST use user's country if set."),
		}),
		execute: async ({ offerIds, country }, _options: ToolOptions) => {
			const countryCode = country || "US";
			// Fetch all prices in parallel
			const results = await Promise.all(
				offerIds.map(async (offerId) => {
					try {
						const data = await apiRequest(`/offers/${offerId}/price`, { country: countryCode });
						return { offerId, ...addFormattedPrices(data) as object };
					} catch (error) {
						return { offerId, error: "Failed to fetch price" };
					}
				})
			);
			return results;
		},
	}),

	get_offer_price_history: tool({
		description:
			"Get historical prices and discounts for a game. Shows all past sales and price changes. " +
			"Returns pre-formatted prices with dates.",
		inputSchema: z.object({
			offerId: z.string().describe("Offer ID from search_offers"),
			country: z
				.string()
				.optional()
				.describe("Country code (default: US). MUST use user's country if set."),
		}),
		execute: async ({ offerId, country }, _options: ToolOptions) => {
			const data = await apiRequest(`/offers/${offerId}/price-history`, {
				country: country || "US",
			});
			return addFormattedPrices(data);
		},
	}),

	get_free_games: tool({
		description:
			"Get currently free games on Epic Games Store (PC and mobile). " +
			"Returns: current giveaways with end dates. Use for 'what's free now?' questions.",
		inputSchema: z.object({
			country: z
				.string()
				.optional()
				.describe("Country code (default: US)"),
		}),
		execute: async ({ country }, _options: ToolOptions) =>
			apiRequest("/free-games", { country: country || "US" }),
	}),

	get_free_games_history: tool({
		description:
			"Get past free game giveaways. Returns 15 per page with dates. " +
			"PAGINATION: For 'last year' queries, call multiple pages in parallel (page=1, page=2, page=3).",
		inputSchema: z.object({
			country: z.string().optional().describe("Country code (default: US)"),
			limit: z.number().optional().describe("Per page (default: 15, max 25)"),
			page: z.number().optional().describe("Page number. Call multiple pages in parallel for date ranges."),
		}),
		execute: async ({ country, limit, page }, _options: ToolOptions) => {
			const pageNum = page || 1;
			const limitNum = Math.min(limit || 15, 25);
			const result = await apiRequest("/free-games/history", {
				country: country || "US",
				limit: String(limitNum),
				page: String(pageNum),
			});

			// Add pagination metadata with explicit warnings
			const elements = (result as { elements?: unknown[] })?.elements || [];
			return {
				...result as object,
				_pagination: {
					currentPage: pageNum,
					resultsOnPage: elements.length,
					hasMore: elements.length === limitNum,
					nextPage: elements.length === limitNum ? pageNum + 1 : null,
				},
				_hint: elements.length === limitNum
					? `This is page ${pageNum} (${elements.length} giveaways). More results available - call again with page=${pageNum + 1}.`
					: `This is the last page (${elements.length} giveaways).`,
			};
		},
	}),

	get_free_games_stats: tool({
		description:
			"Get ALL-TIME aggregated statistics about Epic Games Store giveaways (since 2018, not filtered by year). Returns total count, total value (pre-formatted), and number of unique offers. For year-specific data, use get_free_games_history instead.",
		inputSchema: z.object({
			country: z.string().optional().describe("Country code (default: US)"),
		}),
		execute: async ({ country }, _options: ToolOptions) => {
			const data = await apiRequest("/free-games/stats", { country: country || "US" });
			return addFormattedPrices(data);
		},
	}),

	get_top_giveaway_publishers: tool({
		description:
			"Get publishers/developers ranked by how many free games they've given away on Epic Games Store. Returns a leaderboard of the most generous publishers. NOT related to best-selling games - use get_top_sellers for sales rankings. Use this for questions like 'which publishers gave away the most free games' or 'how many games has [publisher] gifted'.",
		inputSchema: z.object({
			query: z.string().optional().describe("Optional publisher name to search for (case-insensitive partial match)"),
		}),
		execute: async ({ query }, _options: ToolOptions) => {
			const response = await fetch(`${API_BASE}/free-games/sellers`);
			if (!response.ok) {
				return { error: `API request failed: ${response.status} ${response.statusText}` };
			}
			const data = await response.json() as Array<{ totalSingleGames: number; sellerId: string; sellerName: string }>;

			// If query provided, filter by publisher name
			if (query) {
				const lowerQuery = query.toLowerCase();
				const filtered = data.filter((publisher) =>
					publisher.sellerName.toLowerCase().includes(lowerQuery)
				);
				return filtered.length > 0
					? filtered
					: { message: `No publishers found matching "${query}"`, totalPublishers: data.length };
			}

			// Return top 50 publishers (enough for most queries without token overflow)
			return {
				publishers: data.slice(0, 50),
				totalPublishers: data.length,
				_note: "Showing top 50 publishers by giveaway count. Use query parameter to search for specific publishers.",
			};
		},
	}),

	get_top_sellers: tool({
		description:
			"Get top selling games on Epic Games Store. Returns game IDs and titles but NO PRICES. " +
			"NEXT STEP: ALWAYS call get_offer_prices with the returned offer IDs to get pricing. " +
			"Example flow: get_top_sellers(count=10) → get_offer_prices(offerIds=[...all IDs...])",
		inputSchema: z.object({
			count: z.number().optional().describe("Number of games (default: 10, max: 50). Auto-paginates."),
		}),
		execute: async ({ count }, _options: ToolOptions) => {
			const totalCount = Math.min(count || 10, 50);
			const perPage = 25; // Max per page
			const pagesNeeded = Math.ceil(totalCount / perPage);

			// Fetch all pages in parallel
			const pagePromises = Array.from({ length: pagesNeeded }, (_, i) =>
				apiRequest("/offers/top-sellers", {
					limit: String(perPage),
					page: String(i + 1),
				})
			);

			const results = await Promise.all(pagePromises);

			const allElements: unknown[] = [];
			for (const result of results) {
				const elements = (result as { elements?: unknown[] })?.elements || [];
				allElements.push(...elements);
			}

			return {
				elements: allElements.slice(0, totalCount),
				totalReturned: Math.min(allElements.length, totalCount),
			};
		},
	}),

	get_top_wishlisted: tool({
		description:
			"Get most wishlisted games on Epic Games Store. Returns game IDs and titles but NO PRICES. " +
			"NEXT STEP: ALWAYS call get_offer_prices with the returned offer IDs to get pricing. " +
			"Example flow: get_top_wishlisted(count=10) → get_offer_prices(offerIds=[...all IDs...])",
		inputSchema: z.object({
			count: z.number().optional().describe("Number of games (default: 10, max: 50). Auto-paginates."),
		}),
		execute: async ({ count }, _options: ToolOptions) => {
			const totalCount = Math.min(count || 10, 50);
			const perPage = 25; // Max per page
			const pagesNeeded = Math.ceil(totalCount / perPage);

			// Fetch all pages in parallel
			const pagePromises = Array.from({ length: pagesNeeded }, (_, i) =>
				apiRequest("/offers/top-wishlisted", {
					limit: String(perPage),
					page: String(i + 1),
				})
			);

			const results = await Promise.all(pagePromises);

			const allElements: unknown[] = [];
			for (const result of results) {
				const elements = (result as { elements?: unknown[] })?.elements || [];
				allElements.push(...elements);
			}

			return {
				elements: allElements.slice(0, totalCount),
				totalReturned: Math.min(allElements.length, totalCount),
			};
		},
	}),

	get_featured_discounts: tool({
		description: "Get currently featured games with active discounts.",
		inputSchema: z.object({}),
		execute: async (_args, _options: ToolOptions) =>
			apiRequest("/offers/featured-discounts"),
	}),

	get_upcoming_games: tool({
		description:
			"Get upcoming game releases. Returns release dates and titles. " +
			"PAGINATION: For more than 10 results, call multiple pages in parallel.",
		inputSchema: z.object({
			limit: z.number().optional().describe("Per page (default: 10)"),
			page: z.number().optional().describe("Page number. Use parallel calls for more results."),
		}),
		execute: async ({ limit, page }, _options: ToolOptions) => {
			const pageNum = page || 1;
			const limitNum = limit || 10;
			const result = await apiRequest("/offers/upcoming", {
				limit: String(limitNum),
				page: String(pageNum),
			});

			const elements = (result as { elements?: unknown[] })?.elements || [];
			return {
				...result as object,
				_pagination: {
					currentPage: pageNum,
					resultsOnPage: elements.length,
					hasMore: elements.length === limitNum,
					nextPage: elements.length === limitNum ? pageNum + 1 : null,
				},
				_hint: elements.length === limitNum
					? `This is page ${pageNum} (${elements.length} games). More results available - call again with page=${pageNum + 1}.`
					: `This is page ${pageNum} (${elements.length} games).`,
			};
		},
	}),

	get_latest_releases: tool({
		description:
			"Get recently released games. Returns release dates and titles. " +
			"PAGINATION: For more than 10 results, call multiple pages in parallel.",
		inputSchema: z.object({
			limit: z.number().optional().describe("Per page (default: 10)"),
			page: z.number().optional().describe("Page number. Use parallel calls for more results."),
		}),
		execute: async ({ limit, page }, _options: ToolOptions) => {
			const pageNum = page || 1;
			const limitNum = limit || 10;
			const result = await apiRequest("/offers/latest-released", {
				limit: String(limitNum),
				page: String(pageNum),
			});

			const elements = (result as { elements?: unknown[] })?.elements || [];
			return {
				...result as object,
				_pagination: {
					currentPage: pageNum,
					resultsOnPage: elements.length,
					hasMore: elements.length === limitNum,
					nextPage: elements.length === limitNum ? pageNum + 1 : null,
				},
				_hint: elements.length === limitNum
					? `This is page ${pageNum} (${elements.length} games). More results available - call again with page=${pageNum + 1}.`
					: `This is page ${pageNum} (${elements.length} games).`,
			};
		},
	}),

	search_sellers: tool({
		description: "Search for game sellers/publishers by name.",
		inputSchema: z.object({
			query: z.string().describe("Search query for seller name"),
		}),
		execute: async ({ query }, _options: ToolOptions) =>
			apiRequest("/multisearch/sellers", { query }),
	}),

	get_promotions: tool({
		description: "Get active promotional events and sales on Epic Games Store.",
		inputSchema: z.object({}),
		execute: async (_args, _options: ToolOptions) => apiRequest("/promotions"),
	}),

	get_store_stats: tool({
		description:
			"Get overall Epic Games Store statistics including total offers and items.",
		inputSchema: z.object({}),
		execute: async (_args, _options: ToolOptions) => apiRequest("/stats"),
	}),

	get_offer_achievements: tool({
		description: "Get achievement information for a game.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}/achievements`),
	}),

	get_offer_reviews_summary: tool({
		description:
			"Get aggregated review statistics for a game including average score.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}/reviews-summary`),
	}),

	get_offer_hltb: tool({
		description: "Get HowLongToBeat data for a game showing expected playtime.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}/hltb`),
	}),

	get_offer_related: tool({
		description:
			"Get related offers/games from the same namespace or franchise.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}/related`),
	}),

	search_items: tool({
		description:
			"Search for items (executables/entitlements) in the Epic Games Store. Items are what you actually download and run - the launcher entries. Use this to find specific executables, not game store listings (use search_offers for that). Items do NOT contain download size info.",
		inputSchema: z.object({
			query: z.string().describe("Search query for item/executable name"),
		}),
		execute: async ({ query }, _options: ToolOptions) =>
			apiRequest("/multisearch/items", { query }),
	}),

	get_offer_items: tool({
		description:
			"Get downloadable items for ONE game. Returns item IDs needed for get_item_assets. " +
			"Use BASE_GAME offer IDs only. Look for entitlementType='EXECUTABLE'. " +
			"NEXT STEP: Call get_item_assets with item ID to get download/install sizes.",
		inputSchema: z.object({
			offerId: z.string().describe("Offer ID (BASE_GAME type)"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}/items`),
	}),

	get_offers_items: tool({
		description:
			"Get items for MULTIPLE games in ONE call. Use when comparing download sizes. " +
			"NEXT STEP: Call get_items_assets with all item IDs to get sizes. " +
			"PARALLEL TIP: Can call simultaneously with get_offer_prices for full comparison.",
		inputSchema: z.object({
			offerIds: z.array(z.string()).describe("Array of offer IDs (BASE_GAME type)"),
		}),
		execute: async ({ offerIds }, _options: ToolOptions) => {
			const results = await Promise.all(
				offerIds.map(async (offerId) => {
					try {
						const data = await apiRequest(`/offers/${offerId}/items`);
						return { offerId, items: data };
					} catch (error) {
						return { offerId, error: "Failed to fetch items" };
					}
				})
			);
			return results;
		},
	}),

	get_item_assets: tool({
		description:
			"Get download/install sizes for ONE item. Returns: downloadSize, installedSize (pre-formatted). " +
			"For MULTIPLE items, use get_items_assets instead. " +
			"If size is '0 B', try a different item ID from get_offer_items.",
		inputSchema: z.object({
			itemId: z.string().describe("Item ID from get_offer_items"),
		}),
		execute: async ({ itemId }, _options: ToolOptions) => {
			const data = await apiRequest(`/items/${itemId}/assets`);
			// Add formatted sizes to each asset
			if (Array.isArray(data)) {
				return data.map((asset) => {
					const a = asset as Record<string, unknown>;
					return {
						...a,
						// Add human-readable sizes
						downloadSize: typeof a.downloadSizeBytes === "number" ? formatBytes(a.downloadSizeBytes) : null,
						installedSize: typeof a.installedSizeBytes === "number" ? formatBytes(a.installedSizeBytes) : null,
					};
				});
			}
			return data;
		},
	}),

	get_items_assets: tool({
		description:
			"Get download/install sizes for MULTIPLE items in ONE call. Use for size comparisons. " +
			"Returns: downloadSize, installedSize (pre-formatted) for each item.",
		inputSchema: z.object({
			itemIds: z.array(z.string()).describe("Array of item IDs from get_offers_items"),
		}),
		execute: async ({ itemIds }, _options: ToolOptions) => {
			const results = await Promise.all(
				itemIds.map(async (itemId) => {
					try {
						const data = await apiRequest(`/items/${itemId}/assets`);
						// Add formatted sizes to each asset
						if (Array.isArray(data)) {
							const assets = data.map((asset) => {
								const a = asset as Record<string, unknown>;
								return {
									...a,
									downloadSize: typeof a.downloadSizeBytes === "number" ? formatBytes(a.downloadSizeBytes) : null,
									installedSize: typeof a.installedSizeBytes === "number" ? formatBytes(a.installedSizeBytes) : null,
								};
							});
							return { itemId, assets };
						}
						return { itemId, assets: data };
					} catch (error) {
						return { itemId, error: "Failed to fetch assets" };
					}
				})
			);
			return results;
		},
	}),
};
