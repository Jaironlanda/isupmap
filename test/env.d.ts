/// <reference types="@cloudflare/vitest-pool-workers" />

// Make the Worker's generated bindings (DB, etc.) the type of the test `env`.
declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

// Allow `import schema from "../schema.sql?raw"` in tests.
declare module "*.sql?raw" {
	const content: string;
	export default content;
}
