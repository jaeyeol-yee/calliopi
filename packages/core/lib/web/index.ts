// web_fetch, the primitive: the engine behind the tool (packages/core/extensions/web-fetch.ts).
// No Pi and no dependencies here, so other layers may reuse the same checks.
export { isPublicAddress, isPublicIPv4, isPublicIPv6, parseIPv6 } from '#lib/web/address.ts';
export { WebFetchError, NO_RULES, bareHost, checkUrl, decide, matchHost, parseRules, type Decision, type HostRules } from '#lib/web/policy.ts';
export { decodeEntities, htmlToText } from '#lib/web/html.ts';
export { DEFAULTS, cleanText, decodeBody, fetchPage, parseContentType, type FetchOptions, type FetchedPage } from '#lib/web/fetch.ts';
export { PAGE, PageCache, formatResult, readPage, windowOf, type PageWindow } from '#lib/web/page.ts';
