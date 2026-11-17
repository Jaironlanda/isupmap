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
 *   - `aws-health`: The AWS Health Dashboard's public current-events JSON
 *                   (the legacy status.aws.amazon.com RSS stopped receiving
 *                   new events in Sep 2026).
 *   - `docusign`:   DocuSign's status-center JSON (status.docusign.com moved
 *                   off Statuspage to health.docusign.com in 2026).
 *   - `statusio`:   status.io's public status API (overall + per-component codes).
 *   - `playstation`: PlayStation Network's per-region status JSON.
 *
 * `weight` is a relative prominence used to size tiles in the treemap (the
 * stock-map look) — bigger services get bigger tiles. It carries no meaning
 * beyond layout.
 */

export type StatusLevel = "up" | "degraded" | "down" | "unknown";

export type ServiceSource =
	// excludeGroups: component-group names to ignore; the indicator is then recomputed
	// from the remaining components + incidents (for per-location noise, e.g. Cloudflare PoPs).
	// components: count only these component names (and incidents naming them) — for a service
	// listed as one component on another provider's page (e.g. Replicate on cloudflarestatus.com).
	// extraBases: sibling Statuspage pages merged in (worst indicator wins) — for a vendor whose hub page
	// carries none of its per-product pages' incidents (Atlassian).
	| { type: "statuspage"; base: string; excludeGroups?: string[]; components?: string[]; extraBases?: string[]; statusUrl?: string }
	// statusUrl overrides the "Visit status page" link (defaults to feed URL origin).
	// titleTags: count only entries whose title starts with "[Tag]" for one of these tags (case-insensitive) —
	// for a feed shared by several products, e.g. status.x.ai covers both Grok and Cursor.
	| { type: "rss"; url: string; statusUrl?: string; titleTags?: string[] }
	| { type: "http"; url: string; statusUrl?: string } // statusUrl overrides when the ping URL isn't the status page
	| { type: "aws-health"; url: string; statusUrl?: string } // AWS Health Dashboard current-events JSON
	| { type: "docusign"; url: string; statusUrl?: string } // DocuSign status center JSON (components.json + incidents.json under url)
	| { type: "statusio"; pageId: string; statusUrl?: string } // status.io public API (api.status.io/1.0/status/{pageId})
	// PlayStation status JSON per region; ignoreCountries skips standing country restrictions.
	| { type: "playstation"; regions: string[]; ignoreCountries?: string[]; statusUrl?: string };

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
	// Cloudflare lists ~345 datacenters (PoPs) in regional groups alongside its products;
	// dozens are always "Re-routed" or in maintenance, which pinned the indicator at
	// `minor` (degraded continuously since 2026-06-03). Ignore the regional groups and
	// judge by the "Cloudflare Sites and Services" products + incidents instead.
	{ id: "cloudflare", name: "Cloudflare", category: "Developer & Cloud", weight: 8, source: { type: "statuspage", base: "https://www.cloudflarestatus.com", excludeGroups: ["North America", "Europe", "Asia", "Africa", "Middle East", "Oceania", "Latin America & the Caribbean"] } },
	{ id: "npm", name: "npm", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://status.npmjs.org" } },
	{ id: "digitalocean", name: "DigitalOcean", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.digitalocean.com" } },
	{ id: "vercel", name: "Vercel", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://www.vercel-status.com" } },
	{ id: "netlify", name: "Netlify", category: "Developer & Cloud", weight: 5, source: { type: "statuspage", base: "https://www.netlifystatus.com" } },
	{ id: "mongodb", name: "MongoDB", category: "Developer & Cloud", weight: 6, source: { type: "statuspage", base: "https://status.mongodb.com" } },
	{ id: "sentry", name: "Sentry", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.sentry.io" } },
	{ id: "circleci", name: "CircleCI", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.circleci.com" } },
	{ id: "linode", name: "Linode", category: "Developer & Cloud", weight: 4, source: { type: "statuspage", base: "https://status.linode.com" } },
	{ id: "render", name: "Render", category: "Developer & Cloud", weight: 3, source: { type: "statuspage", base: "https://status.render.com" } },
	// AWS: the Health Dashboard's current-events JSON. The legacy status.aws.amazon.com
	// RSS stopped receiving new events after 2026-09-15 (six later incidents never
	// appeared in it), so it silently read as "up" through real outages.
	{ id: "aws", name: "AWS", category: "Developer & Cloud", weight: 10, source: { type: "aws-health", url: "https://health.aws.amazon.com/public/currentevents", statusUrl: "https://health.aws.amazon.com/health/status" } },
	// Google Cloud publishes an Atom incident feed (not an Atlassian Statuspage).
	{ id: "gcp", name: "Google Cloud", category: "Developer & Cloud", weight: 10, source: { type: "rss", url: "https://status.cloud.google.com/en/feed.atom", statusUrl: "https://status.cloud.google.com/" } },
	// Azure's feed lists only *active* incidents, so an empty channel is the normal
	// healthy state (it matches the page's "There are currently no active events").
	{ id: "azure", name: "Microsoft Azure", category: "Developer & Cloud", weight: 10, source: { type: "rss", url: "https://azure.status.microsoft/en-us/status/feed/", statusUrl: "https://azure.status.microsoft/en-us/status" } },
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
	// Docker moved from status.io to incident.io, which serves a Statuspage-compatible
	// summary.json (the old status.io RSS URL now 404s).
	{ id: "docker", name: "Docker", category: "Developer & Cloud", weight: 6, source: { type: "statuspage", base: "https://www.dockerstatus.com" } },
	// Appwrite moved to appwrite.online (status.appwrite.io redirects there); it publishes
	// an Atom feed with one entry per update and the state as a title suffix ("…: Resolved").
	{ id: "appwrite", name: "Appwrite", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://appwrite.online/feed.atom", statusUrl: "https://appwrite.online" } },
	// Firebase publishes an Atom incident feed.
	{ id: "firebase", name: "Firebase", category: "Developer & Cloud", weight: 7, source: { type: "rss", url: "https://status.firebase.google.com/en/feed.atom", statusUrl: "https://status.firebase.google.com" } },
	// Firecrawl uses Betterstack — RSS feed confirmed working.
	{ id: "firecrawl", name: "Firecrawl", category: "Developer & Cloud", weight: 4, source: { type: "rss", url: "https://status.firecrawl.dev/feed.rss", statusUrl: "https://status.firecrawl.dev" } },

	// --- AI ---
	{ id: "openai", name: "OpenAI", category: "AI", weight: 8, source: { type: "rss", url: "https://status.openai.com/feed.rss", statusUrl: "https://status.openai.com" } },
	{ id: "anthropic", name: "Anthropic", category: "AI", weight: 7, source: { type: "statuspage", base: "https://status.claude.com" } },
	// status.x.ai is a combined SpaceXAI page for Grok *and* Cursor (status.cursor.com now
	// redirects there). Its Statuspage JSON sits behind a Cloudflare bot challenge (403), but
	// feed.xml is open; each entry is titled "[Component] …", so each tile keeps its own tags.
	{ id: "xai", name: "xAI", category: "AI", weight: 6, source: { type: "rss", url: "https://status.x.ai/feed.xml", statusUrl: "https://status.x.ai", titleTags: ["Global (api.x.ai)", "US (us.api.x.ai)", "grok.com", "Grok Bot", "Grok (iOS)", "Grok (Android)", "Grok (Build)", "Grok in X", "Grok (Office/Workspace Plugins)", "Voice", "Imagine"] } },
	{ id: "groq", name: "Groq", category: "AI", weight: 5, source: { type: "statuspage", base: "https://groqstatus.com" } },
	{ id: "elevenlabs", name: "ElevenLabs", category: "AI", weight: 5, source: { type: "statuspage", base: "https://status.elevenlabs.io" } },
	{ id: "cohere", name: "Cohere", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.cohere.com" } },
	// Replicate is now part of Cloudflare: replicatestatus.com redirects to cloudflarestatus.com,
	// where Replicate is a single component.
	{ id: "replicate", name: "Replicate", category: "AI", weight: 4, source: { type: "statuspage", base: "https://www.cloudflarestatus.com", components: ["Replicate"], statusUrl: "https://www.cloudflarestatus.com/services?search=replicate" } },
	{ id: "pinecone", name: "Pinecone", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.pinecone.io" } },
	{ id: "runway", name: "Runway", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.runwayml.com" } },
	// Hugging Face uses Betterstack — RSS is the reliable path.
	{ id: "huggingface", name: "Hugging Face", category: "AI", weight: 7, source: { type: "rss", url: "https://status.huggingface.co/feed.rss" } },
	// Together AI uses Betterstack — RSS is the reliable path.
	{ id: "togetherai", name: "Together AI", category: "AI", weight: 5, source: { type: "rss", url: "https://status.together.ai/feed.rss" } },
	// Perplexity moved from Instatus to incident.io (the old /default/history.rss now 404s),
	// which serves a Statuspage-compatible summary.json.
	{ id: "perplexity", name: "Perplexity", category: "AI", weight: 6, source: { type: "statuspage", base: "https://status.perplexity.com" } },
	{ id: "stability", name: "Stability AI", category: "AI", weight: 5, source: { type: "statuspage", base: "https://status.stability.ai" } },
	{ id: "deepgram", name: "Deepgram", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.deepgram.com" } },
	{ id: "assemblyai", name: "AssemblyAI", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.assemblyai.com" } },
	// Cursor's status moved onto the combined status.x.ai page (see xAI above).
	{ id: "cursor", name: "Cursor", category: "AI", weight: 6, source: { type: "rss", url: "https://status.x.ai/feed.xml", statusUrl: "https://status.x.ai", titleTags: ["cursor.com", "Cursor IDE (Desktop)", "Cursor IDE (iOS)", "CLI", "Cloud Agents", "Automations", "Review Agents", "Third-party models", "Enterprise Dashboard", "Origin"] } },
	{ id: "cerebras", name: "Cerebras", category: "AI", weight: 4, source: { type: "statuspage", base: "https://status.cerebras.ai" } },
	// Fireworks AI uses a custom status page — RSS is the reliable path.
	{ id: "fireworksai", name: "Fireworks AI", category: "AI", weight: 4, source: { type: "rss", url: "https://status.fireworks.ai/feed.rss", statusUrl: "https://status.fireworks.ai" } },
	// DeepSeek's status page (Flashduty) publishes an RSS incident feed.
	{ id: "deepseek", name: "DeepSeek", category: "AI", weight: 7, source: { type: "rss", url: "https://status.deepseek.com/history.rss", statusUrl: "https://status.deepseek.com" } },
	// Mistral AI's status page serves a Statuspage-compatible summary.json (its HTML sits behind a
	// Cloudflare challenge, so the old HTTP ping always read the 403 as "up").
	{ id: "mistral", name: "Mistral AI", category: "AI", weight: 6, source: { type: "statuspage", base: "https://status.mistral.ai" } },

	// --- Payments ---
	{ id: "stripe", name: "Stripe", category: "Payments", weight: 7, source: { type: "statuspage", base: "https://www.stripestatus.com" } },
	{ id: "coinbase", name: "Coinbase", category: "Payments", weight: 5, source: { type: "statuspage", base: "https://status.coinbase.com" } },
	{ id: "shopify", name: "Shopify", category: "Payments", weight: 6, source: { type: "statuspage", base: "https://www.shopifystatus.com" } },
	{ id: "plaid", name: "Plaid", category: "Payments", weight: 4, source: { type: "statuspage", base: "https://status.plaid.com" } },
	{ id: "paddle", name: "Paddle", category: "Payments", weight: 3, source: { type: "statuspage", base: "https://paddlestatus.com" } },
	// Lemon Squeezy's Oh Dear page serves its feed on its own domain (the old
	// ohdear.app/…/subscribe-rss URL is now an HTML subscribe page). Entries are
	// monitor events: "Checkout appears to be down." / "Checkout has recovered."
	{ id: "lemonsqueezy", name: "Lemon Squeezy", category: "Payments", weight: 3, source: { type: "rss", url: "https://status.lemonsqueezy.com/rss", statusUrl: "https://status.lemonsqueezy.com" } },
	{ id: "square", name: "Square", category: "Payments", weight: 5, source: { type: "statuspage", base: "https://www.issquareup.com" } },
	{ id: "klarna", name: "Klarna", category: "Payments", weight: 4, source: { type: "statuspage", base: "https://status.klarna.com" } },
	// PayPal uses a custom status page (not Atlassian Statuspage) — RSS is the reliable path.
	{ id: "paypal", name: "PayPal", category: "Payments", weight: 8, source: { type: "rss", url: "https://www.paypal-status.com/feed/rss", statusUrl: "https://www.paypal-status.com/product/production" } },

	// --- Communication ---
	{ id: "discord", name: "Discord", category: "Communication", weight: 6, source: { type: "statuspage", base: "https://discordstatus.com" } },
	{ id: "slack", name: "Slack", category: "Communication", weight: 7, source: { type: "rss", url: "https://slack-status.com/feed/rss", statusUrl: "https://slack-status.com" } },
	{ id: "zoom", name: "Zoom", category: "Communication", weight: 6, source: { type: "statuspage", base: "https://www.zoomstatus.com" } },
	// Twilio's "CARRIER NETWORK" group tracks third-party carriers (e.g. "SMS Delivery Delays from
	// Twilio to Sky United Kingdom"); several are always open, pinning the tile degraded — ignore it.
	{ id: "twilio", name: "Twilio", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.twilio.com", excludeGroups: ["CARRIER NETWORK"] } },
	// status.sendgrid.com redirects to status.twilio.com; count only the SendGrid components there.
	{ id: "sendgrid", name: "SendGrid", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.twilio.com", statusUrl: "https://status.twilio.com", components: ["API v2", "API v3", "SMTP", "Event Webhooks", "Parse API", "SendGrid API", "SendGrid Website", "SendGrid Marketing Campaigns", "SendGrid Legacy Marketing Campaigns", "SendGrid Statistics", "SendGrid Email Activity", "SendGrid Partners", "SendGrid Billing"] } },
	{ id: "resend", name: "Resend", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://resend-status.com" } },
	{ id: "mailgun", name: "Mailgun", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://status.mailgun.com" } },
	// Intercom's status page moved to finstatus.com (intercomstatus.com redirects to its HTML home,
	// breaking the API path). It's an incident.io parent page; incidents cover Intercom and Fin.
	{ id: "intercom", name: "Intercom", category: "Communication", weight: 4, source: { type: "statuspage", base: "https://www.finstatus.com" } },
	{ id: "hubspot", name: "HubSpot", category: "Communication", weight: 5, source: { type: "statuspage", base: "https://status.hubspot.com" } },

	// --- Productivity & Media ---
	// status.atlassian.com is a hub: it links ~20 per-product pages and carries none of their
	// incidents (its last was 2025-03), so merge in the core products' pages.
	{ id: "atlassian", name: "Atlassian", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.atlassian.com", extraBases: ["https://jira-software.status.atlassian.com", "https://confluence.status.atlassian.com", "https://jira-service-management.status.atlassian.com"] } },
	{ id: "dropbox", name: "Dropbox", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.dropbox.com" } },
	// Datadog left Statuspage: the /api/v2 JSON now 403s (S3 AccessDenied), but the
	// Statuspage-format incident history feed is still published.
	{ id: "datadog", name: "Datadog", category: "Productivity & Media", weight: 4, source: { type: "rss", url: "https://status.datadoghq.com/history.rss", statusUrl: "https://status.datadoghq.com" } },
	{ id: "figma", name: "Figma", category: "Productivity & Media", weight: 6, source: { type: "statuspage", base: "https://status.figma.com" } },
	{ id: "box", name: "Box", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.box.com" } },
	{ id: "squarespace", name: "Squarespace", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.squarespace.com" } },
	// Wikimedia publishes a Statuspage (Reading / Editing components).
	{ id: "wikipedia", name: "Wikipedia", category: "Productivity & Media", weight: 7, source: { type: "statuspage", base: "https://www.wikimediastatus.net" } },
	{ id: "linear", name: "Linear", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://linearstatus.com" } },
	{ id: "notion", name: "Notion", category: "Productivity & Media", weight: 7, source: { type: "statuspage", base: "https://www.notion-status.com" } },
	{ id: "cloudinary", name: "Cloudinary", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.cloudinary.com" } },
	{ id: "asana", name: "Asana", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.asana.com" } },
	{ id: "airtable", name: "Airtable", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.airtable.com" } },
	{ id: "miro", name: "Miro", category: "Productivity & Media", weight: 5, source: { type: "statuspage", base: "https://status.miro.com" } },
	{ id: "canva", name: "Canva", category: "Productivity & Media", weight: 6, source: { type: "statuspage", base: "https://www.canvastatus.com" } },
	{ id: "webflow", name: "Webflow", category: "Productivity & Media", weight: 4, source: { type: "statuspage", base: "https://status.webflow.com" } },
	// status.docusign.com redirects to the new health.docusign.com status center (no Statuspage API).
	{ id: "docusign", name: "DocuSign", category: "Productivity & Media", weight: 4, source: { type: "docusign", url: "https://health.docusign.com/production/1ds/ssg/apps/health/dynamic", statusUrl: "https://health.docusign.com/status" } },

	// --- Gaming & Entertainment ---
	{ id: "twitch", name: "Twitch", category: "Gaming & Entertainment", weight: 7, source: { type: "statuspage", base: "https://status.twitch.com" } },
	{ id: "epicgames", name: "Epic Games", category: "Gaming & Entertainment", weight: 6, source: { type: "statuspage", base: "https://status.epicgames.com" } },
	// Netflix has no public status API (its "is-netflix-down" page is JS-rendered),
	// so we fall back to a reachability ping of the main site.
	{ id: "netflix", name: "Netflix", category: "Gaming & Entertainment", weight: 9, source: { type: "http", url: "https://www.netflix.com" } },
	// Roblox uses status.io — its public API gives authoritative overall and per-component codes.
	{ id: "roblox", name: "Roblox", category: "Gaming & Entertainment", weight: 8, source: { type: "statusio", pageId: "59db90dbcdeb2f04dadcf16d", statusUrl: "https://status.roblox.com" } },
	// The services below lack a public status JSON/RSS feed, so we fall back to reachability pings.
	{ id: "steam", name: "Steam", category: "Gaming & Entertainment", weight: 8, source: { type: "http", url: "https://store.steampowered.com" } },
	// status.playstation.com serves per-region JSON (Americas, Europe, Japan/Asia). Russia carries
	// standing store/account "outages" (Sony's restrictions there), so it's not counted.
	{ id: "playstation", name: "PlayStation Network", category: "Gaming & Entertainment", weight: 7, source: { type: "playstation", regions: ["SCEA", "SCEE", "SCEJA"], ignoreCountries: ["RU"], statusUrl: "https://status.playstation.com" } },
	// Riot's status page is per game and per shard (CDN JSON) — no single feed, so ping the site.
	{ id: "riot", name: "Riot Games", category: "Gaming & Entertainment", weight: 6, source: { type: "http", url: "https://www.riotgames.com", statusUrl: "https://status.riotgames.com" } },
	{ id: "spotify", name: "Spotify", category: "Gaming & Entertainment", weight: 9, source: { type: "http", url: "https://open.spotify.com" } },

	// --- Social Media ---
	// Social platforms generally publish no machine-readable status feed (and often
	// none at all — see "Main reason companies disable status pages"), so we fall
	// back to a plain reachability ping of the main site, like Netflix/Spotify above.
	{ id: "x", name: "X (Twitter)", category: "Social Media", weight: 9, source: { type: "http", url: "https://x.com" } },
	{ id: "facebook", name: "Facebook", category: "Social Media", weight: 9, source: { type: "http", url: "https://www.facebook.com" } },
	{ id: "instagram", name: "Instagram", category: "Social Media", weight: 9, source: { type: "http", url: "https://www.instagram.com" } },
	{ id: "youtube", name: "YouTube", category: "Social Media", weight: 9, source: { type: "http", url: "https://www.youtube.com" } },
	{ id: "tiktok", name: "TikTok", category: "Social Media", weight: 8, source: { type: "http", url: "https://www.tiktok.com" } },
	{ id: "whatsapp", name: "WhatsApp", category: "Social Media", weight: 8, source: { type: "http", url: "https://www.whatsapp.com" } },
	{ id: "linkedin", name: "LinkedIn", category: "Social Media", weight: 7, source: { type: "http", url: "https://www.linkedin.com" } },
	{ id: "telegram", name: "Telegram", category: "Social Media", weight: 7, source: { type: "http", url: "https://telegram.org" } },
	// Reddit has a real Statuspage feed, unlike the ping-only platforms above.
	{ id: "reddit", name: "Reddit", category: "Social Media", weight: 6, source: { type: "statuspage", base: "https://www.redditstatus.com" } },
	{ id: "pinterest", name: "Pinterest", category: "Social Media", weight: 6, source: { type: "http", url: "https://www.pinterest.com" } },
	// status.snap.com is unreachable from automated clients, so we ping the main site.
	{ id: "snapchat", name: "Snapchat", category: "Social Media", weight: 6, source: { type: "http", url: "https://www.snapchat.com" } },
	// Bluesky also has a real Statuspage feed (bluesky.statuspage.io) if richer data is wanted later.
	{ id: "bluesky", name: "Bluesky", category: "Social Media", weight: 5, source: { type: "http", url: "https://bsky.app", statusUrl: "https://bluesky.statuspage.io" } },
	{ id: "threads", name: "Threads", category: "Social Media", weight: 5, source: { type: "http", url: "https://www.threads.net" } },
	{ id: "mastodon", name: "Mastodon", category: "Social Media", weight: 4, source: { type: "http", url: "https://mastodon.social", statusUrl: "https://mastodon.social/about" } },
	{ id: "tumblr", name: "Tumblr", category: "Social Media", weight: 3, source: { type: "http", url: "https://www.tumblr.com" } },
];
