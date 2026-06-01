// Google Analytics (GA4) — loaded only in production (not on localhost / dev),
// and injected from this same-origin module so the page needs no inline script
// (keeps the Content-Security-Policy free of 'unsafe-inline').

// The G-XXXXXXXXXX placeholder below is replaced at the edge by the Worker with
// the GA_ID var (set in wrangler.prod.jsonc; see src/index.ts). When GA_ID is
// unset, the Worker serves a no-op instead, so forks/clones send no analytics.
const GA_ID = "G-XXXXXXXXXX";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", ""]);

if (!LOCAL_HOSTS.has(location.hostname)) {
	window.dataLayer = window.dataLayer || [];
	function gtag() {
		window.dataLayer.push(arguments);
	}
	window.gtag = gtag;
	gtag("js", new Date());
	gtag("config", GA_ID);

	const s = document.createElement("script");
	s.async = true;
	s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
	document.head.appendChild(s);
}
