/*
 * Tests for the pure logic in steam-market-helper.user.js.
 *
 *   node tests/run.js
 *
 * The userscript is an IIFE with no exports, so the harness fakes just enough
 * of a browser for it to load, sets window.__SMH_TEST__ first, and reads the
 * internals back out of it. Nothing here touches the network or Steam.
 *
 * What is covered: price parsing, the fee round-trip, order-book subtraction,
 * the red/yellow/green rules, duplicate selection, and the hovers regex.
 *
 * What is NOT covered, and has to be checked in a browser: parseMyListingsPage
 * needs a real DOMParser, and everything that talks to Steam needs a login.
 * See tests/browser.html for those.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'steam-market-helper.user.js');

// ------------------------------------------------------------- tiny harness

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        failures.push(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    }
}

function checkTrue(name, value) {
    check(name, Boolean(value), true);
}

// -------------------------------------------------------------- load script

function loadScript(walletInfo) {
    const testBag = {};

    const win = {
        __SMH_TEST__: testBag,
        g_rgWalletInfo: walletInfo,
        GetCurrencyCode: (id) => ({ 1: 'USD', 2: 'GBP', 3: 'EUR', 8: 'JPY' }[id] || 'EUR'),
        location: { origin: 'https://steamcommunity.com', href: 'https://steamcommunity.com/market/', hash: '' },
        addEventListener() {},
        setTimeout,
        Intl,
        Math,
        JSON,
        Map,
        Set
    };
    win.window = win;
    win.unsafeWindow = win;

    const sandbox = {
        window: win,
        unsafeWindow: win,
        document: {
            readyState: 'loading',
            cookie: 'sessionid=deadbeef',
            documentElement: { innerHTML: '' },
            head: { appendChild() {} },
            body: { appendChild() {} },
            createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, addEventListener() {}, appendChild() {}, querySelector: () => null }),
            addEventListener() {}
        },
        localStorage: {
            _d: {},
            getItem(k) { return this._d[k] || null; },
            setItem(k, v) { this._d[k] = v; }
        },
        fetch: () => Promise.reject(new Error('no network in tests')),
        DOMParser: undefined,
        console,
        setTimeout,
        clearTimeout,
        Intl
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'steam-market-helper.user.js' });

    return testBag;
}

// Steam's real EUR wallet shape: 5% Steam fee, 10% publisher fee, 1 cent floor.
const EUR_WALLET = {
    wallet_currency: 3,
    wallet_fee: '1',
    wallet_fee_base: '0',
    wallet_fee_percent: '0.05',
    wallet_fee_minimum: '1',
    wallet_publisher_fee_percent_default: '0.10'
};

const T = loadScript(EUR_WALLET);

// ==================================================================== version

/*
 * The panel shows a version so a stale install is visible at a glance, and that
 * only helps if the number is true. It is stated twice -- once in the
 * @version metadata the userscript manager reads, once as a constant the panel
 * renders -- and a footer confidently displaying the wrong version is worse
 * than no footer, because it is the thing you would check first.
 */
console.log('\n-- version --');

const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const headerVersion = (SOURCE.match(/@version\s+([\d.]+)/) || [])[1];
const constVersion = (SOURCE.match(/const VERSION = '([\d.]+)'/) || [])[1];

checkTrue('@version is present in the metadata block', !!headerVersion);
checkTrue('VERSION constant is present', !!constVersion);
check(`_check_version_matches_header (@version ${headerVersion} vs VERSION ${constVersion})`,
    headerVersion, constVersion);

// =============================================================== price parse

console.log('\n-- parsePriceToCents --');

check('italian format "0,35€"', T.parsePriceToCents('0,35€'), 35);
check('us format "$0.35"', T.parsePriceToCents('$0.35'), 35);
check('uk format "£12.50"', T.parsePriceToCents('£12.50'), 1250);
check('euro thousands "1.234,56€"', T.parsePriceToCents('1.234,56€'), 123456);
check('us thousands "$1,234.56"', T.parsePriceToCents('$1,234.56'), 123456);
check('single decimal "0,5€"', T.parsePriceToCents('0,5€'), 50);
check('whole number "35"', T.parsePriceToCents('35'), 3500);
check('bare thousands "1.234"', T.parsePriceToCents('1.234'), 123400);
check('with spaces " 3,49 € "', T.parsePriceToCents(' 3,49 € '), 349);
check('null in, null out', T.parsePriceToCents(null), null);
check('no digits', T.parsePriceToCents('--'), null);
check('steam "Sold!" text', T.parsePriceToCents('Sold!'), null);

// ================================================================== fee math

console.log('-- fees --');

/*
 * Steam's published example: a seller who receives 0.87 has the buyer pay 1.00.
 * 5% of 87 floors to 4, 10% floors to 8, so 87 + 4 + 8 = 99. The cent that is
 * left over is why priceBeforeFees searches rather than dividing.
 */
check('amountToSend(87) totals correctly', T.amountToSendForDesiredReceived(87, 0.1).amount, 99);
check('minimum fee applies to tiny amounts', T.amountToSendForDesiredReceived(1, 0.1).fees, 2);

/*
 * The property that actually matters, checked over every price a card or skin
 * is likely to have.
 *
 * Because floored percentage fees leave gaps, not every buyer price can be
 * hit exactly -- so "round-trips exactly" is the wrong invariant and asserting
 * it would only force the code to lie. The two real requirements are:
 *
 *   1. NEVER overshoot. If we ask to list at 22 and the listing goes up at 23,
 *      an instruction to undercut has silently become an instruction to match
 *      or beat the price we were trying to get under. This is the one that
 *      costs money.
 *   2. Be the best reachable price. One cent lower would also never overshoot,
 *      so "never overshoot" alone is satisfied by returning 1 every time.
 */
console.log('   fee round-trip over 3..2000 cents...');
let overshoots = 0;
let notMaximal = 0;
const overshootExamples = [];
const notMaximalExamples = [];

for (let buyer = 3; buyer <= 2000; buyer++) {
    const seller = T.priceBeforeFees(buyer, null);
    const back = T.amountToSendForDesiredReceived(seller, 0.1).amount;
    const nextUp = T.amountToSendForDesiredReceived(seller + 1, 0.1).amount;

    if (back > buyer) {
        overshoots++;
        if (overshootExamples.length < 5) {
            overshootExamples.push(`${buyer} -> ${seller} -> ${back}`);
        }
    }
    if (nextUp <= buyer) {
        notMaximal++;
        if (notMaximalExamples.length < 5) {
            notMaximalExamples.push(`${buyer} -> ${seller}, but ${seller + 1} -> ${nextUp} also fits`);
        }
    }
}

check(`never overshoots the target buyer price (${overshootExamples.join('; ')})`, overshoots, 0);
check(`always takes the highest price that fits (${notMaximalExamples.join('; ')})`, notMaximal, 0);

// Spot-check the gap that found the bug in the first place.
check('unreachable buyer price 22 rounds DOWN to seller 19', T.priceBeforeFees(22, null), 19);
check('...and 19 really does bill the buyer 21, not 22', T.amountToSendForDesiredReceived(19, 0.1).amount, 21);
checkTrue('seller price is always below buyer price', T.priceBeforeFees(35, null) < 35);
check('seller price never drops below 1', T.priceBeforeFees(1, null), 1);

// ====================================================== order book parsing

/*
 * These run against payloads captured from the live endpoint (tests/fixtures),
 * not against hand-written objects. That distinction is the whole reason this
 * section exists.
 *
 * Version 1.0.0 shipped with the nesting misread: `success` sits on
 * payload.data, but the code unwrapped twice and tested it on payload.data.data
 * where it is undefined. Every item on every scan was rejected with "order book
 * unavailable" and the feature never worked once.
 *
 * Nothing caught it, because every other test here is written against objects
 * of the shape the code already expects. A fixture invented by whoever wrote
 * the parser agrees with the parser by construction -- the same "two sides
 * built from one source" trap that makes a check spelling rather than truth.
 * Only a real captured response is an independent witness.
 */
console.log('-- buildOrderBook (real captured payloads) --');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

const okBook = T.buildOrderBook(fixture('orderbook-ok.json'));

checkTrue('a real payload parses at all (the 1.0.0 bug)', okBook !== null);
check('reads the lowest sell order', okBook.lowestSell, 12);
checkTrue('reads the highest buy order', okBook.highestBuy > 0);
checkTrue('sell orders come out as price/quantity pairs', okBook.sellOrders.length > 0);
checkTrue('prices are integers, not strings', Number.isInteger(okBook.sellOrders[0].price));
checkTrue('quantities are integers', Number.isInteger(okBook.sellOrders[0].quantity));
checkTrue('sell orders are in ascending price order',
    okBook.sellOrders.every((l, i, a) => i === 0 || a[i - 1].price <= l.price));
check('the lowest sell order matches the first level', okBook.sellOrders[0].price, okBook.lowestSell);

// Steam answers success:false with no inner data at all for an unknown item.
check('an unknown item gives null, not a crash', T.buildOrderBook(fixture('orderbook-missing.json')), null);

/*
 * An item can succeed with buy orders and no sellers -- a real book with one
 * side empty. It must NOT be mistaken for a failure: the right response is to
 * price against the top buy order, not to skip the item.
 */
const noSellers = T.buildOrderBook(fixture('orderbook-no-sellers.json'));
checkTrue('an item with no sellers still parses', noSellers !== null);
check('...with no lowest sell price', noSellers.lowestSell, null);
check('...and an empty sell side', noSellers.sellOrders, []);
checkTrue('...but a populated buy side', noSellers.buyOrders.length > 0);
check('...and it still gets a price, from the buy side',
    T.targetPriceForNewListing(noSellers), noSellers.highestBuy);

check('null payload', T.buildOrderBook(null), null);
check('empty object', T.buildOrderBook({}), null);
check('success true but no inner data', T.buildOrderBook({ data: { success: true } }), null);

// ======================================================== order book maths

console.log('-- lowestCompetingPrice --');

const book = {
    lowestSell: 13,
    highestBuy: 10,
    sellOrders: [
        { price: 13, quantity: 5 },
        { price: 14, quantity: 20 },
        { price: 15, quantity: 30 }
    ],
    buyOrders: [{ price: 10, quantity: 100 }]
};

const none = new Map();
check('no listings of ours -> raw lowest', T.lowestCompetingPrice(book, none), 13);

check(
    'one of the five at 13 is ours -> still 13',
    T.lowestCompetingPrice(book, new Map([[13, 1]])),
    13
);

// This is the case that matters. If we hold every listing at the lowest price,
// the real competition is the next level up -- and a naive read of
// lowestSell would tell us we are perfectly placed while we sit alone in a
// hole of our own digging.
check(
    'all five at 13 are ours -> competition is 14',
    T.lowestCompetingPrice(book, new Map([[13, 5]])),
    14
);

check(
    'we hold the whole book -> no competition',
    T.lowestCompetingPrice(book, new Map([[13, 5], [14, 20], [15, 30]])),
    null
);

check(
    'over-counting our own does not go negative',
    T.lowestCompetingPrice(book, new Map([[13, 99]])),
    14
);

// ============================================================== classifying

console.log('-- classifyListing --');

T.resetSettings();

const listing = (price) => ({ buyerPrice: price, name: 'test', market_hash_name: 'test', appid: 753 });

check(
    'undercut by others -> RED',
    T.classifyListing(listing(15), book, new Map([[15, 1]])).verdict,
    T.VERDICT.HIGH
);

check(
    'cheapest by one cent -> GREEN',
    T.classifyListing(listing(13), book, new Map([[13, 1]])).verdict,
    T.VERDICT.FAIR
);

// We are alone at 13 with the next level at 14, so we could be charging 13.
// Sitting at 11 is two cents and 15% below that -- money left behind.
check(
    'far below what we could charge -> YELLOW',
    T.classifyListing(listing(11), { ...book, sellOrders: [{ price: 11, quantity: 1 }, { price: 14, quantity: 20 }] }, new Map([[11, 1]])).verdict,
    T.VERDICT.LOW
);

// STRICTLY under the best bid is too low. Exactly AT it is not: that listing is
// about to be matched and sold, and cancelling it would throw away the sale.
check(
    'under the top buy order -> YELLOW',
    T.classifyListing(listing(9), { ...book, highestBuy: 10, sellOrders: [{ price: 9, quantity: 1 }, { price: 14, quantity: 5 }] }, new Map([[9, 1]])).verdict,
    T.VERDICT.LOW
);
// Isolated: the competition is one cent above, so the gap rule cannot fire and
// only the buy-order rule is under test.
check(
    'exactly AT the top buy order is not flagged -- it is about to sell',
    T.classifyListing(listing(10), { lowestSell: 10, highestBuy: 10, sellOrders: [{ price: 10, quantity: 1 }, { price: 11, quantity: 5 }], buyOrders: [] }, new Map([[10, 1]])).verdict,
    T.VERDICT.FAIR
);

check(
    'sole seller -> GREEN, nothing to undercut',
    T.classifyListing(listing(500), { lowestSell: 500, highestBuy: null, sellOrders: [{ price: 500, quantity: 1 }], buyOrders: [] }, new Map([[500, 1]])).verdict,
    T.VERDICT.FAIR
);

check(
    'price above the whole visible book -> RED',
    T.classifyListing(listing(9999), book, none).verdict,
    T.VERDICT.HIGH
);

// A price that sits inside the book's range but matches no level means our
// scrape produced a number Steam never rendered. Refuse rather than trade.
check(
    'price inside the book but at no level -> UNKNOWN',
    T.classifyListing(listing(13.5), book, none).verdict,
    T.VERDICT.UNKNOWN
);

check('missing price -> UNKNOWN', T.classifyListing(listing(null), book, none).verdict, T.VERDICT.UNKNOWN);
check('missing book -> UNKNOWN', T.classifyListing(listing(13), null, none).verdict, T.VERDICT.UNKNOWN);

// One cent under the cheapest competitor is the target everywhere.
check('target undercuts competition by a cent', T.classifyListing(listing(15), book, new Map([[15, 1]])).target, 12);

// A cheap card must not go yellow for being a single cent light, or every
// three-cent card in the inventory would be flagged forever.
T.patchSettings({ tooLowAbsCents: 2, tooLowPercent: 5 });
check(
    'one cent light on a cheap card stays GREEN',
    T.classifyListing(listing(12), { lowestSell: 12, highestBuy: 5, sellOrders: [{ price: 12, quantity: 1 }, { price: 14, quantity: 9 }], buyOrders: [] }, new Map([[12, 1]])).verdict,
    T.VERDICT.FAIR
);

// ============================================================ new listings

console.log('-- targetPriceForNewListing --');

check('undercuts the lowest sell', T.targetPriceForNewListing(book), 12);
check(
    'falls back to the top buy order when nothing is listed',
    T.targetPriceForNewListing({ lowestSell: null, highestBuy: 40, sellOrders: [], buyOrders: [] }),
    40
);
check(
    'no market at all -> no price',
    T.targetPriceForNewListing({ lowestSell: null, highestBuy: null, sellOrders: [], buyOrders: [] }),
    null
);

// ================================================= undercut 0, and no churn

/*
 * Two questions that only matter once someone changes the setting.
 *
 * "Undercut lowest by 0" is a legitimate thing to want -- match the cheapest
 * listing rather than beat it, and take your turn in the queue behind whoever
 * got there first. It must price AT the lowest, not below it and not above.
 *
 * The second question is the dangerous one, and it applies at every setting:
 * a listing the tool has just created must come back FAIR when it is next
 * scanned. If it did not, Relist would cancel and recreate the same listing
 * for ever -- every cycle costing a mobile confirmation and a fee -- and
 * nothing in the design would stop it, because Relist deliberately does not
 * ask for confirmation.
 *
 * This is checked against the price actually listed, not the price aimed at.
 * Those differ: floored fees make roughly one buyer price in eight unreachable,
 * so the tool rounds down and lands a cent below its own target. Checking the
 * target against itself would prove nothing.
 */
console.log('-- undercut 0, and the no-churn invariant --');

T.resetSettings();
T.patchSettings({ undercutCents: 0 });

check('undercut 0 prices AT the lowest listing', T.targetPriceForNewListing(book), 13);
check(
    'undercut 0 on a lone listing does not go below one cent',
    T.targetPriceForNewListing({ lowestSell: 1, highestBuy: null, sellOrders: [{ price: 1, quantity: 1 }], buyOrders: [] }),
    1
);

// Matching the lowest is FAIR, not "too low": it is exactly where we asked to be.
check(
    'undercut 0: matching the competition reads FAIR',
    T.classifyListing(listing(13), book, new Map([[13, 1]])).verdict,
    T.VERDICT.FAIR
);

/*
 * The churn sweep. For every competing price and both undercut settings:
 * price a new listing, put it through the real fee round-trip to get the price
 * Steam would actually show, insert it into the book, and classify it.
 */
function listAndReclassify(competingPrice, competingQty, highestBuy) {
    const before = {
        lowestSell: competingPrice,
        highestBuy: highestBuy,
        sellOrders: [{ price: competingPrice, quantity: competingQty }],
        buyOrders: highestBuy ? [{ price: highestBuy, quantity: 5 }] : []
    };

    const aim = T.targetPriceForNewListing(before);
    if (aim == null) {
        return null;
    }

    // Through the same call sellItems() makes, then through Steam's own fee
    // maths, to get the price the buyer would actually see. Going via
    // priceBeforeFees() directly would skip the floor and test a path the tool
    // does not use.
    const listed = T.amountToSendForDesiredReceived(T.sellerPriceForTarget(aim, before, null), 0.1).amount;

    const levels = [{ price: listed, quantity: 1 }];
    if (competingPrice !== listed) {
        levels.push({ price: competingPrice, quantity: competingQty });
    } else {
        levels[0].quantity += competingQty;
    }
    levels.sort((a, b) => a.price - b.price);

    const after = {
        lowestSell: levels[0].price,
        highestBuy: highestBuy,
        sellOrders: levels,
        buyOrders: before.buyOrders
    };

    return {
        aim,
        listed,
        verdict: T.classifyListing({ buyerPrice: listed }, after, new Map([[listed, 1]])).verdict
    };
}

for (const undercut of [0, 1, 2, 5, 25]) {
    T.resetSettings();
    T.patchSettings({ undercutCents: undercut });

    let churn = 0;
    let overshoot = 0;
    const churnExamples = [];

    for (let competing = 5; competing <= 800; competing++) {
        // A buy order well under the ask, so it is not the deciding factor.
        const r = listAndReclassify(competing, 4, Math.max(1, Math.floor(competing * 0.6)));
        if (!r) continue;

        if (r.listed > competing) {
            overshoot++;
        }
        if (r.verdict !== T.VERDICT.FAIR) {
            churn++;
            if (churnExamples.length < 4) {
                churnExamples.push(`competing ${competing} -> aimed ${r.aim}, listed ${r.listed}, then ${r.verdict}`);
            }
        }
    }

    check(
        `undercut ${undercut}: a fresh listing is never above the competition`,
        overshoot,
        0
    );
    check(
        `undercut ${undercut}: a fresh listing re-scans as FAIR, so Relist cannot loop (${churnExamples.join('; ')})`,
        churn,
        0
    );
}

T.resetSettings();
check(
    'never prices below one cent',
    T.targetPriceForNewListing({ lowestSell: 1, highestBuy: null, sellOrders: [{ price: 1, quantity: 1 }], buyOrders: [] }),
    1
);

/*
 * A crossed book: the best bid sits at or above the cheapest ask. It should not
 * persist on a real market, since Steam matches them -- but the two figures
 * come from one snapshot and can disagree for an instant, and the buy-order
 * floor would then push our price ABOVE the competition. Every fresh listing
 * would be born red, and Relist would immediately want to redo it.
 */
const crossed = {
    lowestSell: 20,
    highestBuy: 25,
    sellOrders: [{ price: 20, quantity: 3 }],
    buyOrders: [{ price: 25, quantity: 3 }]
};
check('a crossed book never prices above the competition', T.targetPriceForNewListing(crossed), 20);
checkTrue(
    'and the seller price honours that too',
    T.amountToSendForDesiredReceived(T.sellerPriceForTarget(20, crossed, null), 0.1).amount <= 20
);

// ============================================================== item keys

/*
 * Items are keyed "<appid>::<hash_name>". Steam hash names are close to
 * free-form, and a plain split() with destructuring truncates any name that
 * contains "::" -- which then looks up the wrong order book, or none, showing
 * up as "order book unavailable" for one item in a long list.
 */
console.log('-- splitItemKey --');

check('ordinary key', T.splitItemKey('753::292030-Geralt'),
    { appid: '753', hashName: '292030-Geralt' });
check('a name containing "::" survives intact', T.splitItemKey('730::Weird :: Name'),
    { appid: '730', hashName: 'Weird :: Name' });
check('several separators', T.splitItemKey('730::a::b::c'),
    { appid: '730', hashName: 'a::b::c' });
check('no separator at all', T.splitItemKey('753'), { appid: '753', hashName: '' });

check('context key keeps the name whole', T.splitContextKey('753::6::odd :: card'),
    { appid: '753', contextid: '6', hashName: 'odd :: card' });

// ============================================================== duplicates

console.log('-- filterDuplicates --');

const inv = [
    { market_hash_name: 'Naru', assetid: '1' },
    { market_hash_name: 'Naru', assetid: '2' },
    { market_hash_name: 'Naru', assetid: '3' },
    { market_hash_name: 'Gumo', assetid: '4' },
    { market_hash_name: 'Sein', assetid: '5' },
    { market_hash_name: 'Sein', assetid: '6' }
];

const dups = T.filterDuplicates(inv);
check('keeps one of each, lists the rest', dups.map((i) => i.assetid), ['2', '3', '6']);
check('a singleton is never listed', dups.some((i) => i.market_hash_name === 'Gumo'), false);
check('empty inventory', T.filterDuplicates([]), []);
check('single item is kept', T.filterDuplicates([{ market_hash_name: 'A', assetid: '1' }]), []);

// ================================================================== hovers

console.log('-- parseHovers --');

const hovers = `
    CreateItemHoverFromContainer( g_rgAssets, 'mylisting_4649823145_image', 753, '6', '28932154871', 0 );
    CreateItemHoverFromContainer( g_rgAssets, 'mylisting_4649823146_image', 730, '2', '28932154872', 0 );
`;
const hoverMap = T.parseHovers(hovers);
check('finds both listings', hoverMap.size, 2);
check('maps listing to asset', hoverMap.get('4649823145'), { appid: '753', contextid: '6', assetid: '28932154871' });
check('handles a second appid', hoverMap.get('4649823146').appid, '730');
check('empty input', T.parseHovers('').size, 0);
check('undefined input', T.parseHovers(undefined).size, 0);

// ============================================================ JPY handling

console.log('-- zero-decimal currency --');

const J = loadScript({
    wallet_currency: 8,
    wallet_fee: '1',
    wallet_fee_base: '0',
    wallet_fee_percent: '0.05',
    wallet_fee_minimum: '1',
    wallet_publisher_fee_percent_default: '0.10'
});
check('yen has no decimal part', J.parsePriceToCents('¥1,234'), 1234);
check('yen thousands do not become cents', J.parsePriceToCents('¥100'), 100);

// ===================================================================== done

console.log('');
if (failures.length) {
    console.log(failures.join('\n'));
    console.log('');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
