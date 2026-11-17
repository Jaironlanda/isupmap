/**
 * Fail if the gitignored production config has drifted from wrangler.jsonc.
 *
 *   node scripts/check-prod-config.mjs [path/to/prod.jsonc]
 *
 * wrangler.prod.jsonc is a full copy of wrangler.jsonc with real resource ids,
 * so a binding, cron or compatibility_date added to the public file is easy to
 * forget in prod — the deploy succeeds and `env.X` is undefined at runtime.
 * This compares the shape (binding names, runtime settings) and ignores what is
 * expected to differ (resource ids/names, var values). Vars are only checked
 * one way: a public var may be absent in prod because it is set as a secret.
 */

import { experimental_readRawConfig } from "wrangler";

const prodPath = process.argv[2] ?? "wrangler.prod.jsonc";
const read = (config) => experimental_readRawConfig({ config }).rawConfig;
const pub = read("wrangler.jsonc");
const prod = read(prodPath);

const bindings = (c) => ({
	main: c.main,
	compatibility_date: c.compatibility_date,
	compatibility_flags: [...(c.compatibility_flags ?? [])].sort(),
	crons: [...(c.triggers?.crons ?? [])].sort(),
	assets: c.assets,
	workers_dev: c.workers_dev,
	preview_urls: c.preview_urls,
	d1: (c.d1_databases ?? []).map((d) => d.binding).sort(),
	kv: (c.kv_namespaces ?? []).map((k) => k.binding).sort(),
	queue_producers: (c.queues?.producers ?? []).map((q) => q.binding).sort(),
	queue_consumers: (c.queues?.consumers ?? []).map(({ queue, dead_letter_queue, ...rest }) => rest),
	ratelimits: c.ratelimits,
	analytics_engine: (c.analytics_engine_datasets ?? []).map((a) => a.binding).sort(),
});

const a = bindings(pub);
const b = bindings(prod);
const problems = [];
for (const key of Object.keys(a)) {
	if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
		problems.push(`${key}:\n    wrangler.jsonc: ${JSON.stringify(a[key])}\n    ${prodPath}: ${JSON.stringify(b[key])}`);
	}
}
const extraVars = Object.keys(prod.vars ?? {}).filter((k) => !(k in (pub.vars ?? {})));
if (extraVars.length) problems.push(`vars only in ${prodPath}: ${extraVars.join(", ")}`);

if (problems.length) {
	console.error(`✗ ${prodPath} has drifted from wrangler.jsonc:\n  ${problems.join("\n  ")}`);
	process.exit(1);
}
console.log(`✓ ${prodPath} matches wrangler.jsonc`);
