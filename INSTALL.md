# Installing Steam Market Helper

Two steps, plus one setting that catches almost everybody on Chrome and Edge.

---

## 1. Install a userscript manager

Either of these works. **Violentmonkey** is the recommendation — it is open
source (MIT) and actively maintained.

| | Chrome | Edge | Firefox |
|---|---|---|---|
| **Violentmonkey** *(recommended)* | [Install](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag) | [Install](https://microsoftedge.microsoft.com/addons/detail/violentmonkey/eeagobfjdenkkddmbclomhiblgggliao) | [Install](https://addons.mozilla.org/firefox/addon/violentmonkey/) |
| **Tampermonkey** | [Install](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) | [Install](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) | [Install](https://addons.mozilla.org/firefox/addon/tampermonkey/) |

This script uses no manager-specific APIs, so it behaves identically in both.

---

## 2. Turn on "Allow user scripts"

**On Chrome and Edge this is required. Skip it and nothing happens at all** —
no error, no panel, just a script that never runs.

1. **Right-click the Violentmonkey (or Tampermonkey) icon** in the toolbar,
   top right.
2. Choose **Manage extension**.
3. Toggle **Allow user scripts** on.

<sub>Older Chrome builds put this behind a **Developer mode** switch at the top
right of `chrome://extensions` instead. If you see no "Allow user scripts"
toggle, turn Developer mode on and look again.</sub>

**Firefox users: skip this step.** It does not exist and is not needed.

---

## 3. Install the script

Open the raw script and your manager will offer to install it:

**[→ steam-market-helper.user.js](https://raw.githubusercontent.com/federicogiorgi/SteamMarketHelper/main/steam-market-helper.user.js)**

Press **Install** / **Confirm installation**.

---

## Check it worked

Go to your Steam inventory or [the market](https://steamcommunity.com/market/)
while **logged in**. A dark panel appears in the bottom-right corner.

Drag it by its title bar. Click the `–` to collapse it.

**No panel?** In order of likelihood:

1. You skipped step 2 above. That is nearly always the answer on Chrome/Edge.
2. You are not logged in to Steam.
3. You are on a page the script does not cover — it runs on your inventory and
   on `steamcommunity.com/market`, not on individual item pages.

---

## Updating

**Userscript managers do not update immediately.** Violentmonkey checks about
once a day, so after a fix is published you keep running the old script until it
gets round to noticing — and an old script looks exactly like a fix that did not
work: the same failure, in the same words.

The panel footer shows the installed version. Compare it against the
[latest release](https://github.com/federicogiorgi/SteamMarketHelper/blob/main/steam-market-helper.user.js)
before concluding anything is broken.

To force an update now:

- **Violentmonkey:** click the icon → the dashboard (⚙) → the script's **⋮**
  menu → **Check for updates**.
- **Tampermonkey:** click the icon → **Dashboard** → **Installed userscripts**
  → tick the script → **Check for userscript updates**.

If that does not shift it, reinstall over the top: open
[the raw script](https://raw.githubusercontent.com/federicogiorgi/SteamMarketHelper/main/steam-market-helper.user.js)
and confirm. Your settings live in the browser, not the script, so they survive.

<sub>GitHub's raw CDN caches for a few minutes, so a just-published fix can take
that long to be offered.</sub>

---

## Uninstalling

Click the extension icon → the script's **trash**/**remove** icon → confirm.

To remove everything: uninstall the extension itself. The script stores nothing
outside your browser, so no listings, prices or settings are left behind on
Steam.
