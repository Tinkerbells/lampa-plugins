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

## По-русски

Плагин отправляет ваши списки Lampa («Позже», «Закладки», «История» и др.) на главный экран Free My TV на этом же
телевизоре. Установка: *Настройки → Расширения → Добавить плагин*, адрес
`https://tinkerbells.github.io/lampa-plugins/free-my-tv.js`, затем перезапустите Lampa. Данные не покидают телевизор.

Написан по образцу [levende/lampa-plugins](https://github.com/levende/lampa-plugins) и [nb557/plugins](https://github.com/nb557/plugins).
