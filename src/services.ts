/**
 * Curated list of services shown on the IsUp heatmap.
 *
 * Each service declares a `source` describing how its current status is
 * resolved (see src/sources.ts):
 *   - `statuspage`: Atlassian Statuspage site. We read `{base}/api/v2/status.json`,
 *                   which exposes an authoritative current-status indicator.
 *   - `slack`:      Slack's bespoke status API (not Atlassian Statuspage).
 *   - `rss`:        An RSS/Atom incident feed. Status is inferred heuristically
 *                   from the most recent entry.
 *   - `http`:       A plain HTTP request to a URL; status derives from the
 *                   response code. Last-resort for services with no status feed.
 *
 * `weight` is a relative prominence used to size tiles in the treemap (the
 * stock-map look) — bigger services get bigger tiles. It carries no meaning
 * beyond layout.
 */

export type StatusLevel = "up" | "degraded" | "down" | "unknown";

export type ServiceSource =
	| { type: "statuspage"; base: string }
	| { type: "slack" } // Slack's status page exposes a bespoke (non-Statuspage) JSON API.
	| { type: "rss"; url: string }
	| { type: "http"; url: string };

export interface Service {
	id: string;
	name: string;
	category: string;
	weight: number;
	source: ServiceSource;
}

/** Extra context shown in the hover card. All fields optional/best-effort. */
export interface ServiceDetails {
	/** Link to the upstream status page. */
	url?: string;
	/** When the upstream status was last updated (ISO string). */
	updatedAt?: string;
	/** Component-level rollup (Statuspage only). */
	components?: { operational: number; total: number; impacted: string[] };
	/** Most relevant active incident, if any. */
	incident?: { name: string; impact?: string; url?: string; updatedAt?: string };
	/** Freeform note, e.g. HTTP latency or feed timestamp. */
	note?: string;
}

/** The normalized result returned for each service by the API. */
export interface ServiceStatus {
	id: string;
	name: string;
	category: string;
	weight: number;
	status: StatusLevel;
	/** Human-readable description of the current state / latest incident. */
	description: string;
	/** Optional richer data surfaced on hover. */
	details?: ServiceDetails;
}

export const SERVICES: Service[] = [
	// --- Developer & Cloud ---
	{ id: "github", name: "GitHub", category: "Developer & Cloud", weight: 9, source: { type: "statuspage", base: "https://www.githubstatus.com" } },
	{ id: "cloudflare", name: "Cloudflare", category: "Developer & Cloud", weight: 8, source: { type: "statuspage", base: "https://www.cloudflarestatus.com" } },
	{ id: "npm", name: "npm", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://status.npmjs.org" } },
	{ id: "digitalocean", name: "DigitalOcean", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.digitalocean.com" } },
	{ id: "vercel", name: "Vercel", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://www.vercel-status.com" } },
	{ id: "netlify", name: "Netlify", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://www.netlifystatus.com" } },
	{ id: "mongodb", name: "MongoDB", category: "Developer & Cloud", weight: 6, source: { type: "statuspage", base: "https://status.mongodb.com" } },
	{ id: "sentry", name: "Sentry", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.sentry.io" } },
	{ id: "circleci", name: "CircleCI", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.circleci.com" } },
	{ id: "linode", name: "Linode", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.linode.com" } },
	{ id: "render", name: "Render", category: "Developer & Cloud", weight: 3, source: { type: "statuspage", base: "https://status.render.com" } },
	// AWS publishes an RSS feed rather than a Statuspage site — exercises the RSS path.
	{ id: "aws", name: "AWS", category: "Developer & Cloud", weight: 10, source: { type: "rss", url: "https://status.aws.amazon.com/rss/all.rss" } },

	// --- AI ---
	{ id: "openai", name: "OpenAI", category: "AI", weight: 8, source: { type: "statuspage", base: "https://status.openai.com" } },
	{ id: "anthropic", name: "Anthropic", category: "AI", weight: 7, source: { type: "statuspage", base: "https://status.claude.com" } },

	// --- Payments ---
	{ id: "stripe", name: "Stripe", category: "Payments", weight: 7, source: { type: "statuspage", base: "https://www.stripestatus.com" } },
	{ id: "coinbase", name: "Coinbase", category: "Payments", weight: 5, source: { type: "statuspage", base: "https://status.coinbase.com" } },
	{ id: "shopify", name: "Shopify", category: "Payments", weight: 6, source: { type: "statuspage", base: "https://www.shopifystatus.com" } },
	{ id: "plaid", name: "Plaid", category: "Payments", weight: 4, source: { type: "statuspage", base: "https://status.plaid.com" } },

	// --- Communication ---
	{ id: "discord", name: "Discord", category: "Communication", weight: 6, source: { type: "statuspage", base: "https://discordstatus.com" } },
	{ id: "slack", name: "Slack", category: "Communication", weight: 7, source: { type: "slack" } },
	{ id: "zoom", name: "Zoom", category: "Communication", weight: 6, source: { type: "statuspage", base: "https://www.zoomstatus.com" } },
	{ id: "twilio", name: "Twilio", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.twilio.com" } },
	{ id: "sendgrid", name: "SendGrid", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.sendgrid.com" } },

	// --- Productivity & Media ---
	{ id: "atlassian", name: "Atlassian", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.atlassian.com" } },
	{ id: "dropbox", name: "Dropbox", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.dropbox.com" } },
	{ id: "datadog", name: "Datadog", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.datadoghq.com" } },
	{ id: "reddit", name: "Reddit", category: "Productivity & Media", weight: 6, source: { type: "statuspage", base: "https://www.redditstatus.com" } },
	{ id: "figma", name: "Figma", category: "Productivity & Media", weight: 6, source: { type: "statuspage", base: "https://status.figma.com" } },
	{ id: "box", name: "Box", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.box.com" } },
	{ id: "squarespace", name: "Squarespace", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.squarespace.com" } },
	// Wikipedia has no public status feed — a plain reachability ping demonstrates the HTTP path.
	{ id: "wikipedia", name: "Wikipedia", category: "Productivity & Media", weight: 7, source: { type: "http", url: "https://www.wikipedia.org" } },

	// --- Gaming & Entertainment ---
	{ id: "twitch", name: "Twitch", category: "Gaming & Entertainment", weight: 7, source: { type: "statuspage", base: "https://status.twitch.com" } },
	{ id: "epicgames", name: "Epic Games", category: "Gaming & Entertainment", weight: 6, source: { type: "statuspage", base: "https://status.epicgames.com" } },
];
