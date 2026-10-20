(function () {
    'use strict';

    /*
     * Free My TV bridge for Lampa.
     *
     * Free My TV (github.com/simbasjungles/free-my-tv) is a home screen for Google TV and Android TV. It listens on
     * the TV itself (127.0.0.1) and shows your Lampa lists ("Watch later", "History", ...) with posters. Lampa keeps
     * those lists in its own private storage, so this plugin sends them: on start, a moment after every change, when
     * Lampa comes back to the foreground, and every few minutes.
     *
     * Wire format (POST <host>/lampa/favorites, text/plain so the request needs no CORS preflight):
     *   { v: 1, at: <ms>, lists: { wath: ["movie:123", "tv:45"], ... }, cards: { "movie:123": { id, type, title, ... } } }
     * Lists are in the order Lampa shows them. Cards carry what the home screen needs to draw a poster and to open the
     * title in Lampa again (id + type + source).
     */

    var DEFAULT_HOST = 'http://127.0.0.1:38777';
    var LISTS = ['wath', 'book', 'like', 'look', 'viewed', 'scheduled', 'continued', 'thrown', 'history'];
    var MAX_PER_LIST = 100;
    var DEBOUNCE_MS = 1500;
    var REPEAT_MS = 10 * 60 * 1000;
    var RETRY_MS = [5000, 15000, 45000, 120000];
    var TIMEOUT_MS = 8000;

    var debounceTimer = null;
    var retryTimer = null;
    var attempt = 0;
    var sending = false;
    var pending = false;

    function host() {
        var h = String(Lampa.Storage.get('free_my_tv_host', '') || DEFAULT_HOST).replace(/\s+/g, '');
        return h.replace(/\/+$/, '');
    }

    function isTv(card) {
        return !!card.number_of_seasons
            || !!card.number_of_episodes
            || !!card.next_episode_to_air
            || !!card.first_air_date
            || (!!card.original_name && !card.original_title);
    }

    function yearOf(card) {
        var date = String(card.release_date || card.first_air_date || '');
        return date.length >= 4 ? parseInt(date.substring(0, 4), 10) || 0 : 0;
    }

    function toCard(card) {
        return {
            id: card.id,
            type: isTv(card) ? 'tv' : 'movie',
            source: card.source || 'tmdb',
            title: card.title || card.name || card.original_title || card.original_name || '',
            original: card.original_title || card.original_name || '',
            year: yearOf(card),
            poster: card.poster_path || card.img || '',
            backdrop: card.backdrop_path || '',
            rating: card.vote_average || 0
        };
    }

    // The cards of one list, in Lampa's display order.
    function listCards(name, favorite) {
        var cards = [];
        try {
            if (Lampa.Favorite && typeof Lampa.Favorite.get === 'function') {
                cards = Lampa.Favorite.get({type: name}) || [];
            }
        } catch (e) {
            cards = [];
        }
        if (cards.length) return cards;

        // Older builds: the saved lists hold ids, the cards are kept apart.
        var ids = favorite[name] || [];
        var all = favorite.card || [];
        for (var i = 0; i < ids.length; i++) {
            for (var j = 0; j < all.length; j++) {
                if (all[j].id === ids[i]) {
                    cards.push(all[j]);
                    break;
                }
            }
        }
        return cards;
    }

    function collect() {
        var favorite = Lampa.Storage.get('favorite', '{}') || {};
        var lists = {};
        var cards = {};

        for (var i = 0; i < LISTS.length; i++) {
            var name = LISTS[i];
            var items = listCards(name, favorite).slice(0, MAX_PER_LIST);
            var refs = [];
            for (var j = 0; j < items.length; j++) {
                if (!items[j] || items[j].id === undefined || items[j].id === null) continue;
                var card = toCard(items[j]);
                var key = card.type + ':' + card.id;
                cards[key] = card;
                refs.push(key);
            }
            lists[name] = refs;
        }

        return {v: 1, at: new Date().getTime(), lists: lists, cards: cards};
    }

    function post(body, done) {
        var request = new XMLHttpRequest();
        request.open('POST', host() + '/lampa/favorites', true);
        request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        request.timeout = TIMEOUT_MS;
        request.onload = function () {
            done(request.status >= 200 && request.status < 300);
        };
        request.onerror = function () {
            done(false);
        };
        request.ontimeout = function () {
            done(false);
        };
        try {
            request.send(body);
        } catch (e) {
            done(false);
        }
    }

    // Sends the lists now. When Free My TV isn't listening (the TV is starting up, or its home screen was closed), it
    // tries again a few times, then waits for the next change.
    function send(manual) {
        if (sending) {
            pending = true;
            return;
        }
        sending = true;
        clearTimeout(retryTimer);

        post(JSON.stringify(collect()), function (ok) {
            sending = false;
            if (ok) {
                attempt = 0;
                if (manual) Lampa.Noty.show(Lampa.Lang.translate('free_my_tv_sent'));
            } else if (manual) {
                Lampa.Noty.show(Lampa.Lang.translate('free_my_tv_failed'));
            } else if (attempt < RETRY_MS.length) {
                retryTimer = setTimeout(function () {
                    send(false);
                }, RETRY_MS[attempt]);
                attempt++;
            }
            if (pending) {
                pending = false;
                schedule();
            }
        });
    }

    function schedule() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
            attempt = 0;
            send(false);
        }, DEBOUNCE_MS);
    }

    function addSettings() {
        Lampa.Lang.add({
            free_my_tv_title: {
                en: 'Free My TV',
                ru: 'Free My TV',
                uk: 'Free My TV'
            },
            free_my_tv_host: {
                en: 'Free My TV address',
                ru: 'Адрес Free My TV',
                uk: 'Адреса Free My TV'
            },
            free_my_tv_host_descr: {
                en: 'Where the home screen listens on the TV. Leave as is unless you know you need to change it',
                ru: 'Где главный экран слушает на телевизоре. Не меняйте без необходимости',
                uk: 'Де головний екран слухає на телевізорі. Не змінюйте без потреби'
            },
            free_my_tv_send: {
                en: 'Send now',
                ru: 'Отправить сейчас',
                uk: 'Надіслати зараз'
            },
            free_my_tv_send_descr: {
                en: 'Sends your bookmarks and history to the Free My TV home screen',
                ru: 'Отправляет закладки и историю на главный экран Free My TV',
                uk: 'Надсилає закладки та історію на головний екран Free My TV'
            },
            free_my_tv_sent: {
                en: 'Sent to Free My TV',
                ru: 'Отправлено в Free My TV',
                uk: 'Надіслано до Free My TV'
            },
            free_my_tv_failed: {
                en: 'Free My TV did not answer. Open its home screen once and try again',
                ru: 'Free My TV не отвечает. Откройте его главный экран и повторите',
                uk: 'Free My TV не відповідає. Відкрийте його головний екран і повторіть'
            }
        });

        Lampa.SettingsApi.addComponent({
            component: 'free_my_tv',
            name: Lampa.Lang.translate('free_my_tv_title'),
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'free_my_tv',
            param: {
                name: 'free_my_tv_send',
                type: 'static'
            },
            field: {
                name: Lampa.Lang.translate('free_my_tv_send'),
                description: Lampa.Lang.translate('free_my_tv_send_descr')
            },
            onRender: function (item) {
                item.on('hover:enter', function () {
                    send(true);
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'free_my_tv',
            param: {
                name: 'free_my_tv_host',
                type: 'input',
                placeholder: DEFAULT_HOST,
                values: '',
                default: ''
            },
            field: {
                name: Lampa.Lang.translate('free_my_tv_host'),
                description: Lampa.Lang.translate('free_my_tv_host_descr')
            },
            onChange: function () {
                schedule();
            }
        });
    }

    function start() {
        if (window.free_my_tv_plugin) return;
        window.free_my_tv_plugin = true;

        addSettings();

        // Lampa saves the lists through Storage.set('favorite', ...) on every add and remove.
        Lampa.Storage.listener.follow('change', function (event) {
            if (event.name === 'favorite') schedule();
        });

        if (Lampa.Favorite && Lampa.Favorite.listener && typeof Lampa.Favorite.listener.follow === 'function') {
            Lampa.Favorite.listener.follow('add,added,remove,removed', schedule);
        }

        // Back in Lampa from another app: the home screen may have been restarted meanwhile.
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) schedule();
        });

        setInterval(function () {
            attempt = 0;
            send(false);
        }, REPEAT_MS);

        schedule();
    }

    if (window.appready) {
        start();
    } else {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') start();
        });
    }
})();
