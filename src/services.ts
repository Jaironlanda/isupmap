/**
 * Curated list of services shown on the isUpMap heatmap.
 *
 * Each service declares a `source` describing how its current status is
 * resolved (see src/sources.ts):
 *   - `statuspage`: Atlassian Statuspage site. We read `{base}/api/v2/status.json`,
 *                   which exposes an authoritative current-status indicator.
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
	| { type: "rss"; url: string; statusUrl?: string } // statusUrl overrides the "Visit status page" link (defaults to feed URL origin)
	| { type: "http"; url: string; statusUrl?: string }; // statusUrl overrides when the ping URL isn't the status page

export interface Service {
	id: string;
	name: string;
	category: string;
	weight: number;
	source: ServiceSource;
	/**
	 * If set, the service is shown as permanently `unknown` (grey) and cannot be
	 * resolved/selected — its upstream no longer publishes a usable status feed.
	 * The string is the human-readable reason, surfaced in the Customize panel on
	 * hover. Disabled services are skipped by the resolver (no fetch).
	 */
	disabled?: string;
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
	/** Reason the service is disabled (unreliable source), if applicable. */
	disabled?: string;
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
	// Google Cloud publishes an Atom incident feed (not an Atlassian Statuspage).
	{ id: "gcp", name: "Google Cloud", category: "Developer & Cloud", weight: 10, source: { type: "rss", url: "https://status.cloud.google.com/en/feed.atom", statusUrl: "https://status.cloud.google.com/" } },
	// Azure's global status feed no longer publishes machine-readable incident
	// items (empty channel), so its status can't be resolved reliably.
	{ id: "azure", name: "Microsoft Azure", category: "Developer & Cloud", weight: 10, source: { type: "rss", url: "https://azure.status.microsoft/en-us/status/feed/", statusUrl: "https://azure.status.microsoft/en-us/status" }, disabled: "Azure's status feed no longer publishes machine-readable incidents, so its status can't be resolved." },
	{ id: "supabase", name: "Supabase", category: "Developer & Cloud", weight: 6, source: { type: "statuspage", base: "https://status.supabase.com" } },
	{ id: "flyio", name: "Fly.io", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://status.flyio.net" } },
	// Railway moved to a JS-rendered status page (status.railway.com) with no
	// machine-readable feed; the old Betterstack feed is empty/abandoned.
	{ id: "railway", name: "Railway", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://railway.betteruptime.com/feed.rss", statusUrl: "https://status.railway.com" }, disabled: "Railway's status page no longer exposes a machine-readable feed, so its status can't be resolved." },
	// Neon uses status.io — RSS is the reliable path.
	{ id: "neon", name: "Neon", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://neonstatus.com/pages/6878fc85709daa75be6c7e3c/rss" } },
	{ id: "planetscale", name: "PlanetScale", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://www.planetscalestatus.com" } },
	// Bunny.net CDN
	{ id: "bunny", name: "Bunny.net", category: "Developer & Cloud", weight: 3, source: { type: "statuspage", base: "https://status.bunny.net" } },
	// Auth0's Statuspage JSON (auth0.statuspage.io — status.auth0.com lacks the JSON API)
	// is stale: it reports a phantom "Minor Service Outage" with no active incident while
	// the live status page shows all systems operational, so it can't be trusted.
	{ id: "auth0", name: "Auth0", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://auth0.statuspage.io" }, disabled: "Auth0's status feed is stale — it reports a phantom 'minor outage' with no active incident while the live status page shows all systems operational." },
	{ id: "clerk", name: "Clerk", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.clerk.com" } },
	{ id: "hashicorp", name: "HashiCorp", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.hashicorp.com" } },
	{ id: "snowflake", name: "Snowflake", category: "Developer & Cloud", weight: 6, source: { type: "statuspage", base: "https://status.snowflake.com" } },
	{ id: "elastic", name: "Elastic", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.elastic.co" } },
	{ id: "newrelic", name: "New Relic", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.newrelic.com" } },
	{ id: "grafana", name: "Grafana", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.grafana.com" } },
	// PagerDuty & Algolia migrated to JS-rendered status pages — their RSS feeds
	// now return an HTML document instead of XML, so neither can be parsed.
	{ id: "pagerduty", name: "PagerDuty", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://status.pagerduty.com/history.rss" }, disabled: "PagerDuty's RSS feed now returns an HTML page instead of a feed, so its status can't be resolved." },
	{ id: "algolia", name: "Algolia", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://status.algolia.com/history.rss" }, disabled: "Algolia's RSS feed now returns an HTML page instead of a feed, so its status can't be resolved." },
	// GitLab uses status.io (not Atlassian Statuspage) — RSS is the reliable path.
	{ id: "gitlab", name: "GitLab", category: "Developer & Cloud", weight: 6, source: { type: "rss", url: "https://status.gitlab.com/pages/5b36dc6502d06804c08349f7/rss" } },
	// Docker uses status.io (not Atlassian Statuspage) — RSS is the reliable path.
	{ id: "docker", name: "Docker", category: "Developer & Cloud", weight: 6, source: { type: "rss", url: "https://www.dockerstatus.com/pages/533c6539221ae15e3f000031/rss" } },
	// Appwrite uses Instatus — RSS is the reliable path.
	{ id: "appwrite", name: "Appwrite", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://status.appwrite.online/feed.rss" } },
	// Firebase publishes an Atom incident feed.
	{ id: "firebase", name: "Firebase", category: "Developer & Cloud", weight: 7, source: { type: "rss", url: "https://status.firebase.google.com/en/feed.atom", statusUrl: "https://status.firebase.google.com" } },

	// --- AI ---
	{ id: "openai", name: "OpenAI", category: "AI", weight: 8, source: { type: "rss", url: "https://status.openai.com/feed.rss", statusUrl: "https://status.openai.com" } },
	{ id: "anthropic", name: "Anthropic", category: "AI", weight: 7, source: { type: "statuspage", base: "https://status.claude.com" } },
	// status.x.ai's Statuspage JSON sits behind a Cloudflare bot challenge (403),
	// but its RSS feed is open — so resolve xAI via the feed.
	{ id: "xai", name: "xAI", category: "AI", weight: 6, source: { type: "rss", url: "https://status.x.ai/feed.xml" } },
	{ id: "groq", name: "Groq", category: "AI", weight: 5, source: { type: "statuspage", base: "https://groqstatus.com" } },
	{ id: "elevenlabs", name: "ElevenLabs", category: "AI", weight: 5, source: { type: "statuspage", base: "https://status.elevenlabs.io" } },
	{ id: "cohere", name: "Cohere", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.cohere.com" } },
	{ id: "replicate", name: "Replicate", category: "AI", weight: 4, source: { type: "statuspage", base: "https://www.replicatestatus.com" } },
	{ id: "pinecone", name: "Pinecone", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.pinecone.io" } },
	{ id: "runway", name: "Runway", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.runwayml.com" } },
	// Hugging Face uses Betterstack — RSS is the reliable path.
	{ id: "huggingface", name: "Hugging Face", category: "AI", weight: 7, source: { type: "rss", url: "https://status.huggingface.co/feed.rss" } },
	// Together AI uses Betterstack — RSS is the reliable path.
	{ id: "togetherai", name: "Together AI", category: "AI", weight: 5, source: { type: "rss", url: "https://status.together.ai/feed.rss" } },
	// Perplexity uses Instatus — RSS feed confirmed working.
	{ id: "perplexity", name: "Perplexity", category: "AI", weight: 6, source: { type: "rss", url: "https://status.perplexity.com/default/history.rss" } },
	{ id: "stability", name: "Stability AI", category: "AI", weight: 5, source: { type: "statuspage", base: "https://status.stability.ai" } },
	{ id: "deepgram", name: "Deepgram", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.deepgram.com" } },
	{ id: "assemblyai", name: "AssemblyAI", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.assemblyai.com" } },
	// Cursor publishes an RSS incident history feed.
	{ id: "cursor", name: "Cursor", category: "AI", weight: 6, source: { type: "rss", url: "https://status.cursor.com/history.rss" } },

	// --- Payments ---
	{ id: "stripe", name: "Stripe", category: "Payments", weight: 7, source: { type: "statuspage", base: "https://www.stripestatus.com" } },
	{ id: "coinbase", name: "Coinbase", category: "Payments", weight: 5, source: { type: "statuspage", base: "https://status.coinbase.com" } },
	{ id: "shopify", name: "Shopify", category: "Payments", weight: 6, source: { type: "statuspage", base: "https://www.shopifystatus.com" } },
	{ id: "plaid", name: "Plaid", category: "Payments", weight: 4, source: { type: "statuspage", base: "https://status.plaid.com" } },
	{ id: "paddle", name: "Paddle", category: "Payments", weight: 3, source: { type: "statuspage", base: "https://paddlestatus.com" } },
	// Lemon Squeezy's Oh Dear feed URL now serves an HTML subscribe page rather
	// than a feed, so its status can't be resolved.
	{ id: "lemonsqueezy", name: "Lemon Squeezy", category: "Payments", weight: 3, source: { type: "rss", url: "https://ohdear.app/status-page/lemon-squeezy-status/subscribe-rss", statusUrl: "https://status.lemonsqueezy.com" }, disabled: "Lemon Squeezy's status feed now returns an HTML page instead of a feed, so its status can't be resolved." },
	{ id: "square", name: "Square", category: "Payments", weight: 5, source: { type: "statuspage", base: "https://www.issquareup.com" } },
	{ id: "klarna", name: "Klarna", category: "Payments", weight: 4, source: { type: "statuspage", base: "https://status.klarna.com" } },
	// PayPal uses a custom status page (not Atlassian Statuspage) — RSS is the reliable path.
	{ id: "paypal", name: "PayPal", category: "Payments", weight: 8, source: { type: "rss", url: "https://www.paypal-status.com/feed/rss", statusUrl: "https://www.paypal-status.com/product/production" } },

	// --- Communication ---
	{ id: "discord", name: "Discord", category: "Communication", weight: 6, source: { type: "statuspage", base: "https://discordstatus.com" } },
	{ id: "slack", name: "Slack", category: "Communication", weight: 7, source: { type: "rss", url: "https://slack-status.com/feed/rss", statusUrl: "https://slack-status.com" } },
	{ id: "zoom", name: "Zoom", category: "Communication", weight: 6, source: { type: "statuspage", base: "https://www.zoomstatus.com" } },
	{ id: "twilio", name: "Twilio", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.twilio.com" } },
	{ id: "sendgrid", name: "SendGrid", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.sendgrid.com" } },
	{ id: "resend", name: "Resend", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://resend-status.com" } },
	{ id: "mailgun", name: "Mailgun", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.mailgun.com" } },
	{ id: "intercom", name: "Intercom", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://www.intercomstatus.com" } },
	{ id: "hubspot", name: "HubSpot", category: "Communication", weight: 5, source: { type: "statuspage", base: "https://status.hubspot.com" } },

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
	{ id: "linear", name: "Linear", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://linearstatus.com" } },
	{ id: "notion", name: "Notion", category: "Productivity & Media", weight: 7, source: { type: "statuspage", base: "https://www.notion-status.com" } },
	{ id: "cloudinary", name: "Cloudinary", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.cloudinary.com" } },
	{ id: "asana", name: "Asana", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.asana.com" } },
	{ id: "airtable", name: "Airtable", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.airtable.com" } },
	{ id: "miro", name: "Miro", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.miro.com" } },
	{ id: "canva", name: "Canva", category: "Productivity & Media", weight: 6, source: { type: "statuspage", base: "https://www.canvastatus.com" } },
	{ id: "webflow", name: "Webflow", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.webflow.com" } },
	{ id: "docusign", name: "DocuSign", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.docusign.com" } },

	// --- Gaming & Entertainment ---
	{ id: "twitch", name: "Twitch", category: "Gaming & Entertainment", weight: 7, source: { type: "statuspage", base: "https://status.twitch.com" } },
	{ id: "epicgames", name: "Epic Games", category: "Gaming & Entertainment", weight: 6, source: { type: "statuspage", base: "https://status.epicgames.com" } },
	// Netflix has no public status API (its "is-netflix-down" page is JS-rendered),
	// so we fall back to a reachability ping of the main site.
	{ id: "netflix", name: "Netflix", category: "Gaming & Entertainment", weight: 9, source: { type: "http", url: "https://www.netflix.com" } },
	// Roblox uses status.io — RSS is the reliable path.
	{ id: "roblox", name: "Roblox", category: "Gaming & Entertainment", weight: 8, source: { type: "rss", url: "https://status.roblox.com/pages/59db90dbcdeb2f04dadcf16d/rss" } },
	// The services below lack a public status JSON/RSS feed, so we fall back to reachability pings.
	{ id: "steam", name: "Steam", category: "Gaming & Entertainment", weight: 8, source: { type: "http", url: "https://store.steampowered.com" } },
	// PlayStation and Riot have dedicated status pages even though their feeds aren't machine-readable.
	{ id: "playstation", name: "PlayStation Network", category: "Gaming & Entertainment", weight: 7, source: { type: "http", url: "https://www.playstation.com", statusUrl: "https://status.playstation.com" } },
	{ id: "riot", name: "Riot Games", category: "Gaming & Entertainment", weight: 6, source: { type: "http", url: "https://www.riotgames.com", statusUrl: "https://status.riotgames.com" } },
	{ id: "spotify", name: "Spotify", category: "Gaming & Entertainment", weight: 9, source: { type: "http", url: "https://open.spotify.com" } },
];
