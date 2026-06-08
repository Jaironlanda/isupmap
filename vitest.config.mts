import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs tests inside workerd (via Miniflare) so D1, bindings and the Workers
// fetch mock behave like production. Bindings (DB, etc.) are read from
// wrangler.jsonc; the local D1 is in-memory and isolated per test.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				compatibilityFlags: ["nodejs_compat"],
				// wrangler.jsonc ships VOTE_SALT="" (public default); the report
				// write path fails closed on an empty salt, so give tests a real one.
				bindings: { VOTE_SALT: "test-salt" },
			},
		}),
	],
	test: {
		// fast-xml-parser uses internal CJS requires that workerd can't resolve
		// at runtime; pre-bundle it so it loads as a single module.
		// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution
		deps: {
			optimizer: {
				ssr: { enabled: true, include: ["fast-xml-parser"] },
			},
		},
	},
});
