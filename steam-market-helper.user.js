// ==UserScript==
// @name         Steam Market Helper
// @namespace    https://github.com/federicogiorgi/SteamMarketHelper
// @author       Federico Giorgi
// @license      MIT
// @version      1.3.0
// @description  Bulk-sell your Steam inventory and keep your market listings priced sensibly.
// @match        https://steamcommunity.com/id/*/inventory*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @match        https://steamcommunity.com/market*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/federicogiorgi/SteamMarketHelper
// @downloadURL  https://raw.githubusercontent.com/federicogiorgi/SteamMarketHelper/main/steam-market-helper.user.js
// @updateURL    https://raw.githubusercontent.com/federicogiorgi/SteamMarketHelper/main/steam-market-helper.user.js
// ==/UserScript==

/*
 * Design notes -- read these before changing anything.
 *
 * Steam Economy Enhancer broke because it read its data out of Steam's own
 * markup and injected its controls into Steam's own tables. When Valve shipped
 * the Market Beta UI in mid-2026, the selectors stopped matching and the
 * features went with them.
 *
 * So this script does two things differently, and they are the whole point:
 *
 *   1. Data comes from JSON endpoints, never from the rendered page.
 *   2. The UI is our own floating panel. We never inject into Steam's layout.
 *
 * A Steam redesign can therefore change how the page looks without taking this
 * script with it. There are two deliberate exceptions:
 *
 *   - parseMyListingsPage(): /market/mylistings returns the listing rows as an
 *     HTML blob and there is no JSON alternative for your own listings. Item
 *     identity still comes from the JSON `assets` and `hovers` fields; only the
 *     price is scraped, and it is sanity-checked against the order book before
 *     anything acts on it.
 *   - expandListingsOnPage(): showing every listing instead of ten at a time is
 *     inherently a change to Steam's page, so it is the one thing that writes
 *     into Steam's DOM. It fails quietly and changes nothing if the layout moves.
 *
 * On the Market Beta UI, inspected against a live account on 17 August 2026:
 * it is a RESTYLE, NOT A REWRITE. #tabContentsMyActiveMarketListingsRows,
 * .market_listing_row, the mylisting_<id> ids and MergeWithAssetArray are all
 * still there. What did change is the price cell -- see extractBuyerPrice(),
 * which is where that cost real money.
 *
 * Endpoints, verified working on 17 August 2026:
 *
 *   GET  /market/orderbook?q=Load&qp=[appid,"hash_name"]
 *        The good one. Full buy+sell depth, prices as integer cents, no
 *        item_nameid lookup needed. Works logged out.
 *   GET  /inventory/{steamid}/{appid}/{contextid}?l=english&count=2000
 *   GET  /market/mylistings?count=100&start=N
 *   POST /market/sellitem/          (price = what the SELLER receives, in cents)
 *   POST /market/removelisting/{listingid}
 *
 * Note: /market/itemordershistogram now answers {"success":104} and is dead.
 * If you find it referenced anywhere, that reference is stale.
 */

(function () {
    'use strict';

    // Page context. With @grant none `window` is already the page's window;
    // the unsafeWindow branch keeps us working if a grant is ever added.
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    const ORIGIN = window.location.origin;

    /*
     * Shown in the panel footer, and it earns its place.
     *
     * Userscript managers check for updates on their own schedule -- daily by
     * default in Violentmonkey -- so after a fix is published you keep running
     * the old script until it gets round to noticing. That happened here, and
     * from the outside an old script looks exactly like a fix that did not
     * work: the same failure, in the same words, with the bug already fixed
     * upstream. An hour went into diagnosing a stale copy.
     *
     * Keep in step with @version above. `_check_version_matches_header` in
     * tests/run.js fails the suite if the two ever drift.
     */
    const VERSION = '1.3.0';

    // ---------------------------------------------------------------- config

    const SETTINGS_KEY = 'smh_settings_v1';

    const DEFAULTS = {
        // Milliseconds between requests to Steam. Steam has had an IP-based
        // market rate limit since October 2022; going faster than about one
        // request a second earns a 429 that lasts several minutes.
        requestDelayMs: 1200,
        // Random extra delay on top, so the traffic is not metronomic.
        requestJitterMs: 400,
        // How long to wait out a 429 before retrying.
        rateLimitBackoffMs: 30000,
        maxRetries: 4,

        // Undercut the lowest competing listing by this many cents.
        undercutCents: 1,

        // A listing is YELLOW ("too low") when it sits at least this far below
        // the price it could be charging while still being the cheapest.
        // Both thresholds must be met, so cheap cards do not all go yellow.
        tooLowAbsCents: 2,
        tooLowPercent: 5,

        // Sell only items you own more than one of, keeping one of each.
        onlyDuplicates: false,

        // Put every listing on Steam's page rather than ten at a time.
        showAllOnPage: true,

        // Whether "mispriced" includes the too-cheap ones. Red is always in.
        includeLow: true,

        // Order books are cached for the session so a rescan is cheap.
        cacheOrderBooks: true,

        // Safety rail. No single run will touch more than this many items.
        maxItemsPerRun: 500
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
        } catch {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveSettings(s) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch {
            /* private browsing, storage full -- settings just will not persist */
        }
    }

    let settings = loadSettings();

    // ----------------------------------------------------------------- utils

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function readCookie(name) {
        const parts = document.cookie.split(';');
        for (const part of parts) {
            const c = part.trim();
            if (c.startsWith(`${name}=`)) {
                return decodeURIComponent(c.substring(name.length + 1));
            }
        }
        return null;
    }

    function sessionId() {
        return readCookie('sessionid');
    }

    /*
     * Turn a Steam-rendered price into integer cents.
     *
     * Steam formats by locale, so this sees "0,35€", "$0.35", "1.234,56€" and
     * "1,234.56" and has to tell a decimal separator from a thousands one.
     * The rule: the last separator is a decimal separator only if exactly one
     * or two digits follow it. "1.234" is therefore 1234, not 1.23.
     *
     * Zero-decimal currencies (JPY, KRW, ...) would defeat that rule, so they
     * are listed explicitly and skip the inference. Whatever this returns is
     * cross-checked against the order book before we act on it -- see
     * classifyListing() -- so a misparse shows up as "unknown", not as a trade.
     */
    const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'IDR', 'VND', 'CLP', 'COP', 'CRC', 'UYU', 'TWD', 'KZT', 'UAH']);

    function parsePriceToCents(text) {
        if (text == null) {
            return null;
        }

        /*
         * Only the FIRST money-looking token, never the whole string.
         *
         * A beta-UI price cell holds "0,05€ (0,03€)" -- the buyer price and
         * then the seller price. Stripping non-digits from all of it and
         * parsing the result read a five-cent listing as 5003 cents, or
         * fifty euros three. Taking the first token is right for both the
         * one-price and two-price layouts.
         */
        const token = String(text).match(/\d[\d.,]*/);
        if (!token) {
            return null;
        }

        const cleaned = token[0].replace(/[.,]+$/, '');
        if (cleaned === '') {
            return null;
        }

        const digitsOnly = cleaned.replace(/[.,]/g, '');
        if (digitsOnly === '') {
            return null;
        }

        if (ZERO_DECIMAL_CURRENCIES.has(currencyCode())) {
            return parseInt(digitsOnly, 10);
        }

        const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
        if (lastSep === -1) {
            // No separator at all: a bare "35" is 35 whole units, not 35 cents.
            return parseInt(digitsOnly, 10) * 100;
        }

        const fraction = cleaned.substring(lastSep + 1);
        if (fraction.length < 1 || fraction.length > 2) {
            // Thousands separator, no decimal part.
            return parseInt(digitsOnly, 10) * 100;
        }

        const whole = cleaned.substring(0, lastSep).replace(/[.,]/g, '') || '0';
        return parseInt(whole, 10) * 100 + parseInt(fraction.padEnd(2, '0'), 10);
    }

    function currencyCode() {
        try {
            const id = W.g_rgWalletInfo && W.g_rgWalletInfo.wallet_currency;
            if (id && typeof W.GetCurrencyCode === 'function') {
                return W.GetCurrencyCode(id);
            }
        } catch {
            /* fall through */
        }
        return 'EUR';
    }

    function formatCents(cents) {
        if (cents == null || Number.isNaN(cents)) {
            return '--';
        }
        if (ZERO_DECIMAL_CURRENCIES.has(currencyCode())) {
            return `${cents} ${currencyCode()}`;
        }
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: currencyCode()
            }).format(cents / 100);
        } catch {
            return (cents / 100).toFixed(2);
        }
    }

    // ------------------------------------------------------------------- net

    /*
     * One serialized queue for every request this script makes, so the pacing
     * is global. Two features running at once still share one pipe to Steam,
     * which is the only way the rate limit stays respected.
     */
    const Net = {
        chain: Promise.resolve(),
        stopped: false,
        inFlight: 0,

        stop() {
            this.stopped = true;
        },

        reset() {
            this.stopped = false;
        },

        enqueue(fn) {
            const run = this.chain.then(async () => {
                if (this.stopped) {
                    throw new Error('stopped');
                }
                const result = await fn();
                await sleep(settings.requestDelayMs + Math.random() * settings.requestJitterMs);
                return result;
            });
            // Keep the chain alive even when a link rejects.
            this.chain = run.catch(() => {});
            return run;
        }
    };

    async function rawFetch(url, options = {}) {
        const init = {
            method: options.method || 'GET',
            credentials: 'include',
            headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, options.headers || {})
        };

        if (options.body) {
            init.body = options.body;
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }

        const response = await fetch(url, init);
        return response;
    }

    /*
     * A queued request with 429 handling. Returns parsed JSON, or null when
     * `tolerateEmpty` is set and the body is not JSON (some Steam endpoints
     * answer with an empty body on success).
     */
    async function request(url, options = {}) {
        return Net.enqueue(async () => {
            let attempt = 0;

            for (;;) {
                if (Net.stopped) {
                    throw new Error('stopped');
                }

                let response;
                try {
                    response = await rawFetch(url, options);
                } catch (e) {
                    if (attempt++ >= settings.maxRetries) {
                        throw new Error(`network error: ${e.message}`);
                    }
                    await sleep(2000 * attempt);
                    continue;
                }

                if (response.status === 429) {
                    if (attempt++ >= settings.maxRetries) {
                        throw new Error('rate limited by Steam (429), giving up');
                    }
                    UI.log(`Rate limited. Waiting ${Math.round(settings.rateLimitBackoffMs / 1000)}s...`, 'warn');
                    await sleep(settings.rateLimitBackoffMs);
                    continue;
                }

                if (response.status === 401 || response.status === 403) {
                    throw new Error(`not authorised (${response.status}) -- are you still logged in?`);
                }

                const text = await response.text();

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
                }

                if (!text) {
                    return options.tolerateEmpty ? null : {};
                }

                try {
                    return JSON.parse(text);
                } catch {
                    if (options.tolerateEmpty) {
                        return null;
                    }
                    throw new Error('Steam returned a non-JSON response');
                }
            }
        });
    }

    function formEncode(data) {
        return Object.keys(data)
            .filter((k) => data[k] !== undefined && data[k] !== null)
            .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(data[k])}`)
            .join('&');
    }

    // ------------------------------------------------------------------ fees

    /*
     * Steam's own fee maths, which we prefer to use directly when the page has
     * defined it. Our copy is a fallback and follows the December 2025 rule
     * change: twelve currencies round rather than floor, and both the Steam fee
     * and the publisher fee have a minimum.
     */
    const ROUNDING_CURRENCIES = new Set([
        'JPY', 'IDR', 'UAH', 'CLP', 'COP', 'TWD', 'KZT', 'CRC', 'UYU', 'KRW', 'VND'
    ]);

    function walletInfo() {
        return W.g_rgWalletInfo || null;
    }

    function publisherFeeFor(item) {
        const wi = walletInfo();
        if (item && item.market_fee != null) {
            return parseFloat(item.market_fee);
        }
        if (wi && wi.wallet_publisher_fee_percent_default != null) {
            return parseFloat(wi.wallet_publisher_fee_percent_default);
        }
        return 0.10;
    }

    function amountToSendForDesiredReceived(received, publisherFee) {
        if (typeof W.CalculateAmountToSendForDesiredReceivedAmount === 'function') {
            try {
                return W.CalculateAmountToSendForDesiredReceivedAmount(received, publisherFee, walletInfo());
            } catch {
                /* fall through to our own copy */
            }
        }

        const wi = walletInfo();
        if (!wi || !wi.wallet_fee) {
            return { amount: received, fees: 0, steam_fee: 0, publisher_fee: 0 };
        }

        const roundFee = ROUNDING_CURRENCIES.has(currencyCode()) ? Math.round : Math.floor;
        const minFee = parseInt(wi.wallet_fee_minimum, 10) || 1;
        const pf = publisherFee == null ? 0 : publisherFee;

        const steamFee = Math.max(
            roundFee(received * parseFloat(wi.wallet_fee_percent) + parseInt(wi.wallet_fee_base, 10)),
            minFee
        );
        const pubFee = pf > 0 ? Math.max(roundFee(received * pf), minFee) : 0;

        return {
            steam_fee: steamFee,
            publisher_fee: pubFee,
            fees: steamFee + pubFee,
            amount: received + steamFee + pubFee
        };
    }

    /*
     * Given what the buyer pays, what does the seller receive?
     *
     * Steam's fee function only runs the other way, so this searches for the
     * seller price whose buyer total is the one we want.
     *
     * Not every buyer price is reachable. With a 5% Steam fee and a 10%
     * publisher fee, both floored, a seller who receives 19 makes the buyer pay
     * 21 and a seller who receives 20 makes them pay 23 -- so 22 is a price no
     * listing can have. Roughly one buyer price in eight is a gap like that.
     *
     * When we land in a gap we must round DOWN, never up. Rounding up is the
     * dangerous direction: asked to undercut a 23-cent listing by a cent we
     * would list at 23 again and not undercut anything, which is exactly the
     * bug this function exists to avoid.
     */
    function priceBeforeFees(buyerPrice, item) {
        const wi = walletInfo();
        if (!wi || !wi.wallet_fee) {
            return buyerPrice;
        }

        const pf = publisherFeeFor(item);
        const amount = Math.round(buyerPrice);

        let estimate = parseInt(
            (amount - parseInt(wi.wallet_fee_base, 10)) /
                (parseFloat(wi.wallet_fee_percent) + pf + 1),
            10
        );
        if (!Number.isFinite(estimate) || estimate < 1) {
            estimate = 1;
        }

        let fees = amountToSendForDesiredReceived(estimate, pf);
        let undershot = false;

        for (let i = 0; i < 12 && fees.amount !== amount; i++) {
            if (fees.amount > amount) {
                if (undershot) {
                    // We stepped up from a price that was too low and landed
                    // above the target: the target is unreachable. Step back
                    // to the last value that did not overshoot.
                    estimate--;
                    break;
                }
                estimate--;
            } else {
                undershot = true;
                estimate++;
            }
            if (estimate < 1) {
                estimate = 1;
                break;
            }
            fees = amountToSendForDesiredReceived(estimate, pf);
        }

        estimate = Math.max(1, estimate);

        // Belt and braces: whatever the search did, never return a seller price
        // whose buyer total exceeds what we were asked for.
        while (estimate > 1 && amountToSendForDesiredReceived(estimate, pf).amount > amount) {
            estimate--;
        }

        return estimate;
    }

    // ---------------------------------------------------------- steam market

    const orderBookCache = new Map();

    // Comfortably more than any one scan needs -- a 500-listing account has
    // well under this many distinct items -- while still having a ceiling.
    const ORDER_BOOK_CACHE_MAX = 600;

    /*
     * Reshape an /market/orderbook response into the book the rest of the
     * script uses. Returns null when Steam does not know the item.
     *
     * THE NESTING IS THE TRAP, and it fails silently. The payload is
     *
     *     { data: { success: true, data: { amtMinSellOrder, ... } } }
     *
     * so `success` sits one level ABOVE the order figures. Version 1.0.0
     * unwrapped both levels and then tested `success` on the inner object,
     * where it is undefined -- so every item on every scan was rejected with
     * "order book unavailable" and the feature never worked once. Nothing
     * pointed at the nesting; it looked exactly like Steam being down.
     *
     * rgCompactSellOrders is a flat [price, qty, price, qty, ...] list in
     * ascending price order, already in integer cents and inclusive of fees --
     * that is, what a buyer pays.
     *
     * An item can legitimately succeed with no sellers at all: amtMinSellOrder
     * comes back null and rgCompactSellOrders as []. That is a real book with
     * an empty side, not a failure, and callers must not confuse the two.
     */
    function buildOrderBook(payload) {
        const outer = payload && payload.data;
        if (!outer || !outer.success || !outer.data) {
            return null;
        }

        const d = outer.data;

        const pairs = (flat) => {
            const out = [];
            const arr = Array.isArray(flat) ? flat : [];
            for (let i = 0; i + 1 < arr.length; i += 2) {
                out.push({ price: parseInt(arr[i], 10), quantity: parseInt(arr[i + 1], 10) });
            }
            return out;
        };

        return {
            lowestSell: d.amtMinSellOrder != null ? parseInt(d.amtMinSellOrder, 10) : null,
            highestBuy: d.amtMaxBuyOrder != null ? parseInt(d.amtMaxBuyOrder, 10) : null,
            sellOrders: pairs(d.rgCompactSellOrders),
            buyOrders: pairs(d.rgCompactBuyOrders),
            sellCount: d.cSellOrders,
            buyCount: d.cBuyOrders
        };
    }

    async function getOrderBook(appid, hashName, { bypassCache = false } = {}) {
        const key = `${appid}::${hashName}`;

        if (!bypassCache && settings.cacheOrderBooks && orderBookCache.has(key)) {
            return orderBookCache.get(key);
        }

        const qp = encodeURIComponent(JSON.stringify([Number(appid), hashName]));
        const url = `${ORIGIN}/market/orderbook?q=Load&qp=${qp}`;

        const book = buildOrderBook(await request(url));
        if (book == null) {
            throw new Error('order book unavailable');
        }

        if (settings.cacheOrderBooks) {
            /*
             * Bounded, oldest-out. A book is not small -- the cheap trading
             * cards carry a couple of hundred price levels each -- and the
             * cache had nothing to evict it, so a long session over a large
             * inventory grew it for as long as the tab stayed open. A Map keeps
             * insertion order, so the first key is the oldest.
             */
            while (orderBookCache.size >= ORDER_BOOK_CACHE_MAX) {
                orderBookCache.delete(orderBookCache.keys().next().value);
            }
            orderBookCache.set(key, book);
        }
        return book;
    }

    function invalidateOrderBook(appid, hashName) {
        orderBookCache.delete(`${appid}::${hashName}`);
    }

    // Price is what the SELLER receives, in cents.
    async function sellItem(item, sellerPrice) {
        const url = `${ORIGIN}/market/sellitem/`;
        const body = formEncode({
            sessionid: sessionId(),
            appid: item.appid,
            contextid: item.contextid,
            assetid: item.assetid,
            amount: item.amount || 1,
            price: sellerPrice
        });

        const data = await request(url, {
            method: 'POST',
            body,
            headers: { Referer: `${ORIGIN}/id/me/inventory` }
        });

        if (!data || !data.success) {
            throw new Error((data && data.message) || 'Steam refused the listing');
        }
        return data;
    }

    async function removeListing(listingId) {
        const url = `${ORIGIN}/market/removelisting/${listingId}`;
        const body = formEncode({ sessionid: sessionId() });

        // A successful cancel answers with an empty body, not with JSON.
        await request(url, { method: 'POST', body, tolerateEmpty: true });
        return true;
    }

    // ------------------------------------------------------------- inventory

    function currentSteamId() {
        if (W.g_steamID) {
            return String(W.g_steamID);
        }
        if (W.g_rgProfileData && W.g_rgProfileData.steamid) {
            return String(W.g_rgProfileData.steamid);
        }
        const m = document.documentElement.innerHTML.match(/g_steamID\s*=\s*"(\d{17})"/);
        return m ? m[1] : null;
    }

    /*
     * Which inventory is on screen. Steam puts it in the URL fragment as
     * "#753_6"; g_ActiveInventory is the fallback and 753/6 (Steam community
     * items -- cards, backgrounds, emoticons) is the last resort, being far
     * and away the most common thing anyone bulk-sells.
     */
    function currentInventoryTarget() {
        let appid = 753;
        let contextid = '6';

        const hash = window.location.hash.match(/#(\d+)_(\d+)/);
        if (hash) {
            appid = parseInt(hash[1], 10);
            contextid = hash[2];
        } else {
            const inv = W.g_ActiveInventory;
            if (inv && inv.m_appid) {
                appid = parseInt(inv.m_appid, 10);
                contextid = String(inv.m_contextid);
            }
        }

        // Sanitize invalid or zero context IDs
        if (!contextid || contextid === '0' || contextid === 'undefined') {
            contextid = appid === 753 ? '6' : '2';
        }

        return { appid, contextid };
    }

    /*
     * Fetch a whole inventory from the JSON endpoint, following pagination.
     * Returns flat items with the description merged in, which is the shape
     * the rest of the script expects.
     */
    async function fetchInventory(steamId, appid, contextid, onProgress) {
        const items = [];
        let startAssetId = null;
        let page = 0;

        // Fallback guard against 0 context IDs
        const validContextId = (!contextid || contextid === '0' || contextid === 0)
            ? (appid == 753 ? '6' : '2')
            : contextid;

        for (;;) {
            let url = `${ORIGIN}/inventory/${steamId}/${appid}/${validContextId}?l=english&count=2000`;
            if (startAssetId) {
                url += `&start_assetid=${startAssetId}`;
            }

            const data = await request(url);
            if (!data || !data.success) {
                throw new Error('could not read the inventory (is it set to public?)');
            }

            const descriptions = new Map();
            for (const d of data.descriptions || []) {
                descriptions.set(`${d.classid}_${d.instanceid}`, d);
            }

            for (const asset of data.assets || []) {
                const d = descriptions.get(`${asset.classid}_${asset.instanceid}`);
                if (!d) {
                    continue;
                }
                items.push({
                    appid: asset.appid,
                    contextid: asset.contextid,
                    assetid: asset.assetid,
                    amount: parseInt(asset.amount, 10) || 1,
                    classid: asset.classid,
                    instanceid: asset.instanceid,
                    market_hash_name: d.market_hash_name,
                    name: d.name || d.market_hash_name,
                    marketable: d.marketable === 1 || d.marketable === true,
                    market_fee: d.market_fee,
                    icon_url: d.icon_url
                });
            }

            page++;
            if (onProgress) {
                onProgress(items.length, page);
            }

            /*
             * Stop unless the cursor actually moved.
             *
             * Paging is driven by whatever Steam hands back, so a response that
             * says "more items" while repeating last_assetid would have this
             * loop asking for the same page for ever -- hammering Steam from a
             * background tab with no way to stop it and no error to notice.
             * The page cap is the same guard for an ever-advancing cursor.
             */
            if (!data.more_items || !data.last_assetid || data.last_assetid === startAssetId) {
                return items;
            }
            if (page >= 40) {
                UI.log('Stopped paging the inventory after 40 pages.', 'warn');
                return items;
            }

            startAssetId = data.last_assetid;
        }
    }

    /*
     * Keep one of each, list the rest. Grouping is by market_hash_name, since
     * that is what a Steam listing is actually keyed on -- two assets with the
     * same hash name are interchangeable to a buyer.
     */
    function filterDuplicates(items) {
        const seen = new Map();
        const out = [];

        for (const item of items) {
            const n = seen.get(item.market_hash_name) || 0;
            if (n >= 1) {
                out.push(item);
            }
            seen.set(item.market_hash_name, n + 1);
        }
        return out;
    }

    // -------------------------------------------------------------- listings

    /*
     * Read the active sell listings.
     *
     * /market/mylistings answers with JSON that carries the rows as an HTML
     * blob in `results_html`. There is no JSON-only route to your own listings,
     * so this is the single place the script parses markup -- and it takes as
     * little from it as it can:
     *
     *   - item identity (appid, contextid, assetid) comes from the `hovers`
     *     script text, which is generated code rather than layout;
     *   - the item name comes from the `assets` JSON;
     *   - only the price is scraped, and classifyListing() checks it against
     *     the order book before anything acts on it.
     */
    // listingid -> {appid, contextid, assetid}, read out of the `hovers` script
    // text. This is generated code rather than layout, so it survives redesigns
    // that would break a selector.
    function parseHovers(hovers) {
        const map = new Map();
        const re = /CreateItemHoverFromContainer\(\s*g_rgAssets\s*,\s*'mylisting_(\d+)_image'\s*,\s*(\d+)\s*,\s*'(\d+)'\s*,\s*'(\d+)'/g;
        let m;
        while ((m = re.exec(hovers || '')) !== null) {
            map.set(m[1], { appid: m[2], contextid: m[3], assetid: m[4] });
        }
        return map;
    }

    /*
     * The buyer price out of one listing row.
     *
     * The markup changed with the 2026 Market Beta UI and the change is a trap,
     * because the old selector fails to a fallback that returns something
     * plausible-looking and wrong.
     *
     *   Old: two sibling spans, the buyer price carrying its own class.
     *        <span class="market_listing_price market_listing_price_with_fee">0,35€</span>
     *        <span class="market_listing_price market_listing_price_without_fee">0,30€</span>
     *
     *   Beta: ONE cell holding both, the seller price in brackets.
     *        <span class="market_listing_price">
     *          <span title="This is the price the buyer pays.">0,05€</span>
     *          <span title="This is how much you will receive.">(0,03€)</span>
     *        </span>
     *
     * So `market_listing_price_with_fee` no longer exists, and falling back to
     * `market_listing_price` yields the text "0,05€ (0,03€)" -- both numbers at
     * once. Read naively that is 5003 cents.
     *
     * Identifying the buyer price by its `title` would work today and break for
     * anyone whose Steam is not in English, so the rule is structural instead:
     * drop the bracketed part, take the first number that remains.
     *
     * That one rule covers BOTH layouts, which is why there is no special case
     * for the old one. `market_listing_price_with_fee` also carries the plain
     * `market_listing_price` class and comes first, so querySelector finds the
     * buyer price there too. A branch for it was written and then deleted: the
     * sabotage pass showed the tests could not tell whether it was present,
     * which is the definition of code that is not doing anything.
     */
    function extractBuyerPrice(row) {
        const cell = row.querySelector('.market_listing_price');
        if (!cell) {
            return null;
        }

        return parsePriceToCents(cell.textContent.replace(/\([^)]*\)/g, ' '));
    }

    /*
     * Item identity straight from the row's own cancel button, which the beta
     * UI renders as
     *
     *     RemoveMarketListing('mylisting', '<listingid>', <appid>, '<ctx>', '<assetid>')
     *
     * A fallback for when the `hovers` blob does not carry the listing. Being
     * inside the row rather than in a separate script, it is the sturdier of
     * the two -- but hovers stays primary because it is what older layouts have.
     */
    function identityFromRow(row) {
        const href = row.querySelector('.item_market_action_button')?.getAttribute('href') || '';
        const m = href.match(/RemoveMarketListing\(\s*'[^']*'\s*,\s*'(\d+)'\s*,\s*(\d+)\s*,\s*'(\d+)'\s*,\s*'(\d+)'/);
        return m ? { appid: m[2], contextid: m[3], assetid: m[4] } : null;
    }

    // One page of /market/mylistings into listing objects. Split out from the
    // fetch loop so it can be tested against a captured payload.
    function parseMyListingsPage(data, assets) {
        const listings = [];
        const hoverMap = parseHovers(data.hovers);

        const doc = new DOMParser().parseFromString(
            `<table><tbody>${data.results_html || ''}</tbody></table>`,
            'text/html'
        );

        for (const row of doc.querySelectorAll('[id^="mylisting_"]')) {
            const listingId = row.id.replace('mylisting_', '');
            if (!/^\d+$/.test(listingId)) {
                continue;
            }

            // Listings still awaiting a mobile confirmation are not live yet
            // and cannot be cancelled through removelisting.
            const action = row.querySelector('.item_market_action_button');
            const href = (action && action.getAttribute('href')) || '';
            if (/CancelMarketListingConfirmation/i.test(href)) {
                continue;
            }

            const ident = hoverMap.get(listingId) || identityFromRow(row);
            if (!ident) {
                continue;
            }

            const desc =
                assets[ident.appid] &&
                assets[ident.appid][ident.contextid] &&
                assets[ident.appid][ident.contextid][ident.assetid];

            if (!desc || !desc.market_hash_name) {
                continue;
            }

            listings.push({
                listingId,
                appid: parseInt(ident.appid, 10),
                contextid: ident.contextid,
                assetid: ident.assetid,
                market_hash_name: desc.market_hash_name,
                name: desc.name || desc.market_hash_name,
                market_fee: desc.market_fee,
                buyerPrice: extractBuyerPrice(row)
            });
        }

        return listings;
    }

    // Returns { listings, pages, total }. The raw pages are kept so
    // expandListingsOnPage() can put every row on the page without fetching
    // the whole lot a second time.
    async function fetchMyListings(onProgress) {
        const listings = [];
        const pages = [];
        const assets = {};
        let start = 0;
        let total = null;

        for (;;) {
            const url = `${ORIGIN}/market/mylistings?count=100&start=${start}`;
            const data = await request(url);

            if (!data || !data.success) {
                throw new Error('could not read your market listings');
            }

            if (total == null) {
                total = data.total_count || 0;
            }

            // assets[appid][contextid][assetid] -> description
            for (const appid of Object.keys(data.assets || {})) {
                assets[appid] = assets[appid] || {};
                for (const ctx of Object.keys(data.assets[appid])) {
                    assets[appid][ctx] = Object.assign(assets[appid][ctx] || {}, data.assets[appid][ctx]);
                }
            }

            pages.push(data);
            listings.push(...parseMyListingsPage(data, assets));

            start += 100;
            if (onProgress) {
                onProgress(listings.length, total);
            }

            if (start >= total || !data.results_html) {
                return { listings, pages, total: total || listings.length };
            }
        }
    }

    /*
     * Put every listing on Steam's own page, instead of ten at a time.
     *
     * This is the one place the script writes into Steam's DOM, and it only
     * exists because it is what the page is for. Everything else stays in our
     * own panel precisely so that a redesign cannot break it -- so this is
     * written to fail quietly and change nothing if the layout moves.
     *
     * It survived the Market Beta UI because the beta turned out to be a
     * restyle rather than a rewrite: #tabContentsMyActiveMarketListingsRows,
     * .market_listing_row and MergeWithAssetArray are all still there.
     *
     * Steam's pagination is hidden afterwards rather than left lying: it would
     * still say "Showing 1-10 of 55" over a list of 55, and clicking it would
     * quietly put the ten back.
     */
    function expandListingsOnPage(pages) {
        const container = document.getElementById('tabContentsMyActiveMarketListingsRows');
        if (!container) {
            return { ok: false, reason: 'Steam\'s listing container was not found on this page' };
        }

        const rows = [];
        for (const page of pages) {
            // Steam's own helper, so hover panels and images resolve for rows
            // that were never on this page.
            if (typeof W.MergeWithAssetArray === 'function' && page.assets) {
                try {
                    W.MergeWithAssetArray(page.assets);
                } catch {
                    /* cosmetic only -- the rows still render without it */
                }
            }

            const doc = new DOMParser().parseFromString(
                `<table><tbody>${page.results_html || ''}</tbody></table>`,
                'text/html'
            );
            rows.push(...doc.querySelectorAll('.market_listing_row'));
        }

        if (!rows.length) {
            return { ok: false, reason: 'no listing rows came back' };
        }

        // Steam sometimes repeats a listing across pages while one is being
        // created. Keep the first of each.
        const seen = new Set();
        container.innerHTML = '';
        let added = 0;

        for (const row of rows) {
            if (!row.id || seen.has(row.id)) {
                continue;
            }
            seen.add(row.id);
            container.appendChild(document.importNode(row, true));
            added++;
        }

        const paging = document.getElementById('tabContentsMyActiveMarketListings_ctn');
        if (paging) {
            paging.style.display = 'none';
        }

        return { ok: true, added };
    }

    // --------------------------------------------------------------- pricing

    const VERDICT = {
        FAIR: 'fair',
        HIGH: 'high',
        LOW: 'low',
        UNKNOWN: 'unknown'
    };

    /*
     * Items are keyed "<appid>::<market_hash_name>" and "<appid>::<contextid>::
     * <market_hash_name>". Splitting those back apart with a plain split()
     * and destructuring silently truncates any name that itself contains "::",
     * and a truncated name looks up the wrong order book -- or none, which
     * presents as "order book unavailable" for one item in a long list.
     *
     * Steam hash names are close to free-form, so rather than gamble on "::"
     * never appearing, take a fixed number of fields from the left and let the
     * name keep everything else.
     */
    function splitItemKey(key) {
        const parts = String(key).split('::');
        return { appid: parts[0], hashName: parts.slice(1).join('::') };
    }

    function splitContextKey(key) {
        const parts = String(key).split('::');
        return { appid: parts[0], contextid: parts[1], hashName: parts.slice(2).join('::') };
    }

    /*
     * Work out what the lowest competing listing is -- that is, the book with
     * our own listings taken out of it.
     *
     * This subtraction is the part that is easy to get wrong. If you hold the
     * cheapest listing, the raw lowestSell IS your own price, and comparing
     * against it would tell you you are perfectly placed no matter how far you
     * had undercut yourself.
     *
     * `myQuantities` maps price (cents) -> how many listings of ours sit there.
     */
    function lowestCompetingPrice(book, myQuantities) {
        for (const level of book.sellOrders) {
            const mine = myQuantities.get(level.price) || 0;
            if (level.quantity - mine > 0) {
                return level.price;
            }
        }
        return null;
    }

    /*
     * Colour one listing.
     *
     *   red    -- someone is cheaper than you, so you are not selling
     *   yellow -- you are cheapest, but by more than you needed to be
     *   green  -- you are cheapest by a sensible margin
     *
     * "unknown" means the scraped price did not correspond to any level in the
     * order book while sitting inside its range, which points at a parsing
     * problem rather than a pricing one. We refuse to act on those.
     */
    function classifyListing(listing, book, myQuantities) {
        const mine = listing.buyerPrice;

        if (mine == null || !book || !book.sellOrders.length) {
            return { verdict: VERDICT.UNKNOWN, reason: 'no order book' };
        }

        const levels = book.sellOrders.map((l) => l.price);
        const maxLevel = levels[levels.length - 1];
        if (!levels.includes(mine) && mine < maxLevel) {
            return { verdict: VERDICT.UNKNOWN, reason: 'price not found in book' };
        }

        const competing = lowestCompetingPrice(book, myQuantities);

        if (competing == null) {
            // Nobody else is selling this. Nothing to undercut.
            return {
                verdict: VERDICT.FAIR,
                competing: null,
                target: mine,
                reason: 'only listing'
            };
        }

        const target = Math.max(1, competing - settings.undercutCents);

        if (mine > competing) {
            return { verdict: VERDICT.HIGH, competing, target, reason: 'undercut by others' };
        }

        /*
         * STRICTLY below the best standing buy order, not "at or below".
         *
         * A listing priced exactly at the top buy order is about to be matched
         * and sold. That is a good outcome, not a mistake, and cancelling it
         * would be actively destructive -- Relist acts without confirmation, so
         * nothing would catch it.
         *
         * It is also a price this tool produces itself when the spread is
         * tight, which had the two halves contradicting each other: the pricer
         * created a listing the classifier immediately called mispriced, so
         * Relist would cancel and recreate the same listing indefinitely, at
         * the cost of a mobile confirmation every cycle.
         *
         * Strictly below the best bid remains a real signal: somebody is openly
         * offering more than you are asking.
         */
        if (book.highestBuy != null && mine < book.highestBuy) {
            return { verdict: VERDICT.LOW, competing, target, reason: 'under the top buy order' };
        }

        const gap = target - mine;
        const relative = target > 0 ? (gap / target) * 100 : 0;

        if (gap >= settings.tooLowAbsCents && relative >= settings.tooLowPercent) {
            return { verdict: VERDICT.LOW, competing, target, reason: 'cheaper than it needs to be' };
        }

        return { verdict: VERDICT.FAIR, competing, target, reason: 'lowest, sensibly priced' };
    }

    /*
     * The target buyer price for a fresh listing: `undercutCents` under the
     * cheapest thing on the shelf. When nothing is listed we fall back to the
     * top buy order, and when there is neither we cannot price it at all.
     *
     * The floor at the top buy order is the part worth explaining. Never sell
     * for less than somebody is already openly bidding: below that price the
     * listing is matched instantly anyway, so the only thing the extra
     * undercutting buys is a smaller payment. With a large undercut and a tight
     * spread the naive arithmetic went straight through the bid and out the
     * other side.
     *
     * It also keeps the pricer and classifyListing() agreeing with each other.
     * They disagreed once, and the result was Relist cancelling and recreating
     * the same listing for ever.
     */
    function targetPriceForNewListing(book) {
        if (book.lowestSell != null && book.lowestSell > 0) {
            let target = book.lowestSell - settings.undercutCents;

            if (book.highestBuy != null && book.highestBuy > 0) {
                target = Math.max(target, book.highestBuy);
            }

            // Never above the competition, whatever the floor did.
            target = Math.min(target, book.lowestSell);
            return Math.max(1, target);
        }

        if (book.highestBuy != null && book.highestBuy > 0) {
            return book.highestBuy;
        }
        return null;
    }

    /*
     * The seller price to send to Steam for a wanted buyer price.
     *
     * Not simply priceBeforeFees(), because that rounds DOWN through the gaps
     * that floored fees leave -- and rounding down can step straight past the
     * floor targetPriceForNewListing() just applied. Aiming at the top buy
     * order and landing a cent under it means selling instantly for less than
     * somebody was openly offering, and the classifier then correctly calls
     * the result too cheap, which is the churn loop again by a different route.
     *
     * So: convert, then check what Steam would actually bill the buyer, and
     * step up while that is under the bid and still under the competition.
     */
    function sellerPriceForTarget(buyerTarget, book, item) {
        let seller = priceBeforeFees(buyerTarget, item);

        const floor = book && book.highestBuy != null ? book.highestBuy : 0;
        const ceiling = book && book.lowestSell != null ? book.lowestSell : Infinity;
        const pf = publisherFeeFor(item);
        const buyerFor = (s) => amountToSendForDesiredReceived(s, pf).amount;

        // Bounded by the ceiling, so this cannot run away.
        for (let i = 0; i < 8 && buyerFor(seller) < floor && buyerFor(seller + 1) <= ceiling; i++) {
            seller++;
        }

        return seller;
    }

    // -------------------------------------------------------------------- UI

    const CSS = `
.smh-panel{position:fixed;right:16px;bottom:16px;width:420px;max-height:78vh;display:flex;
 flex-direction:column;background:#1b2838;color:#c7d5e0;border:1px solid #2a475e;border-radius:6px;
 box-shadow:0 6px 24px rgba(0,0,0,.5);font:13px/1.45 "Motiva Sans",Arial,sans-serif;z-index:2147483000}
.smh-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#171a21;
 border-bottom:1px solid #2a475e;border-radius:5px 5px 0 0;cursor:move;user-select:none}
.smh-head b{flex:1;font-size:13px;color:#fff;font-weight:600}
.smh-head button{background:none;border:none;color:#8f98a0;cursor:pointer;font-size:15px;padding:0 4px;line-height:1}
.smh-head button:hover{color:#fff}
.smh-body{padding:10px;overflow:auto;flex:1}
.smh-panel.smh-collapsed .smh-body,.smh-panel.smh-collapsed .smh-foot{display:none}
.smh-row{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.smh-btn{flex:1;min-width:110px;padding:7px 10px;border:none;border-radius:3px;cursor:pointer;
 background:#2a475e;color:#c7d5e0;font-size:12px;font-weight:600}
.smh-btn:hover:not(:disabled){background:#39688c;color:#fff}
.smh-btn:disabled{opacity:.45;cursor:not-allowed}
.smh-btn.smh-go{background:#5c7e10;color:#fff}
.smh-btn.smh-go:hover:not(:disabled){background:#6f9612}
.smh-btn.smh-danger{background:#8a3a3a;color:#fff}
.smh-btn.smh-danger:hover:not(:disabled){background:#a44}
.smh-btn.smh-stop{background:#a44;color:#fff}
.smh-opt{display:flex;align-items:center;gap:6px;margin:5px 0;font-size:12px;color:#8f98a0}
.smh-opt input[type=checkbox]{margin:0}
.smh-opt input[type=number]{width:62px;background:#101822;border:1px solid #2a475e;color:#c7d5e0;
 padding:2px 4px;border-radius:3px}
.smh-sum{display:flex;gap:6px;margin:8px 0}
.smh-chip{flex:1;text-align:center;padding:5px 4px;border-radius:3px;font-size:12px;font-weight:700;color:#fff}
.smh-chip small{display:block;font-weight:400;font-size:10px;opacity:.85}
.smh-fair{background:#4c6b22}.smh-high{background:#8a3a3a}.smh-low{background:#8a7a2a}
.smh-unknown{background:#3d4450}
.smh-list{max-height:230px;overflow:auto;border:1px solid #2a475e;border-radius:3px;margin-top:8px}
.smh-item{display:flex;align-items:center;gap:7px;padding:4px 7px;border-bottom:1px solid #223447;font-size:11.5px}
.smh-item:last-child{border-bottom:none}
.smh-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.smh-item span.smh-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smh-item span.smh-pr{font-variant-numeric:tabular-nums;color:#8f98a0}
.smh-log{margin-top:8px;max-height:150px;overflow:auto;background:#101822;border-radius:3px;
 padding:6px 8px;font:11px/1.5 Consolas,monospace;color:#8f98a0}
.smh-log div{white-space:pre-wrap;word-break:break-word}
.smh-log .smh-e{color:#e08a8a}.smh-log .smh-w{color:#e0c98a}.smh-log .smh-s{color:#a5d16a}
.smh-foot{padding:6px 10px;border-top:1px solid #2a475e;font-size:11px;color:#66707a;
 display:flex;justify-content:space-between;align-items:center}
.smh-ver{color:#4d555e;font-variant-numeric:tabular-nums}
.smh-bar{height:3px;background:#2a475e;border-radius:2px;overflow:hidden;margin-top:6px}
.smh-bar i{display:block;height:100%;background:#5c7e10;width:0;transition:width .2s}
`;

    const UI = {
        panel: null,
        logEl: null,
        barEl: null,
        statusEl: null,
        busy: false,

        init(title, bodyBuilder) {
            const style = document.createElement('style');
            style.textContent = CSS;
            document.head.appendChild(style);

            const panel = document.createElement('div');
            panel.className = 'smh-panel';
            panel.innerHTML = `
                <div class="smh-head">
                    <b>${title}</b>
                    <button class="smh-min" title="Collapse">&#8211;</button>
                </div>
                <div class="smh-body"></div>
                <div class="smh-foot">
                    <span class="smh-status">Ready</span>
                    <span class="smh-ver" title="Installed version. Compare with the latest on GitHub if something looks unfixed.">v${VERSION}</span>
                </div>
            `;
            document.body.appendChild(panel);

            this.panel = panel;
            this.statusEl = panel.querySelector('.smh-status');

            panel.querySelector('.smh-min').addEventListener('click', () => {
                panel.classList.toggle('smh-collapsed');
            });
            this.makeDraggable(panel, panel.querySelector('.smh-head'));

            const body = panel.querySelector('.smh-body');
            bodyBuilder(body);

            const bar = document.createElement('div');
            bar.className = 'smh-bar';
            bar.innerHTML = '<i></i>';
            body.appendChild(bar);
            this.barEl = bar.querySelector('i');

            const log = document.createElement('div');
            log.className = 'smh-log';
            body.appendChild(log);
            this.logEl = log;
        },

        makeDraggable(panel, handle) {
            let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

            handle.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON') {
                    return;
                }
                dragging = true;
                const r = panel.getBoundingClientRect();
                sx = e.clientX;
                sy = e.clientY;
                ox = r.left;
                oy = r.top;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.left = `${ox}px`;
                panel.style.top = `${oy}px`;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) {
                    return;
                }
                panel.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
                panel.style.top = `${Math.max(0, oy + e.clientY - sy)}px`;
            });

            document.addEventListener('mouseup', () => {
                dragging = false;
            });
        },

        log(message, kind) {
            if (!this.logEl) {
                return;
            }
            const line = document.createElement('div');
            line.className = kind === 'error' ? 'smh-e' : kind === 'warn' ? 'smh-w' : kind === 'ok' ? 'smh-s' : '';
            const t = new Date().toLocaleTimeString();
            line.textContent = `[${t}] ${message}`;
            this.logEl.appendChild(line);

            /*
             * Keep the log bounded. Selling a large inventory writes a line per
             * item, and a market page that is left open all evening accumulates
             * them with nothing to trim it -- thousands of nodes for scrollback
             * nobody reads. The last few hundred lines are all anyone wants.
             */
            while (this.logEl.childElementCount > 400) {
                this.logEl.removeChild(this.logEl.firstChild);
            }

            this.logEl.scrollTop = this.logEl.scrollHeight;
        },

        status(text) {
            if (this.statusEl) {
                this.statusEl.textContent = text;
            }
        },

        progress(done, total) {
            if (this.barEl) {
                this.barEl.style.width = total > 0 ? `${Math.min(100, (done / total) * 100)}%` : '0';
            }
        }
    };

    function button(label, className) {
        const b = document.createElement('button');
        b.className = `smh-btn ${className || ''}`;
        b.textContent = label;
        return b;
    }

    function checkboxOption(label, key) {
        const wrap = document.createElement('label');
        wrap.className = 'smh-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(settings[key]);
        cb.addEventListener('change', () => {
            settings[key] = cb.checked;
            saveSettings(settings);
        });
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(label));
        return wrap;
    }

    function numberOption(label, key, suffix) {
        const wrap = document.createElement('label');
        wrap.className = 'smh-opt';
        const input = document.createElement('input');
        input.type = 'number';
        input.value = settings[key];
        input.min = '0';
        input.addEventListener('change', () => {
            const v = parseInt(input.value, 10);
            if (!Number.isNaN(v) && v >= 0) {
                settings[key] = v;
                saveSettings(settings);
            }
        });
        wrap.appendChild(document.createTextNode(label));
        wrap.appendChild(input);
        if (suffix) {
            wrap.appendChild(document.createTextNode(suffix));
        }
        return wrap;
    }

    // ------------------------------------------------------- inventory page

    function initInventoryPage() {
        let running = false;
        let sellBtn, dupBtn, stopBtn;

        UI.init('Steam Market Helper &mdash; Inventory', (body) => {
            const row = document.createElement('div');
            row.className = 'smh-row';

            sellBtn = button('Sell everything', 'smh-go');
            dupBtn = button('Sell duplicates only');
            stopBtn = button('Stop', 'smh-stop');
            stopBtn.disabled = true;

            row.appendChild(sellBtn);
            row.appendChild(dupBtn);
            body.appendChild(row);

            const row2 = document.createElement('div');
            row2.className = 'smh-row';
            row2.appendChild(stopBtn);
            body.appendChild(row2);

            body.appendChild(numberOption('Undercut lowest by', 'undercutCents', 'cents'));
            body.appendChild(numberOption('Delay between requests', 'requestDelayMs', 'ms'));

            const note = document.createElement('div');
            note.className = 'smh-opt';
            note.style.color = '#66707a';
            note.textContent = 'Every listing needs a confirmation in the Steam mobile app.';
            body.appendChild(note);

            sellBtn.addEventListener('click', () => run(false));
            dupBtn.addEventListener('click', () => run(true));
            stopBtn.addEventListener('click', () => {
                Net.stop();
                UI.log('Stopping after the current request...', 'warn');
            });
        });

        function setRunning(on) {
            running = on;
            sellBtn.disabled = on;
            dupBtn.disabled = on;
            stopBtn.disabled = !on;
        }

        async function run(onlyDuplicates) {
            if (running) {
                return;
            }

            Net.reset();
            setRunning(true);
            UI.progress(0, 1);

            try {
                const steamId = currentSteamId();
                if (!steamId) {
                    throw new Error('could not work out whose inventory this is -- are you logged in?');
                }

                const target = currentInventoryTarget();
                UI.status('Reading inventory...');
                UI.log(`Reading inventory ${target.appid}/${target.contextid}...`);

                const all = await fetchInventory(steamId, target.appid, target.contextid, (n) => {
                    UI.status(`Reading inventory... ${n} items`);
                });

                let items = all.filter((i) => i.marketable);
                UI.log(`${all.length} items, ${items.length} marketable.`);

                if (onlyDuplicates) {
                    items = filterDuplicates(items);
                    UI.log(`${items.length} duplicates (one of each kept).`);
                }

                if (items.length > settings.maxItemsPerRun) {
                    UI.log(`Limiting this run to ${settings.maxItemsPerRun} items.`, 'warn');
                    items = items.slice(0, settings.maxItemsPerRun);
                }

                if (!items.length) {
                    UI.log('Nothing to sell.', 'warn');
                    UI.status('Nothing to sell');
                    return;
                }

                await sellItems(items);
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(e.message, 'error');
                    UI.status('Failed');
                }
            } finally {
                setRunning(false);
                Net.reset();
            }
        }
    }

    /*
     * Price and list a batch of items.
     *
     * Items are grouped by hash name so that twelve copies of one card cost one
     * order book lookup rather than twelve -- which matters a great deal when
     * the rate limit is the binding constraint.
     */
    async function sellItems(items) {
        const groups = new Map();
        for (const item of items) {
            if (!groups.has(item.market_hash_name)) {
                groups.set(item.market_hash_name, []);
            }
            groups.get(item.market_hash_name).push(item);
        }

        let done = 0;
        let listed = 0;
        let failed = 0;
        let skipped = 0;
        let expected = 0;

        UI.log(`Pricing ${groups.size} distinct items (${items.length} to list)...`);

        for (const [hashName, group] of groups) {
            if (Net.stopped) {
                break;
            }

            let book;
            try {
                book = await getOrderBook(group[0].appid, hashName);
            } catch (e) {
                UI.log(`${hashName}: no price (${e.message})`, 'warn');
                skipped += group.length;
                done += group.length;
                UI.progress(done, items.length);
                continue;
            }

            const buyerPrice = targetPriceForNewListing(book);
            if (buyerPrice == null) {
                UI.log(`${hashName}: nobody is buying or selling, skipped`, 'warn');
                skipped += group.length;
                done += group.length;
                UI.progress(done, items.length);
                continue;
            }

            const sellerPrice = sellerPriceForTarget(buyerPrice, book, group[0]);

            for (const item of group) {
                if (Net.stopped) {
                    break;
                }

                UI.status(`Listing ${done + 1} of ${items.length}...`);

                try {
                    await sellItem(item, sellerPrice);
                    listed++;
                    expected += sellerPrice;
                    UI.log(
                        `Listed ${item.name} at ${formatCents(buyerPrice)} (you get ${formatCents(sellerPrice)})`,
                        'ok'
                    );
                } catch (e) {
                    failed++;
                    UI.log(`${item.name}: ${e.message}`, 'error');
                }

                done++;
                UI.progress(done, items.length);
            }
        }

        UI.log(
            `Done. Listed ${listed}, failed ${failed}, skipped ${skipped}. ` +
                `If they all sell you receive ${formatCents(expected)}.`,
            'ok'
        );
        UI.log('Now open the Steam mobile app and confirm the listings.', 'warn');
        UI.status(`Listed ${listed}`);

        return { listed, failed, skipped, expected };
    }

    // ---------------------------------------------------------- market page

    function initMarketPage() {
        let running = false;
        let expanding = false;
        let scanned = [];
        let scanBtn, removeBtn, relistBtn, stopBtn, listEl, summaryEl;

        /*
         * Listings fetched a moment ago, so pressing Scan straight after the
         * page has expanded itself does not ask Steam for the same thing twice.
         * Two minutes is long enough to cover "the page loaded and I clicked",
         * and short enough that a listing sold in the meantime is not acted on.
         * Cleared outright whenever we remove or relist anything.
         */
        let recent = null;
        const RECENT_MS = 120000;

        function cacheListings(data) {
            recent = { data, at: Date.now() };
        }

        function takeRecentListings() {
            if (recent && Date.now() - recent.at < RECENT_MS) {
                return recent.data;
            }
            return null;
        }

        UI.init('Steam Market Helper &mdash; Listings', (body) => {
            const row = document.createElement('div');
            row.className = 'smh-row';
            scanBtn = button('Scan my listings', 'smh-go');
            stopBtn = button('Stop', 'smh-stop');
            stopBtn.disabled = true;
            row.appendChild(scanBtn);
            row.appendChild(stopBtn);
            body.appendChild(row);

            summaryEl = document.createElement('div');
            summaryEl.className = 'smh-sum';
            summaryEl.style.display = 'none';
            body.appendChild(summaryEl);

            const row2 = document.createElement('div');
            row2.className = 'smh-row';
            relistBtn = button('Relist mispriced', 'smh-go');
            removeBtn = button('Remove mispriced', 'smh-danger');
            relistBtn.disabled = true;
            removeBtn.disabled = true;
            row2.appendChild(relistBtn);
            row2.appendChild(removeBtn);
            body.appendChild(row2);

            body.appendChild(checkboxOption('Show all listings on the page, not 10', 'showAllOnPage'));
            body.appendChild(checkboxOption('Include listings that are too low (yellow)', 'includeLow'));
            body.appendChild(numberOption('Undercut lowest by', 'undercutCents', 'cents'));
            body.appendChild(numberOption('Too low if under by', 'tooLowPercent', '%'));

            listEl = document.createElement('div');
            listEl.className = 'smh-list';
            listEl.style.display = 'none';
            body.appendChild(listEl);

            scanBtn.addEventListener('click', () => scan());
            removeBtn.addEventListener('click', () => act(false));
            relistBtn.addEventListener('click', () => act(true));
            stopBtn.addEventListener('click', () => {
                Net.stop();
                UI.log('Stopping after the current request...', 'warn');
            });
        });

        /*
         * Show every listing as soon as the page opens, rather than making the
         * whole table wait on a scan it has nothing to do with. Expanding the
         * page and judging prices are separate jobs: the first is one request
         * and instant, the second is one request per distinct item and takes
         * minutes under the rate limit.
         */
        async function autoExpand() {
            if (!settings.showAllOnPage || running || expanding) {
                return;
            }

            /*
             * Tracked separately from `running`, which belongs to the buttons.
             * Pressing Scan the instant the page loads used to start a second
             * fetch of the same listings while this one was still in the air:
             * the cache had nothing in it yet, so neither run could reuse the
             * other's work, and the page got expanded twice.
             */
            expanding = true;

            try {
                UI.status('Loading all listings...');
                const data = await fetchMyListings();
                cacheListings(data);

                if (!data.listings.length) {
                    UI.status('No listings');
                    return;
                }

                const expanded = expandListingsOnPage(data.pages);
                if (expanded.ok) {
                    UI.log(`Showing all ${expanded.added} listings on the page.`, 'ok');
                    UI.status(`${expanded.added} listings`);
                } else {
                    UI.log(`Could not expand the page: ${expanded.reason}`, 'warn');
                    UI.status('Ready');
                }
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(`Could not load all listings: ${e.message}`, 'warn');
                    UI.status('Ready');
                }
            } finally {
                expanding = false;
            }
        }

        function setRunning(on) {
            running = on;
            scanBtn.disabled = on;
            stopBtn.disabled = !on;
            const haveTargets = !on && scanned.some((s) => actionable(s));
            removeBtn.disabled = !haveTargets;
            relistBtn.disabled = !haveTargets;
        }

        function actionable(entry) {
            if (entry.verdict === VERDICT.HIGH) {
                return true;
            }
            return entry.verdict === VERDICT.LOW && settings.includeLow;
        }

        function render() {
            const counts = { fair: 0, high: 0, low: 0, unknown: 0 };
            for (const e of scanned) {
                counts[e.verdict]++;
            }

            summaryEl.style.display = 'flex';
            summaryEl.innerHTML = `
                <div class="smh-chip smh-fair">${counts.fair}<small>fair</small></div>
                <div class="smh-chip smh-high">${counts.high}<small>too high</small></div>
                <div class="smh-chip smh-low">${counts.low}<small>too low</small></div>
                <div class="smh-chip smh-unknown">${counts.unknown}<small>unknown</small></div>
            `;

            const colors = { fair: '#5c7e10', high: '#a44', low: '#c9a227', unknown: '#4a5261' };
            const order = { high: 0, low: 1, unknown: 2, fair: 3 };

            listEl.style.display = 'block';
            listEl.innerHTML = '';

            for (const e of [...scanned].sort((a, b) => order[a.verdict] - order[b.verdict])) {
                const el = document.createElement('div');
                el.className = 'smh-item';
                el.title = `${e.reason}${e.target != null ? ` -- suggested ${formatCents(e.target)}` : ''}`;
                el.innerHTML = `
                    <i class="smh-dot" style="background:${colors[e.verdict]}"></i>
                    <span class="smh-nm"></span>
                    <span class="smh-pr">${formatCents(e.listing.buyerPrice)}${
                        e.target != null && e.target !== e.listing.buyerPrice
                            ? ` &rarr; ${formatCents(e.target)}`
                            : ''
                    }</span>
                `;
                el.querySelector('.smh-nm').textContent = e.listing.name;
                listEl.appendChild(el);
            }
        }

        async function scan() {
            if (running) {
                return;
            }

            Net.reset();
            setRunning(true);
            scanned = [];
            UI.progress(0, 1);

            try {
                // The page expansion on load has almost certainly just fetched
                // these; no reason to make Steam send them again.
                let data = takeRecentListings();

                if (data) {
                    UI.log(`${data.listings.length} active sell listings (just loaded).`);
                } else {
                    UI.status('Reading listings...');
                    data = await fetchMyListings((n, total) => {
                        UI.status(`Reading listings... ${n}/${total}`);
                    });
                    cacheListings(data);
                    UI.log(`${data.listings.length} active sell listings.`);
                }

                const { listings, pages } = data;
                if (!listings.length) {
                    UI.status('No listings');
                    return;
                }

                // Only if the page has not already been expanded for us.
                if (settings.showAllOnPage) {
                    const expanded = expandListingsOnPage(pages);
                    if (expanded.ok) {
                        UI.log(`Showing all ${expanded.added} listings on the page.`, 'ok');
                    } else {
                        UI.log(`Could not expand the page: ${expanded.reason}`, 'warn');
                    }
                }

                // How many listings we hold at each price, per item. This is
                // what lets lowestCompetingPrice() take us out of our own book.
                const mineByItem = new Map();
                for (const l of listings) {
                    const key = `${l.appid}::${l.market_hash_name}`;
                    if (!mineByItem.has(key)) {
                        mineByItem.set(key, new Map());
                    }
                    const m = mineByItem.get(key);
                    m.set(l.buyerPrice, (m.get(l.buyerPrice) || 0) + 1);
                }

                const uniqueItems = [...new Set(listings.map((l) => `${l.appid}::${l.market_hash_name}`))];
                UI.log(`Checking ${uniqueItems.length} distinct items...`);

                const books = new Map();
                let i = 0;
                for (const key of uniqueItems) {
                    if (Net.stopped) {
                        break;
                    }
                    const { appid, hashName } = splitItemKey(key);
                    try {
                        books.set(key, await getOrderBook(appid, hashName));
                    } catch (e) {
                        UI.log(`${hashName}: ${e.message}`, 'warn');
                    }
                    i++;
                    UI.progress(i, uniqueItems.length);
                    UI.status(`Checking prices... ${i}/${uniqueItems.length}`);
                }

                for (const listing of listings) {
                    const key = `${listing.appid}::${listing.market_hash_name}`;
                    const book = books.get(key);
                    const verdict = classifyListing(listing, book, mineByItem.get(key) || new Map());
                    scanned.push(Object.assign({ listing }, verdict));
                }

                render();

                const counts = scanned.reduce((a, e) => {
                    a[e.verdict] = (a[e.verdict] || 0) + 1;
                    return a;
                }, {});
                UI.log(
                    `Fair ${counts.fair || 0}, too high ${counts.high || 0}, ` +
                        `too low ${counts.low || 0}, unknown ${counts.unknown || 0}.`,
                    'ok'
                );
                UI.status('Scan complete');
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(e.message, 'error');
                    UI.status('Failed');
                }
            } finally {
                setRunning(false);
                Net.reset();
            }
        }

        /*
         * Remove the mispriced listings, and optionally list them again.
         *
         * Relisting has to be done in that order and with a pause in between,
         * because cancelling a listing returns the item to your inventory with
         * a NEW asset id. The old id is gone, so the only way to find the item
         * again is to re-read the inventory and match on market_hash_name.
         */
        async function act(relist) {
            if (running) {
                return;
            }

            const targets = scanned.filter(actionable);
            if (!targets.length) {
                UI.log('Nothing is mispriced.', 'warn');
                return;
            }

            Net.reset();
            setRunning(true);
            UI.progress(0, 1);

            // Whatever we cached is about to stop being true.
            recent = null;

            try {
                UI.log(`${relist ? 'Relisting' : 'Removing'} ${targets.length} listings...`);

                let removed = 0;
                const wanted = new Map();

                for (const entry of targets) {
                    if (Net.stopped) {
                        break;
                    }

                    try {
                        await removeListing(entry.listing.listingId);
                        removed++;

                        const key = `${entry.listing.appid}::${entry.listing.contextid}::${entry.listing.market_hash_name}`;
                        wanted.set(key, (wanted.get(key) || 0) + 1);

                        // Our own listing has just left the book, so anything
                        // cached for it is now wrong.
                        invalidateOrderBook(entry.listing.appid, entry.listing.market_hash_name);

                        UI.log(`Removed ${entry.listing.name} at ${formatCents(entry.listing.buyerPrice)}`, 'ok');
                    } catch (e) {
                        UI.log(`${entry.listing.name}: ${e.message}`, 'error');
                    }

                    UI.progress(removed, targets.length);
                    UI.status(`Removing ${removed}/${targets.length}...`);
                }

                UI.log(`Removed ${removed} listings.`, 'ok');

                if (!relist || Net.stopped) {
                    UI.status(`Removed ${removed}`);
                    scanned = [];
                    return;
                }

                // Steam needs a moment to put the items back.
                UI.status('Waiting for items to return to inventory...');
                UI.log('Waiting for the items to come back to the inventory...');
                await sleep(5000);

                const steamId = currentSteamId();
                if (!steamId) {
                    throw new Error('cannot relist: could not determine your Steam ID on this page');
                }

                const contexts = new Set([...wanted.keys()].map((k) => k.split('::').slice(0, 2).join('::')));
                const returned = [];

                for (const ctx of contexts) {
                    const [appid, contextid] = ctx.split('::', 2);
                    UI.log(`Re-reading inventory ${appid}/${contextid}...`);
                    const inv = await fetchInventory(steamId, appid, contextid);
                    returned.push(...inv.filter((i) => i.marketable));
                }

                // Match by name and take as many as we removed. Assets with the
                // same hash name are interchangeable, so which copy we pick up
                // does not matter -- only that we relist the right number.
                const toList = [];
                const byName = new Map();
                for (const item of returned) {
                    const key = `${item.appid}::${item.contextid}::${item.market_hash_name}`;
                    if (!byName.has(key)) {
                        byName.set(key, []);
                    }
                    byName.get(key).push(item);
                }

                for (const [key, count] of wanted) {
                    const pool = byName.get(key) || [];
                    if (pool.length < count) {
                        UI.log(
                            `${key.split('::')[2]}: expected ${count} back, found ${pool.length}`,
                            'warn'
                        );
                    }
                    toList.push(...pool.slice(0, count));
                }

                if (!toList.length) {
                    UI.log('Nothing came back to relist. Try scanning again in a minute.', 'warn');
                    UI.status('Nothing to relist');
                    return;
                }

                await sellItems(toList);
                scanned = [];
            } catch (e) {
                if (e.message !== 'stopped') {
                    UI.log(e.message, 'error');
                    UI.status('Failed');
                }
            } finally {
                setRunning(false);
                Net.reset();
            }
        }

        autoExpand();
    }

    // ------------------------------------------------------------ test hook

    /*
     * The test harness sets window.__SMH_TEST__ before loading this file and
     * reads the internals back out of it. In a browser the global is undefined
     * and this block does nothing at all.
     */
    if (W.__SMH_TEST__) {
        Object.assign(W.__SMH_TEST__, {
            VERDICT,
            parsePriceToCents,
            formatCents,
            amountToSendForDesiredReceived,
            priceBeforeFees,
            buildOrderBook,
            lowestCompetingPrice,
            classifyListing,
            targetPriceForNewListing,
            sellerPriceForTarget,
            splitItemKey,
            splitContextKey,
            filterDuplicates,
            parseHovers,
            parseMyListingsPage,
            extractBuyerPrice,
            identityFromRow,
            expandListingsOnPage,
            VERSION,
            // For the visual harness in tests/panel.html only.
            renderMarketPanel: () => initMarketPage(),
            renderInventoryPanel: () => initInventoryPage(),
            getSettings: () => settings,
            patchSettings: (patch) => Object.assign(settings, patch),
            resetSettings: () => {
                settings = Object.assign({}, DEFAULTS);
            }
        });
        return;
    }

    // ----------------------------------------------------------------- boot

    function isLoggedIn() {
        return Boolean(W.g_steamID || W.g_bLoggedIn || W.g_rgWalletInfo);
    }

    function boot() {
        const href = window.location.href;
        const onInventory = /steamcommunity\.com\/(id|profiles)\/[^/]+\/inventory/.test(href);
        const onMarketHome = /steamcommunity\.com\/market\/?($|\?|#)/.test(href);

        if (!onInventory && !onMarketHome) {
            return;
        }

        if (!isLoggedIn()) {
            return;
        }

        if (onInventory) {
            initInventoryPage();
        } else {
            initMarketPage();
        }

        UI.log('Ready.', 'ok');
    }

    // Steam sets up its globals after DOM ready, so give it a beat.
    if (document.readyState === 'complete') {
        setTimeout(boot, 800);
    } else {
        window.addEventListener('load', () => setTimeout(boot, 800));
    }
})();
