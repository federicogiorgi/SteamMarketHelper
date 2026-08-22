# Reference

`SteamEconomyEnhancer_7.3.2.js` is Nuklon's
[Steam Economy Enhancer](https://github.com/Nuklon/Steam-Economy-Enhancer),
kept here to read — not to run and not to import from.

It is Copyright (c) Nuklon, released under the MIT licence, and is redistributed
here unmodified under those terms. It is not covered by this project's own
[LICENSE](../LICENSE), and neither this project nor its author is endorsed by or
affiliated with Nuklon.

It is worth keeping for three things it already got right, all of which this
project reuses:

- **The fee maths.** `CalculateAmountToSendForDesiredReceivedAmount` and its
  inverse, including the December 2025 rule change where twelve currencies
  round rather than floor.
- **The `hovers` regex** that maps a listing id to `{appid, contextid, assetid}`.
  There is no JSON route to that mapping and it is not obvious.
- **Which endpoints exist at all**, which is otherwise undocumented.

## Why the rewrite

7.3.2 is recent — it already handles the December 2025 fee change and had
already migrated off `/market/itemordershistogram`, which now answers
`{"success":104}`. It did not break through neglect.

It broke because of what it is: roughly 4,200 lines that read their data out of
Steam's rendered markup and inject controls into Steam's own tables, on top of
seven CDN dependencies including two `raw.githubusercontent.com` URLs. When
Valve shipped the Market Beta UI in mid-2026 the selectors stopped matching, and
the features went with them — see upstream issues
[#330](https://github.com/Nuklon/Steam-Economy-Enhancer/issues/330) and
[#332](https://github.com/Nuklon/Steam-Economy-Enhancer/issues/332).

So the rewrite is not "the same thing but tidier". It inverts the two decisions
that caused the breakage: data comes from JSON endpoints rather than the page,
and the UI is a panel of our own rather than an injection into Steam's. It also
does far less — no buy orders, no gems, no boosters, no trade offers.
