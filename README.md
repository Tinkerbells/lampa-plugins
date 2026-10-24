# Lampa plugins

Plugins for [Lampa](https://github.com/lampa-app/LAMPA) (Android TV).

## Free My TV

Sends your Lampa lists (Watch later, Bookmarks, History, ...) to the [Free My TV](https://github.com/simbasjungles/free-my-tv)
home screen on the same TV, which shows them with posters and opens the title in Lampa when you press OK.

**Install:** in Lampa, *Settings → Extensions → Add plugin*, and type

```
https://tinkerbells.github.io/lampa-plugins/free-my-tv.js
```

Restart Lampa. A **Free My TV** section appears in the settings with *Send now* and the address Free My TV listens on
(`http://127.0.0.1:38777`, the TV itself: nothing leaves your TV).

The plugin sends the lists when Lampa starts, 1.5 s after each change, when Lampa comes back to the foreground and every
10 minutes. If Free My TV isn't running it retries a few times and then waits for the next change.

### Data

`POST /lampa/favorites`, `text/plain` (a simple request: no CORS preflight)

```json
{
  "v": 1,
  "at": 1790000000000,
  "lists": { "wath": ["movie:1514026"], "history": ["tv:4607", "movie:1514026"] },
  "cards": {
    "movie:1514026": { "id": 1514026, "type": "movie", "source": "tmdb", "title": "…", "original": "…",
                       "year": 2026, "poster": "/abc.jpg", "backdrop": "/def.jpg", "rating": 7.1 }
  }
}
```

Lists: `wath` (Watch later), `book`, `like`, `look`, `viewed`, `scheduled`, `continued`, `thrown`, `history`, up to 100 each, in
the order Lampa shows them. Movies and shows are numbered separately on TMDB, so a title is `type:id`.

To open a title in Lampa from another app:
`am start -n top.rootu.lampa/.MainActivity --es id <id> --es media <movie|tv> --es source tmdb`.

## AI recommendations

Picks titles for you from your own lists with a language model, and shows them as ordinary Lampa cards (poster, rating,
the full card page, add to a list). Each card has a one-line reason in your language, shown when it is focused.

**Install:** *Settings → Extensions → Add plugin*, `https://tinkerbells.github.io/lampa-plugins/ai-recommendations.js`,
restart Lampa. Then open **Settings → AI recommendations**, choose a provider and paste your API key. The list opens
from **AI recommendations** in the menu.

- **What the model sees:** the last N titles from your history (10, 20, 30, 50 or 100; default 30, newest first), a few
  from Watched, Watching, Continue, Liked, Bookmarks, Watch later and Dropped, with year and movie/series. At most 140
  titles per request. Titles you already have in any list are never suggested back; every suggestion is looked up on
  TMDB, and ones that cannot be found are dropped.
- **Providers:** Claude (Anthropic Messages API, default model `claude-haiku-5-5`, structured JSON output) or any
  OpenAI-compatible chat endpoint (OpenAI, OpenRouter, a local server, ...): set the address and the model name.
- **Your key:** typed in the settings, kept in this device's Lampa storage and sent only to the address you set. Use a
  key with a spending limit. The result is cached for 12 hours (*Get new recommendations* skips the cache).
- **Privacy:** titles, years and list names are sent to the provider you choose. Nothing else about you.
- **Availability:** providers are not available everywhere. Anthropic's API is only offered in the countries on its
  [supported list](https://www.anthropic.com/supported-countries); check your provider's terms for where you are.

## Torrent season jump

On a series' torrent list Lampa shows a plaque with the last thing you opened ("Torrent • Season 21 • Episode 3"). It is
only a label: pressing OK on it does nothing, and the built-in *Filter → Season* reads release titles strictly, so it can
miss seasons. This plugin makes the plaque a button: **OK on it lists every release of that season** and opens the one
you pick.

**Install:** *Settings → Extensions → Add plugin*, `https://tinkerbells.github.io/lampa-plugins/torrent-season-jump.js`,
restart Lampa. The plaque then shows *OK: releases of season N*.

- **Which season:** the one Lampa saved when you last opened a file of this series (`online_watched_last`).
- **How releases are found:** from the titles in the current search results, not from the built-in filter: `21 сезон`,
  `21-й сезон`, `сезон 21`, `Season 21`, `S21`, `S21E03`, `21x03`, and packs such as `1-25 сезон`, `S01-S25`, `Сезоны 1-24`
  (shown last, labelled *Pack 1-25*). Episode ranges (`сезон: 1-12 серии`) and years are not mistaken for seasons.
- **Order:** the release you opened last (★), then ones Lampa already knew you opened (✓, from its own viewed list, so
  your history from before the plugin counts), then the rest: the season's own releases before packs, most seeded first.
  The first row is focused. Releases opened through the picker or the normal list are remembered per series.
- **Needs** the torrent list to have been loaded in this session (the plugin reads the results of the search the list
  just made); otherwise it asks you to reopen the list.
- **"You watched" block:** above the list (over the plaque) the releases you opened before, so one OK takes you
  back to them. Two sources: the plugin's own record per series (the last 8 releases, newest first, kept with their
  magnet/link, so a release is offered even if today's search no longer returns it: Lampa only keeps a hash, and a
  release's title changes when episodes are added), and releases Lampa marks as viewed in today's results (so history
  from before the plugin shows up, but only while the search returns them).
- **History list:** OK on a series in *History* opens the release you opened last straight away, without the card and
  the season choice. Series with no recorded release open the card as usual. Turn it off in *Settings → Torrents:
  seasons → History opens the release*.
- Back closes the picker.

## Writing a plugin: the `lampa-plugin` skill

[`skills/lampa-plugin`](skills/lampa-plugin/SKILL.md) is a skill for AI coding agents (Claude Code and compatible) that
knows how to write, test, debug and publish a Lampa plugin: the ES5 and guard rules for old TV WebViews, the `Lampa.*`
API you actually need, the user's lists, talking to a local app from a plugin, Android-specific tricks, hosting on
GitHub Pages, and an on-TV debugging recipe. It also ships a Node test stand-in (`lampa-fake.js`, `example-test.js`).

Use it in this repository as it is (`.claude/skills/lampa-plugin` points to it), or install it for every project:

```
cp -R skills/lampa-plugin ~/.claude/skills/
```

Run the example test: `node skills/lampa-plugin/example-test.js`.

## По-русски

Плагин `free-my-tv.js` отправляет ваши списки Lampa («Позже», «Закладки», «История» и др.) на главный экран Free My TV на этом же
телевизоре. Установка: *Настройки → Расширения → Добавить плагин*, адрес
`https://tinkerbells.github.io/lampa-plugins/free-my-tv.js`, затем перезапустите Lampa. Данные не покидают телевизор.


Плагин `ai-recommendations.js` подбирает фильмы и сериалы по вашим спискам с помощью языковой модели (Claude или любой
OpenAI-совместимый сервис), с постерами и причиной рекомендации. Адрес:
`https://tinkerbells.github.io/lampa-plugins/ai-recommendations.js`. Нужен ваш собственный API-ключ (вводится в
*Настройки → AI рекомендации*); модели уходят только названия, годы и названия списков. Доступность провайдера зависит от
региона: проверьте условия вашего провайдера.

Плагин `torrent-season-jump.js` делает плашку «Torrent • Сезон 21 • Серия 3» на экране торрентов кнопкой: OK на ней показывает
все раздачи этого сезона (одиночные и паки «1-25 сезон»), даже если встроенный фильтр «Сезон» их не видит. Адрес:
`https://tinkerbells.github.io/lampa-plugins/torrent-season-jump.js`.

Написан по образцу [levende/lampa-plugins](https://github.com/levende/lampa-plugins) и [nb557/plugins](https://github.com/nb557/plugins).
