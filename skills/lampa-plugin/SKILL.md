---
name: lampa-plugin
description: Use for writing, testing, debugging or publishing a Lampa plugin (the Lampa media app on Android TV, webOS, Tizen and browsers): the plugin skeleton and guards, the Lampa.* API (Storage, Favorite, Listener, SettingsApi, Activity, Reguest), ES5 constraints of old TV WebViews, talking to a local app from a plugin, GitHub Pages hosting and the install URL, a Node test harness, and on-TV debugging with adb.
---

# Lampa plugin

A Lampa plugin is one standalone JavaScript file. The user adds its URL in Lampa (*Settings → Extensions → Add plugin*),
Lampa injects it as a `<script>` into the running web app, and it talks to the app only through `window.Lampa` (plus
jQuery as `$`). No bundler, no imports.

Authoritative reference, read it before inventing an API: the official guide in the app source,
<https://github.com/yumata/lampa-source/tree/main/docs/en> (13 short chapters: lifecycle, events, storage/network, templates,
UI components, navigation, settings, manifest/menu, player, pitfalls, debug, controller). Working examples:
[levende/lampa-plugins](https://github.com/levende/lampa-plugins) and [nb557/plugins](https://github.com/nb557/plugins).
`Lampa.Manifest.app_digital >= 300` means Lampa 3.x (new Maker/module API; `Lampa.Card`, `InteractionMain`,
`InteractionCategory`, `InteractionLine` are deprecated).

## Hard rules

1. **ES5 only** (`var`, `function`, no arrow functions, template literals, `let/const`, `async`, `Promise` without a
   check). TV WebViews on webOS 3/4 and Tizen 3 are Chromium 2015 to 2017. The official guide's examples use ES6; the
   plugins people actually run on TVs do not. Add the small polyfills you really use (see levende's `random-scheduled.js`).
2. **Double-load guard**: the file can run twice (re-install, same URL added twice).
3. **Wait for `appready`** before touching Menu, Activity, Settings or the DOM; Storage, Lang and Template are safe earlier.
4. **Prefix every Storage key and global** with the plugin name (`free_my_tv_host`, `window.free_my_tv_plugin`).
5. **jQuery events for the remote**: `$(el).on('hover:enter', fn)`. `addEventListener('hover:enter')` never fires.
6. **Clean up in `destroy()`**: `network.clear()`, remove listeners, `html.remove()`, and guard late callbacks with an
   `inited` flag. Keep handlers in named variables so `listener.remove` works.
7. Never replace `window.lampa_settings`; extend it. Inject CSS inside `init()`, not at the top level.
8. No bare `console.log` noise in production; if you log, prefix with the plugin name.

## Skeleton (ES5)

```js
(function () {
    'use strict';

    function start() {
        if (window.my_plugin_ready) return;   // guard
        window.my_plugin_ready = true;

        Lampa.Lang.add({ my_title: { en: 'My plugin', ru: 'Мой плагин', uk: 'Мій плагін' } });
        // templates, components, settings, menu items, listeners ...
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
```

Always give `en` and `ru` (and `uk` if you can); Lampa falls back to `ru`.

## API cheat sheet

| Need | Use |
|---|---|
| Persist | `Lampa.Storage.get(key, default)`, `.set(key, value)`, `.field(key)` (value or the param's default), `.add/.remove` for arrays |
| React to a change | `Lampa.Storage.listener.follow('change', function (e) { e.name, e.value })` |
| App events | `Lampa.Listener.follow('app' \| 'activity' \| 'full' \| 'line', fn)`; unsubscribe with `.remove(type, fn)` |
| Strings | `Lampa.Lang.add({key: {en, ru}})`, `Lampa.Lang.translate('key')` |
| Settings page | `Lampa.SettingsApi.addComponent({component, name, icon})` then `addParam({component, param: {name, type: 'trigger' \| 'select' \| 'input' \| 'static', default, values, placeholder}, field: {name, description}, onChange, onRender})`; a `static` param with `onRender: function (item) { item.on('hover:enter', fn) }` is a button |
| Toast / pick / dialog | `Lampa.Noty.show(text, {style: 'error', time})`, `Lampa.Select.show`, `Lampa.Modal.open` |
| HTTP (with proxy and loader) | `var net = new Lampa.Reguest(); net.silent(url, ok, fail, postData, {timeout})`; `net.clear()` on destroy |
| Open a title | `Lampa.Activity.push({component: 'full', id: card.id, method: 'movie' \| 'tv', source: card.source, card: card})` |
| Sidebar entry | `$('.menu .menu__list').eq(0).append($('<li class="menu__item selector">...</li>'))` |
| Card long-press menu | `Lampa.Manifest.plugins = {type: 'video', name, onContextMenu, onContextLauch}` |
| Version | `Lampa.Manifest.app_digital` (328 = 3.2.8), `Lampa.Platform.screen('tv')` |

### The user's lists

`Lampa.Favorite.get({type: 'wath'})` returns the cards of a list in display order; `Lampa.Favorite.all()` returns the raw
object; `Lampa.Storage.get('favorite', '{}')` is `{card: [...], wath: [ids], book, like, look, viewed, scheduled,
continued, thrown, history}`. `wath` is "Watch later". Lists hold ids; the cards live in `card`. After writing lists
yourself, call `Lampa.Favorite.read()` (or `init()` on old builds).
`Lampa.Favorite.listener` fires `add`, `added`, `remove` with `{where, card}`; every change also goes through
`Storage.set('favorite')`, so a Storage listener on `favorite` catches them all.
**Movies and shows are numbered separately on TMDB**: identify a title by `type:id`. Cards do not carry a type; use
`number_of_seasons`, `number_of_episodes`, `next_episode_to_air`, `first_air_date` or `original_name` without
`original_title` to tell a show (see `isTv` in `free-my-tv.js`). Poster/backdrop are TMDB paths (`/abc.jpg`).

## Talking to something outside Lampa

- A plugin runs inside Lampa's page (origin like `http://lampa.mx` or `https://cf.lampa.mx`), so ordinary XHR rules apply.
- **Verified on Android TV (WebView 155): a plain `XMLHttpRequest` POST to `http://127.0.0.1:<port>` works from Lampa's
  page**, with no mixed-content block and no preflight when the body is `text/plain`. Keep it a "simple request" and still
  answer `OPTIONS` on the server (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network: true`) so newer
  WebViews that do send a Private Network Access preflight keep working. See `free-my-tv.js` for send, debounce and retry.
- Lampa is a web view with no filesystem access, so pushing to a local server is the way to give another app on the TV
  your data (the app's own storage is private; `run-as` fails on the release build).
- Debounce change events (1 to 2 s), resend on `visibilitychange` and every few minutes, retry a few times with back-off
  when the receiver is down, and cap the payload (lists of at most ~100 items).

## Android app specifics (lampa-app/LAMPA, package `top.rootu.lampa`)

- Open a title from another app: `am start -n top.rootu.lampa/.MainActivity --es id <tmdb id> --es media <movie|tv> --es source tmdb`.
  Verified when Lampa is already running; right after a cold start the web app may not be ready and Lampa logs
  `runVoidJsFunc ... FAILED` (see below).
- Search: an intent with `SearchManager.QUERY` opens Lampa's search prefilled.
- Its Android TV home-screen channels and Watch Next only work if the TV exposes a TV content provider
  (`isTvContentProviderAvailable`); on a TV with a different home screen they stay empty.
- The native side calls the web app through `runVoidJsFunc(...)`; failures show up in `adb logcat` as
  `I runVoidJsFunc: <js> Result "FAILED: <error>"`.

## Testing

1. **Syntax**: `node --check my-plugin.js`.
2. **Logic in Node, no TV**: `lampa-fake.js` in this folder installs a recording fake `Lampa`, `XMLHttpRequest`, `window` and
   `document`; `example-test.js` drives `free-my-tv.js` with it (payload shape, debounce, retry). Copy and adapt:
   `node skills/lampa-plugin/example-test.js`.
3. **In a real Lampa, in a browser** (verified; no build needed): open `https://cf.lampa.mx` in Chromium (`lampa.mx` itself
   fails TLS in some Chromium builds). First run shows a language wizard: press Enter, then wait for `window.appready`
   (it first shows "Loading plugins"). Seed state with `Lampa.Storage.set('favorite', {...}); Lampa.Favorite.read();`,
   inject the plugin with a `<script>` whose `textContent` is the file, then drive it
   (`Lampa.Activity.push({component: ...})`). Mock any external API with request interception (answer the CORS `OPTIONS`
   preflight with 204 and `access-control-allow-origin/headers`, then the real reply); evaluate in the page world, not
   an isolated one. Alternatively clone `yumata/lampa-source`, `npm install && npm run start` (<http://localhost:3000>)
   and add your URL under *Settings → Extensions*; `npm run debug` adds source maps, and a `debugger` statement pauses
   inside the script.
4. **On the TV**: the release Lampa WebView is not debuggable. Prove behaviour from outside:
   - to see whether a request leaves the plugin, run a stand-in server on the TV through adb, for example
     `adb shell "printf 'HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n' | nc -l -p 38777 > /data/local/tmp/req.txt"`,
     use the plugin, then `adb shell cat /data/local/tmp/req.txt` (shows headers and body). Kill the loop afterwards;
   - `adb logcat -d | grep -i runVoidJsFunc` for native-to-web calls and their errors;
   - use `Lampa.Noty.show(...)` for on-screen feedback while developing.
5. After a change, restart Lampa to load the new file, and wait out any CDN cache (or change the URL).

## Publishing

- **Do not use `raw.githubusercontent.com`**: it serves `text/plain` with `X-Content-Type-Options: nosniff`, so the browser
  refuses to run it as a script. Use **GitHub Pages** (serve the branch root) or jsDelivr
  (`https://cdn.jsdelivr.net/gh/<user>/<repo>@main/<file>.js`, `application/javascript`).
- Pages: `gh api -X POST repos/<user>/<repo>/pages -f 'source[branch]=main' -f 'source[path]=/'`; the first publish takes
  about a minute (404 until then). Install URL: `https://<user>.github.io/<repo>/<file>.js`.
- Repository convention (as in levende/lampa-plugins): one `<name>.js` per plugin at the root, a README with the install
  URL and what the plugin does, optional `docs/<name>.md`. Describe user-visible behaviour and any data the plugin sends,
  and where.

## Before you ship

- [ ] ES5 only; `node --check` passes; no `let`, `const`, `=>`, backticks.
- [ ] Guard flag and `appready` start; every Storage key and global prefixed.
- [ ] All user-visible strings in `Lampa.Lang` (en, ru, uk).
- [ ] Listeners that can leak (Player, PlayerVideo) removed in `destroy`/`Player:destroy`.
- [ ] Network calls have a timeout and a failure path; nothing blocks the UI or throws into Lampa.
- [ ] Checked on a real TV, not just in a browser (remote focus, `hover:enter`, slow WebView).
- [ ] README lists the install URL and any data sent off-device.
