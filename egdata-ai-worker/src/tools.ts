import { tool } from "ai";
import { z } from "zod";

const API_BASE = "https://api.egdata.app";

// Helper type for tool options
type ToolOptions = { abortSignal?: AbortSignal };

// Max size for tool results to avoid token limits
const MAX_RESULT_LENGTH = 15000;

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

// Filter out pre-purchase offers and giveaway placeholder offers from arrays
function filterUnwantedOffers(arr: unknown[]): unknown[] {
	return arr.filter((item) => {
		if (typeof item === "object" && item !== null) {
			const record = item as Record<string, unknown>;
			// Filter out pre-purchase offers
			if (record.prePurchase === true) return false;

			// Filter out giveaway placeholder offers (mystery games, vault items)
			// These have dummy items with no real asset data
			// Identify them by: seller "Epic Dev Test Account" or "freegames/vaulted" category
			const seller = record.seller as { name?: string } | undefined;
			if (seller?.name === "Epic Dev Test Account") return false;

			const categories = record.categories as string[] | undefined;
			if (categories?.includes("freegames/vaulted")) return false;
		}
		return true;
	});
}

// Truncate large objects to reduce token usage and filter unwanted offers
function truncateResult(obj: unknown): unknown {
	// First, filter unwanted offers (pre-purchase, giveaway placeholders) from any arrays
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

	const json = JSON.stringify(filtered);
	if (json.length <= MAX_RESULT_LENGTH) {
		return filtered;
	}

	// If it's an array, take fewer items
	if (Array.isArray(filtered)) {
		const limited = filtered.slice(0, 5).map((item) => simplifyItem(item));
		return {
			items: limited,
			_truncated: true,
			_originalCount: filtered.length,
			_message: `Showing 5 of ${filtered.length} results. Ask for specific details if needed.`,
		};
	}

	// If it has an 'elements', 'hits', or 'offers' array (common in search results)
	if (typeof filtered === "object" && filtered !== null && !Array.isArray(filtered)) {
		const record = filtered as Record<string, unknown>;
		if (Array.isArray(record.elements)) {
			const items = record.elements as unknown[];
			return {
				...record,
				elements: items.slice(0, 5).map((item) => simplifyItem(item)),
				_truncated: true,
				_message: `Showing 5 of ${items.length} results.`,
			};
		}
		if (Array.isArray(record.hits)) {
			const items = record.hits as unknown[];
			return {
				...record,
				hits: items.slice(0, 5).map((item) => simplifyItem(item)),
				_truncated: true,
				_message: `Showing 5 of ${items.length} results.`,
			};
		}
		if (Array.isArray(record.offers)) {
			const items = record.offers as unknown[];
			return {
				...record,
				offers: items.slice(0, 5).map((item) => simplifyItem(item)),
				_truncated: true,
				_message: `Showing 5 of ${items.length} results.`,
			};
		}
		// Single object - simplify it
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
			"Search for games, DLCs, bundles, and other offers in the Epic Games Store. Use this to find games by name, filter by type, or sort by various criteria. IMPORTANT: When searching for prices or download sizes, you MUST use offerType='BASE_GAME' to get accurate results for the main game (not DLCs or editions).",
		inputSchema: z.object({
			query: z.string().optional().describe("Search query for game title"),
			offerType: z
				.string()
				.optional()
				.describe(
					"Filter by offer type: BASE_GAME, DLC, BUNDLE, ADD_ON, EDITION. ALWAYS use BASE_GAME when searching for prices or download sizes."
				),
			sortBy: z
				.string()
				.optional()
				.describe("Sort by: releaseDate, lastModifiedDate, price, discount"),
			sortDir: z.string().optional().describe("Sort direction: asc or desc"),
			limit: z.number().optional().describe("Number of results (max 10)"),
			page: z.number().optional().describe("Page number for pagination"),
			country: z
				.string()
				.optional()
				.describe("Country code for regional pricing (e.g., US, GB, DE)"),
		}),
		execute: async (args, _options: ToolOptions) => {
			const body: Record<string, unknown> = {};
			if (args.query) body.title = args.query;
			if (args.offerType) body.offerType = args.offerType;
			if (args.sortBy) body.sortBy = args.sortBy;
			if (args.sortDir) body.sortDir = args.sortDir;
			// Limit results to avoid token overflow
			body.limit = Math.min(args.limit || 5, 10);
			if (args.page) body.page = args.page;
			if (args.country) body.country = args.country;

			const response = await fetch(`${API_BASE}/search/v2/search`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await response.json();
			const truncated = truncateResult(data);
			return convertDatesToUnix(truncated);
		},
	}),

	get_offer_details: tool({
		description:
			"Get detailed information about a SINGLE game/offer. For multiple offers, use get_offers_details (plural) instead.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID to get details for"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}`),
	}),

	get_offers_details: tool({
		description:
			"Get detailed information about MULTIPLE offers in one call. Use this when comparing multiple games. Much more efficient than calling get_offer_details multiple times.",
		inputSchema: z.object({
			offerIds: z.array(z.string()).describe("Array of offer IDs to get details for"),
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
			"Get current pricing information for a SINGLE offer. For multiple offers, use get_offer_prices (plural) instead - it's more efficient. IMPORTANT: For accurate game prices, use offer IDs from BASE_GAME offers only (not DLC, EDITION, or BUNDLE).",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID to get price for (should be a BASE_GAME offer for accurate pricing)"),
			country: z
				.string()
				.optional()
				.describe("Country code for regional pricing (default: US)"),
		}),
		execute: async ({ offerId, country }, _options: ToolOptions) => {
			const data = await apiRequest(`/offers/${offerId}/price`, { country: country || "US" });
			return addFormattedPrices(data);
		},
	}),

	get_offer_prices: tool({
		description:
			"Get current pricing for MULTIPLE offers in one call. Use this when comparing prices of multiple games (e.g., top sellers comparison). Much more efficient than calling get_offer_price multiple times. IMPORTANT: For accurate game prices, use offer IDs from BASE_GAME offers only (not DLC, EDITION, or BUNDLE).",
		inputSchema: z.object({
			offerIds: z.array(z.string()).describe("Array of offer IDs to get prices for (should be BASE_GAME offers for accurate pricing)"),
			country: z
				.string()
				.optional()
				.describe("Country code for regional pricing (default: US)"),
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
			"Get historical pricing data for a game to see past discounts and price changes. Returns pre-formatted prices.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID to get price history for"),
			country: z
				.string()
				.optional()
				.describe("Country code for regional pricing (default: US)"),
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
			"Get currently free games on Epic Games Store, including both PC and mobile giveaways. This is the most important tool for finding what games are currently free.",
		inputSchema: z.object({
			country: z
				.string()
				.optional()
				.describe("Country code for regional info (default: US)"),
		}),
		execute: async ({ country }, _options: ToolOptions) =>
			apiRequest("/free-games", { country: country || "US" }),
	}),

	get_free_games_history: tool({
		description:
			"Get history of past free game giveaways on Epic Games Store. Returns paginated results (not a total count). Use this to see recent/past giveaways, but NOT for counting total giveaways per year.",
		inputSchema: z.object({
			country: z.string().optional().describe("Country code (default: US)"),
			limit: z.number().optional().describe("Results per page (max 25)"),
			page: z.number().optional().describe("Page number"),
		}),
		execute: async ({ country, limit, page }, _options: ToolOptions) =>
			apiRequest("/free-games/history", {
				country: country || "US",
				limit: String(limit || 10),
				page: String(page || 1),
			}),
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
			"Get the current top selling games on Epic Games Store with ranking positions. NOTE: This returns game titles and IDs only - NO price data. To get prices, you must call get_offer_price for each game ID.",
		inputSchema: z.object({
			limit: z.number().optional().describe("Number of results (default: 10)"),
			page: z.number().optional().describe("Page number"),
		}),
		execute: async ({ limit, page }, _options: ToolOptions) =>
			apiRequest("/offers/top-sellers", {
				limit: String(limit || 10),
				page: String(page || 1),
			}),
	}),

	get_top_wishlisted: tool({
		description: "Get the most wishlisted games on Epic Games Store. NOTE: This returns game titles and IDs only - NO price data. To get prices, you must call get_offer_price for each game ID.",
		inputSchema: z.object({
			limit: z.number().optional().describe("Number of results (default: 10)"),
			page: z.number().optional().describe("Page number"),
		}),
		execute: async ({ limit, page }, _options: ToolOptions) =>
			apiRequest("/offers/top-wishlisted", {
				limit: String(limit || 10),
				page: String(page || 1),
			}),
	}),

	get_featured_discounts: tool({
		description: "Get currently featured games with active discounts.",
		inputSchema: z.object({}),
		execute: async (_args, _options: ToolOptions) =>
			apiRequest("/offers/featured-discounts"),
	}),

	get_upcoming_games: tool({
		description: "Get upcoming game releases on Epic Games Store.",
		inputSchema: z.object({
			limit: z.number().optional().describe("Number of results"),
			page: z.number().optional().describe("Page number"),
		}),
		execute: async ({ limit, page }, _options: ToolOptions) =>
			apiRequest("/offers/upcoming", {
				limit: String(limit || 10),
				page: String(page || 1),
			}),
	}),

	get_latest_releases: tool({
		description: "Get the most recently released games on Epic Games Store.",
		inputSchema: z.object({
			limit: z.number().optional().describe("Number of results"),
			page: z.number().optional().describe("Page number"),
		}),
		execute: async ({ limit, page }, _options: ToolOptions) =>
			apiRequest("/offers/latest-released", {
				limit: String(limit || 10),
				page: String(page || 1),
			}),
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
			"Get all items (executables/entitlements) for a SINGLE offer. For multiple offers, use get_offers_items (plural) instead. IMPORTANT: For accurate download sizes, use offer IDs from BASE_GAME offers only.",
		inputSchema: z.object({
			offerId: z.string().describe("The offer ID to get items for (should be a BASE_GAME offer for accurate download sizes)"),
		}),
		execute: async ({ offerId }, _options: ToolOptions) =>
			apiRequest(`/offers/${offerId}/items`),
	}),

	get_offers_items: tool({
		description:
			"Get items (executables/entitlements) for MULTIPLE offers in one call. Use this when comparing download sizes of multiple games. Returns item IDs that can be used with get_items_assets. IMPORTANT: For accurate download sizes, use offer IDs from BASE_GAME offers only.",
		inputSchema: z.object({
			offerIds: z.array(z.string()).describe("Array of offer IDs to get items for (should be BASE_GAME offers for accurate download sizes)"),
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
			"Get asset/build information for a SINGLE item. For multiple items, use get_items_assets (plural) instead.",
		inputSchema: z.object({
			itemId: z.string().describe("The item ID to get assets for"),
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
			"Get asset/build information for MULTIPLE items in one call. Use this when comparing download sizes of multiple games. Returns pre-formatted sizes (downloadSize, installedSize).",
		inputSchema: z.object({
			itemIds: z.array(z.string()).describe("Array of item IDs to get assets for"),
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
