// Google Analytics (GA4) — loaded only in production (not on localhost / dev),
// and injected from this same-origin module so the page needs no inline script
// (keeps the Content-Security-Policy free of 'unsafe-inline').

// Replace with your own GA4 measurement ID, or remove this file to disable analytics.
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
