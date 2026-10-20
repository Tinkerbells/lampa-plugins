(function () {
    'use strict';

    /*
     * AI recommendations for Lampa.
     *
     * Builds a taste profile from your own lists (history, watched, liked, bookmarks, watch later, dropped), asks a
     * language model for titles you have not seen, finds each one on TMDB and shows them as ordinary Lampa cards
     * (poster, rating, the full card page, add to a list). Menu: "AI recommendations".
     *
     * Providers: Claude (Anthropic Messages API, called straight from the TV) or any OpenAI-compatible chat endpoint
     * (OpenAI, OpenRouter, a local server, ...). You bring your own API key: it is typed in the settings, stays in
     * this device's Lampa storage and is sent only to the address you configured. What is sent: titles, years and the
     * list they are in. Nothing else about you.
     *
     * Written in ES5 on purpose: old TV WebViews (webOS 3/4, Tizen 3) cannot run newer syntax.
     */

    var COMPONENT = 'ai_recs';
    var KEY = {
        provider: 'ai_recs_provider',
        key: 'ai_recs_key',
        base: 'ai_recs_base',
        model: 'ai_recs_model',
        count: 'ai_recs_count',
        recent: 'ai_recs_recent',
        wishes: 'ai_recs_wishes',
        cache: 'ai_recs_cache'
    };
    var DEFAULTS = {
        anthropic: {base: 'https://api.anthropic.com', model: 'claude-haiku-5-5'},
        openai: {base: 'https://api.openai.com/v1', model: ''}
    };
    var ANTHROPIC_VERSION = '2023-06-01';
    var REQUEST_TIMEOUT_MS = 90000;
    var CACHE_TTL_MS = 12 * 60 * 60 * 1000;
    var EXTRA = 5;   // asked for on top: some titles will not be found on TMDB, some will already be in your lists

    // How many items of each list go into the prompt, newest first. "history" is the main signal and its length is a
    // setting; TOTAL_MAX is a hard ceiling on titles per request so the prompt stays small whatever the lists hold.
    var CAPS = {viewed: 15, look: 10, continued: 10, like: 25, book: 15, wath: 25, scheduled: 10, thrown: 20};
    var RECENT_DEFAULT = 30;
    var TOTAL_MAX = 140;
    var GROUPS = {
        watched: ['history', 'viewed', 'look', 'continued'],
        liked: ['like', 'book'],
        queued: ['wath', 'scheduled'],
        dropped: ['thrown']
    };

    var SCHEMA = {
        type: 'object',
        properties: {
            recommendations: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        type: {type: 'string', enum: ['movie', 'tv']},
                        title: {type: 'string'},
                        original_title: {type: 'string'},
                        year: {type: 'integer'},
                        reason: {type: 'string'}
                    },
                    required: ['type', 'title', 'original_title', 'year', 'reason'],
                    additionalProperties: false
                }
            }
        },
        required: ['recommendations'],
        additionalProperties: false
    };

    // ---------------------------------------------------------------------------------------------- settings

    function setting(name) {
        return String(Lampa.Storage.get(KEY[name], '') || '').replace(/^\s+|\s+$/g, '');
    }

    function provider() {
        return setting('provider') === 'openai' ? 'openai' : 'anthropic';
    }

    function baseUrl() {
        var base = setting('base') || DEFAULTS[provider()].base;
        return base.replace(/\/+$/, '');
    }

    function model() {
        return setting('model') || DEFAULTS[provider()].model;
    }

    function wantedCount() {
        var n = parseInt(setting('count'), 10);
        return n > 0 && n <= 30 ? n : 15;
    }

    // The last N titles you watched (Lampa puts the newest first in "history").
    function recentCount() {
        var n = parseInt(setting('recent'), 10);
        return n > 0 && n <= 100 ? n : RECENT_DEFAULT;
    }

    function languageName() {
        var code = String(Lampa.Storage.get('language', 'en') || 'en');
        var names = {ru: 'Russian', uk: 'Ukrainian', en: 'English', be: 'Belarusian', bg: 'Bulgarian', pt: 'Portuguese', zh: 'Chinese', cs: 'Czech'};
        return names[code] || code;
    }

    // -------------------------------------------------------------------------------------------- your lists

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

    function keyOf(card) {
        return (isTv(card) ? 'tv:' : 'movie:') + card.id;
    }

    function describe(card) {
        var name = card.original_title || card.original_name || card.title || card.name || '';
        var year = yearOf(card);
        return name + ' (' + (year ? year + ', ' : '') + (isTv(card) ? 'series' : 'movie') + ')';
    }

    function listCards(name) {
        var cards = [];
        try {
            if (Lampa.Favorite && typeof Lampa.Favorite.get === 'function') cards = Lampa.Favorite.get({type: name}) || [];
        } catch (e) {
            cards = [];
        }
        return cards;
    }

    // Titles by group for the prompt, plus every key you already have anywhere (never recommended back).
    function collect() {
        var profile = {watched: [], liked: [], queued: [], dropped: [], seen: {}, empty: true};
        var group;
        var i;
        var j;
        var used = 0;

        for (group in GROUPS) {
            if (!GROUPS.hasOwnProperty(group)) continue;
            var done = {};
            for (i = 0; i < GROUPS[group].length; i++) {
                var name = GROUPS[group][i];
                var cards = listCards(name);
                var cap = name === 'history' ? recentCount() : CAPS[name];
                for (j = 0; j < cards.length; j++) {
                    var card = cards[j];
                    if (!card || card.id === undefined || card.id === null) continue;
                    profile.seen[keyOf(card)] = true;
                    if (j < cap && used < TOTAL_MAX && !done[keyOf(card)]) {
                        done[keyOf(card)] = true;
                        used++;
                        profile[group].push(describe(card));
                        profile.empty = false;
                    }
                }
            }
        }
        return profile;
    }

    // ---------------------------------------------------------------------------------------------- the prompt

    function section(title, items) {
        if (!items.length) return '';
        return title + ':\n- ' + items.join('\n- ') + '\n\n';
    }

    function systemPrompt() {
        return 'You are a film and TV recommendation expert with broad, accurate knowledge of cinema and television. '
            + 'You recommend real, existing titles that can be found on TMDB, and you never invent titles.';
    }

    function userPrompt(profile, count, wishes) {
        return 'Recommend ' + (count + EXTRA) + ' titles for this viewer, based on what they watch.\n\n'
            + section('Watched or watching (most recent first)', profile.watched)
            + section('Liked or bookmarked (strongest signal of taste)', profile.liked)
            + section('Already queued to watch later (do NOT recommend these)', profile.queued)
            + section('Started and dropped, or disliked (avoid anything similar)', profile.dropped)
            + (wishes ? 'Wishes for this time: ' + wishes + '\n\n' : '')
            + 'Rules:\n'
            + '- Never recommend a title from the lists above.\n'
            + '- Match the taste, but add variety: different eras, countries and tones, not only sequels or the same franchise.\n'
            + '- Use the type that fits the title: "movie" or "tv" (for series and miniseries).\n'
            + '- "original_title" is the title exactly as TMDB lists it in the original language; "title" is the title in ' + languageName() + '; "year" is the first release year.\n'
            + '- "reason" is one short sentence (under 140 characters) in ' + languageName() + ' saying why it fits this viewer, mentioning a title from their lists when useful.\n'
            + '- Prefer well-known, verifiable titles over obscure ones.\n';
    }

    // ----------------------------------------------------------------------------------------------- transport

    function send(method, url, headers, body, done) {
        var request = new XMLHttpRequest();
        var finished = false;

        function finish(status, text) {
            if (finished) return;
            finished = true;
            done(status, text);
        }

        request.open(method, url, true);
        for (var name in headers) if (headers.hasOwnProperty(name)) request.setRequestHeader(name, headers[name]);
        request.timeout = REQUEST_TIMEOUT_MS;
        request.onload = function () {
            finish(request.status, request.responseText);
        };
        request.onerror = function () {
            finish(0, '');
        };
        request.ontimeout = function () {
            finish(0, 'timeout');
        };
        try {
            request.send(body);
        } catch (e) {
            finish(0, '');
        }
    }

    function errorText(status, text) {
        var detail = '';
        try {
            var parsed = JSON.parse(text);
            detail = (parsed.error && (parsed.error.message || parsed.error)) || '';
        } catch (e) {
            detail = '';
        }
        if (typeof detail !== 'string') detail = '';

        if (status === 0) return Lampa.Lang.translate('ai_recs_err_network');
        if (status === 401) return Lampa.Lang.translate('ai_recs_err_key');
        if (status === 403) return Lampa.Lang.translate('ai_recs_err_forbidden');
        if (status === 429) return Lampa.Lang.translate('ai_recs_err_limit');
        return 'HTTP ' + status + (detail ? ': ' + detail.substring(0, 160) : '');
    }

    // done(errorMessage | null, text)
    function askAnthropic(prompt, done) {
        var body = {
            model: model(),
            max_tokens: 4000,
            system: systemPrompt(),
            messages: [{role: 'user', content: prompt}],
            output_config: {format: {type: 'json_schema', schema: SCHEMA}}
        };
        var headers = {
            'Content-Type': 'application/json',
            'x-api-key': setting('key'),
            'anthropic-version': ANTHROPIC_VERSION,
            // Anthropic only answers browser (CORS) requests that carry this header.
            'anthropic-dangerous-direct-browser-access': 'true'
        };

        send('POST', baseUrl() + '/v1/messages', headers, JSON.stringify(body), function (status, text) {
            if (status < 200 || status >= 300) return done(errorText(status, text));

            try {
                var reply = JSON.parse(text);
                if (reply.stop_reason === 'refusal') return done(Lampa.Lang.translate('ai_recs_err_refused'));
                for (var i = 0; i < reply.content.length; i++) {
                    if (reply.content[i].type === 'text') return done(null, reply.content[i].text);
                }
            } catch (e) {
                // falls through
            }
            done(Lampa.Lang.translate('ai_recs_err_reply'));
        });
    }

    function askOpenAI(prompt, done, withFormat) {
        var body = {
            model: model(),
            messages: [
                {role: 'system', content: systemPrompt()},
                {
                    role: 'user',
                    content: prompt + '\nRespond with one JSON object only, no other text, in this shape: '
                        + '{"recommendations":[{"type":"movie|tv","title":"","original_title":"","year":0,"reason":""}]}'
                }
            ]
        };
        if (withFormat !== false) body.response_format = {type: 'json_object'};
        var headers = {'Content-Type': 'application/json'};
        if (setting('key')) headers.Authorization = 'Bearer ' + setting('key');

        send('POST', baseUrl() + '/chat/completions', headers, JSON.stringify(body), function (status, text) {
            // Some compatible servers do not know response_format: ask once more without it.
            if (status === 400 && withFormat !== false && /response_format/i.test(text)) return askOpenAI(prompt, done, false);
            if (status < 200 || status >= 300) return done(errorText(status, text));

            try {
                var reply = JSON.parse(text);
                return done(null, reply.choices[0].message.content);
            } catch (e) {
                done(Lampa.Lang.translate('ai_recs_err_reply'));
            }
        });
    }

    // The model's JSON, tolerant of a stray sentence or a code fence around it.
    function parseItems(text) {
        var start = String(text).indexOf('{');
        var end = String(text).lastIndexOf('}');
        var list;
        var items = [];

        if (start < 0 || end <= start) return null;
        try {
            list = JSON.parse(String(text).substring(start, end + 1)).recommendations;
        } catch (e) {
            return null;
        }
        if (!list || typeof list.length !== 'number') return null;

        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item || typeof item.title !== 'string' || !item.title) continue;
            var type = String(item.type || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
            items.push({
                type: type,
                title: item.title,
                original: typeof item.original_title === 'string' && item.original_title ? item.original_title : item.title,
                year: parseInt(item.year, 10) || 0,
                reason: typeof item.reason === 'string' ? item.reason : ''
            });
        }
        return items;
    }

    // ------------------------------------------------------------------------------------------------- TMDB

    function searchUrl(item, withYear) {
        var path = 'search/' + item.type + '?query=' + encodeURIComponent(item.original)
            + '&include_adult=false&language=' + encodeURIComponent(Lampa.Storage.get('language', 'en'));
        if (withYear && item.year) path += (item.type === 'tv' ? '&first_air_date_year=' : '&year=') + item.year;
        return Lampa.TMDB.api(path + '&api_key=' + Lampa.TMDB.key());
    }

    function pick(item, results) {
        var best = null;
        for (var i = 0; i < results.length; i++) {
            if (!results[i] || !results[i].id) continue;
            var year = yearOf(results[i]);
            if (!item.year || !year || Math.abs(year - item.year) <= 1) return results[i];
            if (!best) best = results[i];
        }
        return item.year ? null : best;
    }

    function find(item, done) {
        var network = new Lampa.Reguest();

        function lookup(withYear) {
            network.silent(searchUrl(item, withYear), function (json) {
                var card = pick(item, (json && json.results) || []);
                if (!card && withYear) return lookup(false);
                done(card);
            }, function () {
                done(null);
            });
        }

        lookup(true);
    }

    // done(cards): in the model's order, found on TMDB, not in your lists, no repeats.
    function resolve(items, seen, count, done) {
        var found = new Array(items.length);
        var left = items.length;

        if (!left) return done([]);

        function one(index) {
            find(items[index], function (card) {
                found[index] = card;
                if (--left === 0) finishAll();
            });
        }

        function finishAll() {
            var cards = [];
            var used = {};
            for (var i = 0; i < items.length; i++) {
                var card = found[i];
                if (!card) continue;
                card.source = 'tmdb';
                if (items[i].type === 'tv' && !card.name && card.title) card.name = card.title;
                var key = (items[i].type === 'tv' ? 'tv:' : 'movie:') + card.id;
                if (seen[key] || used[key]) continue;
                used[key] = true;
                card.ai_reason = items[i].reason;
                cards.push(card);
            }
            done(cards.slice(0, count));
        }

        for (var i = 0; i < items.length; i++) one(i);
    }

    // ------------------------------------------------------------------------------------------------ cache

    function signature(profile, count) {
        return [provider(), model(), count, recentCount(), setting('wishes'), Lampa.Storage.get('language', 'en'), Object.keys(profile.seen).sort().join(',')].join('|');
    }

    function readCache(sig) {
        var cache = Lampa.Storage.get(KEY.cache, '');
        if (cache && typeof cache === 'object' && cache.sig === sig && cache.at && new Date().getTime() - cache.at < CACHE_TTL_MS && cache.cards && cache.cards.length) {
            return cache.cards;
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------- the whole flow

    // done(errorMessage | null, cards)
    function recommend(force, done) {
        if (!setting('key') && !(provider() === 'openai' && setting('base'))) return done(Lampa.Lang.translate('ai_recs_err_nokey'));
        if (provider() === 'openai' && !model()) return done(Lampa.Lang.translate('ai_recs_err_nomodel'));

        var profile = collect();
        if (profile.empty) return done(Lampa.Lang.translate('ai_recs_err_empty'));

        var count = wantedCount();
        var sig = signature(profile, count);
        var cached = force ? null : readCache(sig);
        if (cached) return done(null, cached);

        var prompt = userPrompt(profile, count, setting('wishes'));
        (provider() === 'openai' ? askOpenAI : askAnthropic)(prompt, function (error, text) {
            if (error) return done(error);
            var items = parseItems(text);
            if (!items || !items.length) return done(Lampa.Lang.translate('ai_recs_err_reply'));

            resolve(items, profile.seen, count, function (cards) {
                if (!cards.length) return done(Lampa.Lang.translate('ai_recs_err_none'));
                Lampa.Storage.set(KEY.cache, {sig: sig, at: new Date().getTime(), cards: cards});
                done(null, cards);
            });
        });
    }

    // ------------------------------------------------------------------------------------------------ the UI

    function AiRecsComponent(object) {
        var comp = Lampa.Maker.make('Category', object, function (module) {
            return module.toggle(module.MASK.base);
        });

        comp.use({
            onCreate: function () {
                var self = this;
                self.activity.loader(true);

                recommend(!!object.force, function (error, cards) {
                    if (error) {
                        Lampa.Noty.show(error, {style: 'error', time: 7000});
                        return self.empty();
                    }
                    self.build({results: cards, page: 1, total_pages: 1});
                });
            },
            onInstance: function (item, data) {
                item.use({
                    onEnter: function () {
                        Lampa.Router.call('full', data);
                    },
                    onFocus: function () {
                        Lampa.Background.change(Lampa.Utils.cardImgBackground(data));
                        showReason(data);
                    }
                });
            }
        });

        return comp;
    }

    var reasonTimer = null;

    // The model's one-line reason for the focused card, as a short toast (debounced: scrolling past shows nothing).
    function showReason(card) {
        clearTimeout(reasonTimer);
        if (!card || !card.ai_reason) return;
        reasonTimer = setTimeout(function () {
            Lampa.Noty.show(card.ai_reason, {time: 5000});
        }, 700);
    }

    function openList(force) {
        Lampa.Activity.push({
            url: '',
            title: Lampa.Lang.translate('ai_recs_title'),
            component: COMPONENT,
            page: 1,
            force: !!force
        });
    }

    function addTexts() {
        Lampa.Lang.add({
            ai_recs_title: {en: 'AI recommendations', ru: 'AI рекомендации', uk: 'AI рекомендації'},
            ai_recs_descr: {
                en: 'Titles picked for you from your lists by a language model',
                ru: 'Фильмы и сериалы, подобранные языковой моделью по вашим спискам',
                uk: 'Фільми та серіали, підібрані мовною моделлю за вашими списками'
            },
            ai_recs_open: {en: 'Show recommendations', ru: 'Показать рекомендации', uk: 'Показати рекомендації'},
            ai_recs_refresh: {en: 'Get new recommendations', ru: 'Подобрать заново', uk: 'Підібрати заново'},
            ai_recs_refresh_descr: {
                en: 'Asks the model again instead of using the saved result (12 hours)',
                ru: 'Снова спрашивает модель вместо сохранённого результата (12 часов)',
                uk: 'Знову питає модель замість збереженого результату (12 годин)'
            },
            ai_recs_provider: {en: 'Provider', ru: 'Провайдер', uk: 'Провайдер'},
            ai_recs_provider_anthropic: {en: 'Claude (Anthropic)', ru: 'Claude (Anthropic)', uk: 'Claude (Anthropic)'},
            ai_recs_provider_openai: {en: 'OpenAI-compatible', ru: 'OpenAI-совместимый', uk: 'OpenAI-сумісний'},
            ai_recs_key: {en: 'API key', ru: 'API-ключ', uk: 'API-ключ'},
            ai_recs_key_descr: {
                en: 'Stays on this device and is sent only to the address below. Use a key with a spending limit',
                ru: 'Хранится на этом устройстве и отправляется только на адрес ниже. Лучше ключ с лимитом расходов',
                uk: 'Зберігається на цьому пристрої й надсилається лише на адресу нижче. Краще ключ з лімітом витрат'
            },
            ai_recs_base: {en: 'Address (optional)', ru: 'Адрес (необязательно)', uk: 'Адреса (необов’язково)'},
            ai_recs_base_descr: {
                en: 'Empty: the provider\'s own address. Set it for a proxy, OpenRouter or a local server',
                ru: 'Пусто: адрес провайдера. Укажите для прокси, OpenRouter или локального сервера',
                uk: 'Порожньо: адреса провайдера. Вкажіть для проксі, OpenRouter або локального сервера'
            },
            ai_recs_model: {en: 'Model', ru: 'Модель', uk: 'Модель'},
            ai_recs_model_descr: {
                en: 'Empty: claude-haiku-5-5 for Claude. Required for OpenAI-compatible providers',
                ru: 'Пусто: claude-haiku-5-5 для Claude. Обязательна для OpenAI-совместимых',
                uk: 'Порожньо: claude-haiku-5-5 для Claude. Обов’язкова для OpenAI-сумісних'
            },
            ai_recs_count: {en: 'How many titles', ru: 'Сколько вариантов', uk: 'Скільки варіантів'},
            ai_recs_recent: {en: 'Recently watched to use', ru: 'Сколько последних просмотров учитывать', uk: 'Скільки останніх переглядів враховувати'},
            ai_recs_recent_descr: {
                en: 'The newest titles from your history that are sent to the model. Fewer is cheaper and more current',
                ru: 'Столько последних фильмов из истории уходит модели. Меньше: дешевле и актуальнее',
                uk: 'Стільки останніх фільмів з історії йде моделі. Менше: дешевше й актуальніше'
            },
            ai_recs_wishes: {en: 'Wishes', ru: 'Пожелания', uk: 'Побажання'},
            ai_recs_wishes_descr: {
                en: 'Optional, for example: something light for the evening, no horror',
                ru: 'Необязательно, например: что-нибудь лёгкое на вечер, без ужасов',
                uk: 'Необов’язково, наприклад: щось легке на вечір, без жахів'
            },
            ai_recs_err_nokey: {en: 'Add your API key in Settings → AI recommendations', ru: 'Добавьте API-ключ в Настройки → AI рекомендации', uk: 'Додайте API-ключ у Налаштування → AI рекомендації'},
            ai_recs_err_nomodel: {en: 'Set the model name in the settings', ru: 'Укажите название модели в настройках', uk: 'Вкажіть назву моделі в налаштуваннях'},
            ai_recs_err_empty: {
                en: 'Your lists are empty: watch something or add titles to Bookmarks first',
                ru: 'Ваши списки пусты: посмотрите что-нибудь или добавьте фильмы в закладки',
                uk: 'Ваші списки порожні: подивіться щось або додайте фільми до закладок'
            },
            ai_recs_err_network: {
                en: 'No connection to the provider. Check the address, the network or your VPN',
                ru: 'Нет связи с провайдером. Проверьте адрес, сеть или VPN',
                uk: 'Немає зв’язку з провайдером. Перевірте адресу, мережу або VPN'
            },
            ai_recs_err_key: {en: 'The provider rejected the API key', ru: 'Провайдер не принял API-ключ', uk: 'Провайдер не прийняв API-ключ'},
            ai_recs_err_forbidden: {
                en: 'Access denied: the key has no access to this model, or the provider is not available from your location',
                ru: 'Доступ запрещён: у ключа нет доступа к модели или провайдер недоступен из вашего региона',
                uk: 'Доступ заборонено: у ключа немає доступу до моделі або провайдер недоступний з вашого регіону'
            },
            ai_recs_err_limit: {en: 'Rate limit or spending limit reached', ru: 'Достигнут лимит запросов или расходов', uk: 'Досягнуто ліміт запитів або витрат'},
            ai_recs_err_refused: {en: 'The model declined to answer', ru: 'Модель отказалась отвечать', uk: 'Модель відмовилась відповідати'},
            ai_recs_err_reply: {en: 'The model\'s answer could not be read', ru: 'Не удалось разобрать ответ модели', uk: 'Не вдалося розібрати відповідь моделі'},
            ai_recs_err_none: {
                en: 'None of the suggestions were new to you or found on TMDB. Try again',
                ru: 'Ни один из вариантов не оказался новым или не найден в TMDB. Попробуйте ещё раз',
                uk: 'Жоден із варіантів не виявився новим або не знайдений у TMDB. Спробуйте ще раз'
            }
        });
    }

    function addSettings() {
        var icon = '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>';

        Lampa.SettingsApi.addComponent({
            component: 'ai_recs',
            name: Lampa.Lang.translate('ai_recs_title'),
            icon: icon
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: 'ai_recs_open', type: 'static'},
            field: {name: Lampa.Lang.translate('ai_recs_open'), description: Lampa.Lang.translate('ai_recs_descr')},
            onRender: function (item) {
                item.on('hover:enter', function () {
                    openList(false);
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: 'ai_recs_refresh', type: 'static'},
            field: {name: Lampa.Lang.translate('ai_recs_refresh'), description: Lampa.Lang.translate('ai_recs_refresh_descr')},
            onRender: function (item) {
                item.on('hover:enter', function () {
                    openList(true);
                });
            }
        });

        var providers = {};
        providers.anthropic = Lampa.Lang.translate('ai_recs_provider_anthropic');
        providers.openai = Lampa.Lang.translate('ai_recs_provider_openai');

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.provider, type: 'select', values: providers, default: 'anthropic'},
            field: {name: Lampa.Lang.translate('ai_recs_provider')}
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.key, type: 'input', placeholder: 'sk-...', values: '', default: ''},
            field: {name: Lampa.Lang.translate('ai_recs_key'), description: Lampa.Lang.translate('ai_recs_key_descr')}
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.base, type: 'input', placeholder: DEFAULTS.anthropic.base, values: '', default: ''},
            field: {name: Lampa.Lang.translate('ai_recs_base'), description: Lampa.Lang.translate('ai_recs_base_descr')}
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.model, type: 'input', placeholder: DEFAULTS.anthropic.model, values: '', default: ''},
            field: {name: Lampa.Lang.translate('ai_recs_model'), description: Lampa.Lang.translate('ai_recs_model_descr')}
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.count, type: 'select', values: {'10': '10', '15': '15', '20': '20', '30': '30'}, default: '15'},
            field: {name: Lampa.Lang.translate('ai_recs_count')}
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.recent, type: 'select', values: {'10': '10', '20': '20', '30': '30', '50': '50', '100': '100'}, default: '30'},
            field: {name: Lampa.Lang.translate('ai_recs_recent'), description: Lampa.Lang.translate('ai_recs_recent_descr')}
        });

        Lampa.SettingsApi.addParam({
            component: 'ai_recs',
            param: {name: KEY.wishes, type: 'input', placeholder: '', values: '', default: ''},
            field: {name: Lampa.Lang.translate('ai_recs_wishes'), description: Lampa.Lang.translate('ai_recs_wishes_descr')}
        });
    }

    function addMenuItem() {
        var button = $('<li class="menu__item selector"><div class="menu__ico">'
            + '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>'
            + '</div><div class="menu__text">' + Lampa.Lang.translate('ai_recs_title') + '</div></li>');

        button.on('hover:enter', function () {
            openList(false);
        });
        $('.menu .menu__list').eq(0).append(button);
    }

    function start() {
        if (window.ai_recommendations_plugin) return;
        window.ai_recommendations_plugin = true;

        addTexts();
        Lampa.Component.add(COMPONENT, AiRecsComponent);
        addSettings();
        addMenuItem();
    }

    if (window.appready) {
        start();
    } else {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') start();
        });
    }
})();
