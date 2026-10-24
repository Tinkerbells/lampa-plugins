(function () {
    'use strict';

    /*
     * Torrent season jump for Lampa.
     *
     * On a series' torrent list Lampa shows a plaque with the last thing you opened ("Torrent • Season 21 • Episode 3").
     * It is only a label: pressing OK on it does nothing, and finding that season means scrolling through every release
     * of the newer ones. This plugin makes the plaque a button. OK on it lists every release for that season, found by
     * its own reading of the release titles (single seasons, "1-25 seasons" packs, S21, 21x03 ...), and opens the one
     * you pick. The built-in "Season" filter reads titles more strictly and can miss them.
     *
     * Written in ES5 on purpose: old TV WebViews (webOS 3/4, Tizen 3) cannot run newer syntax.
     */

    var last = null;   // {movie, data}: the last torrent search, its results object is the one the list keeps up to date

    // ------------------------------------------------------------------------------------- season in a title

    // Seasons named in a release title: {single: [21], ranges: [[1, 25]]}.
    function seasonsIn(title) {
        var text = String(title || '').toLowerCase();
        var found = {single: [], ranges: []};
        var match;
        var from;
        var to;

        // "сезон: 1-12 серии" is an episode range, not seasons: the lookahead keeps it out.
        var notEpisodes = '(?!\\d)(?!\\s*(?:сери|эпиз|episod|из\\s|of\\s))';
        var rangePatterns = [
            new RegExp('(?:сезон[а-я]*|seasons?|сез\\.?)\\s*[:№#]?\\s*(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})' + notEpisodes, 'g'),
            /(?:^|[^\d])(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:-?(?:й|ой|х)\s*)?(?:сезон|seasons?|сез)/g,
            new RegExp('(?:^|[^a-z0-9])s(\\d{1,2})\\s*[-–—]\\s*s?(\\d{1,2})' + notEpisodes, 'g')
        ];
        var i;

        for (i = 0; i < rangePatterns.length; i++) {
            while ((match = rangePatterns[i].exec(text)) !== null) {
                from = parseInt(match[1], 10);
                to = parseInt(match[2], 10);
                if (from > 0 && to > from) found.ranges.push([from, to]);
                // the range is consumed: its end must not count as a single season
                text = text.substring(0, match.index) + ' ' + text.substring(match.index + match[0].length);
                rangePatterns[i].lastIndex = 0;
            }
        }

        var singlePatterns = [
            /(\d{1,2})\s*(?:-?(?:й|ой))?\s*(?:сезон|season|сез(?![а-я]))/g,
            // not followed by "-12": after "сезон:" that is an episode range ("21 сезон: 1-12 серии")
            /(?:сезон|season)\s*[:№#]?\s*(\d{1,2})(?!\d)(?!\s*[-–—]\s*\d)/g,
            /(?:^|[^a-z0-9])s(\d{1,2})(?:e\d|[^a-z0-9]|$)/g,
            /(?:^|[^\d])(\d{1,2})x\d{1,3}/g
        ];

        for (i = 0; i < singlePatterns.length; i++) {
            while ((match = singlePatterns[i].exec(text)) !== null) {
                var n = parseInt(match[1], 10);
                if (n > 0 && found.single.indexOf(n) === -1) found.single.push(n);
            }
        }
        return found;
    }

    // null: no match. Otherwise {pack: false} for the season itself, {pack: true, from, to} for a multi-season pack.
    function matchSeason(title, season) {
        var seasons = seasonsIn(title);
        var i;

        if (seasons.single.indexOf(season) >= 0) return {pack: false};
        for (i = 0; i < seasons.ranges.length; i++) {
            if (season >= seasons.ranges[i][0] && season <= seasons.ranges[i][1]) {
                return {pack: true, from: seasons.ranges[i][0], to: seasons.ranges[i][1]};
            }
        }
        return null;
    }

    // ----------------------------------------------------------------------------- what you opened before

    // Lampa itself remembers only a hash for every release you opened (`torrents_view`, shown as `element.viewed` in
    // the results), and a release's title changes when episodes are added, so the hash soon matches nothing. The plugin
    // keeps, for each series, the last few releases it saw you open together with what is needed to open them again
    // (magnet or link), so they can be offered even when today's search no longer lists them.
    var LAST_KEY = 'season_jump_last';
    var KEEP = 8;
    var SNAPSHOT = ['Title', 'MagnetUri', 'Link', 'Tracker', 'Size', 'size', 'Seeders', 'Peers', 'PublishDate', 'PublisTime', 'hash', 'Details', 'info'];

    // Newest first. The first version of the plugin kept one entry per series; it has no snapshot and is read as a list.
    function openedBefore(movie) {
        var all = Lampa.Storage.get(LAST_KEY, '{}') || {};
        var list = movie ? all[movie.id] : null;

        if (!list) return [];
        return typeof list.length === 'number' ? list : [list];
    }

    function lastOpened(movie) {
        return openedBefore(movie)[0] || null;
    }

    function rememberOpened(movie, element) {
        if (!movie || !element || !element.hash) return;

        var all = Lampa.Storage.get(LAST_KEY, '{}') || {};
        var list = openedBefore(movie).filter(function (entry) {
            return entry.hash !== element.hash;
        });
        var release = {};
        var i;

        for (i = 0; i < SNAPSHOT.length; i++) {
            if (element[SNAPSHOT[i]] !== undefined) release[SNAPSHOT[i]] = element[SNAPSHOT[i]];
        }

        list.unshift({hash: element.hash, title: String(element.Title || '').substring(0, 160), at: new Date().getTime(), release: release});
        all[movie.id] = list.slice(0, KEEP);
        Lampa.Storage.set(LAST_KEY, all);
    }

    // Same bookkeeping as the list's own "mark as viewed".
    function markViewed(element) {
        if (!element || !element.hash) return;

        var viewed = Lampa.Storage.cache('torrents_view', 5000, []);
        if (viewed.indexOf(element.hash) === -1) {
            viewed.push(element.hash);
            Lampa.Storage.set('torrents_view', viewed);
        }
        element.viewed = true;
    }

    // What you opened before first (the last one, then the others), then the season's own releases, then packs that
    // include it; most seeded first inside each group.
    function findReleases(results, season, movie) {
        var items = [];
        var last = lastOpened(movie);
        var i;

        for (i = 0; i < results.length; i++) {
            var hit = results[i] && matchSeason(results[i].Title, season);
            if (!hit) continue;
            items.push({
                element: results[i],
                hit: hit,
                last: !!(last && results[i].hash && results[i].hash === last.hash),
                viewed: !!results[i].viewed
            });
        }

        items.sort(function (a, b) {
            return (b.last - a.last)
                || (b.viewed - a.viewed)
                || (a.hit.pack - b.hit.pack)
                || ((b.element.Seeders || 0) - (a.element.Seeders || 0));
        });
        return items;
    }

    // ------------------------------------------------------------------------------------- what you watched last

    function watchedSeason(movie) {
        if (!movie || !movie.number_of_seasons) return 0;

        var name = movie.original_name || movie.original_title;
        if (!name || !Lampa.Utils || typeof Lampa.Utils.hash !== 'function') return 0;

        var watched = Lampa.Storage.get('online_watched_last', '{}') || {};
        var entry = watched[Lampa.Utils.hash(name)];
        var season = entry ? parseInt(entry.season, 10) : 0;

        return season > 0 ? season : 0;
    }

    // ------------------------------------------------------------------------------------------------- the UI

    function plain(text) {
        text = String(text || '');
        return Lampa.Utils && Lampa.Utils.clearHtmlTags ? Lampa.Utils.clearHtmlTags(text) : text.replace(/[<>&]/g, ' ');
    }

    function say(key, values) {
        var text = Lampa.Lang.translate(key);
        for (var name in values) if (values.hasOwnProperty(name)) text = text.split('{' + name + '}').join(values[name]);
        return text;
    }

    function subtitleOf(item) {
        var element = item.element;
        var parts = [];

        parts.push(item.hit.pack ? say('season_jump_pack', {from: item.hit.from, to: item.hit.to}) : Lampa.Lang.translate('season_jump_season'));
        if (item.last) parts.unshift('★ ' + Lampa.Lang.translate('season_jump_last'));
        else if (item.viewed) parts.unshift('✓ ' + Lampa.Lang.translate('season_jump_viewed'));
        if (element.Tracker) parts.push(plain(element.Tracker));
        if (element.size) parts.push(plain(element.size));
        parts.push('▲ ' + (element.Seeders || 0));
        return parts.join(' · ');
    }

    function openRelease(element, movie) {
        element.poster = movie.img;
        // The list sets its own "mark as viewed" callback on each open; a stale one would mark the wrong row.
        Lampa.Torrent.opened(function () {});
        markViewed(element);
        rememberOpened(movie, element);
        Lampa.Torrent.start(element, movie);
    }

    function jump() {
        var active = Lampa.Activity.active() || {};
        var movie = last && last.movie;

        if (!movie || (active.movie && active.movie.id !== movie.id)) {
            return Lampa.Noty.show(Lampa.Lang.translate('season_jump_reopen'));
        }

        var season = watchedSeason(movie);
        if (!season) return Lampa.Noty.show(Lampa.Lang.translate('season_jump_nosaved'));

        var items = findReleases(last.data.Results || [], season, movie);
        if (!items.length) return Lampa.Noty.show(say('season_jump_none', {season: season}));

        var controller = Lampa.Controller.enabled().name;

        Lampa.Select.show({
            title: say('season_jump_title', {season: season, count: items.length}),
            items: items.map(function (item, index) {
                return {title: plain(item.element.Title), subtitle: subtitleOf(item), release: item, selected: index === 0};
            }),
            onBack: function () {
                Lampa.Controller.toggle(controller);
            },
            onSelect: function (selected) {
                Lampa.Controller.toggle(controller);
                openRelease(selected.release.element, movie);
            }
        });
    }

    // A short label for a release's season: "S21", "S1-25", or empty when the title names none.
    function seasonTag(title) {
        var seasons = seasonsIn(title);

        if (seasons.single.length) return 'S' + seasons.single.join(',');
        if (seasons.ranges.length) return 'S' + seasons.ranges[0][0] + '-' + seasons.ranges[0][1];
        return '';
    }

    // What to show above the list: releases you opened before (the plugin's own record, newest first, then ones Lampa
    // knows as viewed in today's results), so a release is offered even if today's search no longer returns it.
    function watchedRows(movie) {
        var results = (last && last.data && last.data.Results) || [];
        var byHash = {};
        var seen = {};
        var rows = [];
        var i;

        for (i = 0; i < results.length; i++) if (results[i] && results[i].hash) byHash[results[i].hash] = results[i];

        var before = openedBefore(movie);
        for (i = 0; i < before.length; i++) {
            var element = byHash[before[i].hash] || before[i].release;
            if (!element || !element.Title) continue;
            seen[before[i].hash] = true;
            rows.push({element: element, last: rows.length === 0});
        }

        var viewed = results.filter(function (item) {
            return item && item.viewed && !seen[item.hash];
        }).sort(function (a, b) {
            return (b.Seeders || 0) - (a.Seeders || 0);
        });
        for (i = 0; i < viewed.length; i++) rows.push({element: viewed[i], last: false});

        return rows.slice(0, 6);
    }

    function renderWatched(plaque, movie) {
        $('.season-jump-watched').remove();

        var rows = watchedRows(movie);
        if (!rows.length) return;

        var block = $('<div class="season-jump-watched"><div class="season-jump-watched__title"></div></div>');
        var nodes = [];

        block.find('.season-jump-watched__title').text(Lampa.Lang.translate('season_jump_watched'));

        rows.forEach(function (row) {
            var element = row.element;
            var node = $('<div class="season-jump-row selector"><div class="season-jump-row__tag"></div>'
                + '<div class="season-jump-row__body"><div class="season-jump-row__title"></div><div class="season-jump-row__meta"></div></div></div>');
            var meta = [];

            if (row.last) meta.push('★ ' + Lampa.Lang.translate('season_jump_last'));
            if (element.Tracker) meta.push(plain(element.Tracker));
            if (element.size) meta.push(plain(element.size));

            node.find('.season-jump-row__tag').text(seasonTag(element.Title) || '▶');
            node.find('.season-jump-row__title').text(plain(element.Title));
            node.find('.season-jump-row__meta').text(meta.join(' · '));
            node.on('hover:enter', function () {
                openRelease(element, movie);
            });

            block.append(node);
            nodes.push(node[0]);
        });

        plaque.before(block);
        Lampa.Controller.collectionAppend($(nodes));
    }

    // History: a series you opened a release of goes straight to that release.
    function openFromHistory(card) {
        var active = Lampa.Activity.active() || {};

        if (active.component !== 'favorite' || active.type !== 'history') return false;
        if (String(Lampa.Storage.field('season_jump_history')) === 'false') return false;

        var entry = lastOpened(card);
        if (!entry || !entry.release || !entry.release.Title) return false;

        openRelease(entry.release, card);
        return true;
    }

    // The list is rebuilt on filter and sort, so this runs again each time.
    function bindPlaque() {
        var plaque = $('.watched-history');
        if (!plaque.length) return;

        var movie = last && last.movie;
        var season = movie ? watchedSeason(movie) : 0;

        plaque.off('hover:enter.season_jump');
        plaque.find('.season-jump-hint').remove();
        if (movie) renderWatched(plaque, movie);
        if (!season) return;

        plaque.on('hover:enter.season_jump', jump);
        plaque.append('<div class="season-jump-hint">' + say('season_jump_hint', {season: season}) + '</div>');
    }

    // ------------------------------------------------------------------------------------------- start

    function addTexts() {
        Lampa.Lang.add({
            season_jump_hint: {en: 'OK: releases of season {season}', ru: 'OK: раздачи {season} сезона', uk: 'OK: роздачі {season} сезону'},
            season_jump_title: {en: 'Season {season}: {count} found', ru: 'Сезон {season}: найдено {count}', uk: 'Сезон {season}: знайдено {count}'},
            season_jump_season: {en: 'Season', ru: 'Сезон', uk: 'Сезон'},
            season_jump_last: {en: 'Last opened', ru: 'Открывали последней', uk: 'Відкривали останньою'},
            season_jump_viewed: {en: 'Opened before', ru: 'Открывали раньше', uk: 'Відкривали раніше'},
            season_jump_pack: {en: 'Pack {from}-{to}', ru: 'Пак {from}-{to}', uk: 'Пак {from}-{to}'},
            season_jump_watched: {en: 'You watched', ru: 'Вы смотрели', uk: 'Ви дивилися'},
            season_jump_settings: {en: 'Torrents: seasons', ru: 'Торренты: сезоны', uk: 'Торенти: сезони'},
            season_jump_history: {
                en: 'History opens the release',
                ru: 'История открывает раздачу',
                uk: 'Історія відкриває роздачу'
            },
            season_jump_history_descr: {
                en: 'OK on a series in History opens the release you watched last, without the card. Off: always the card',
                ru: 'OK на сериале в Истории сразу открывает раздачу, которую вы смотрели, минуя карточку. Выключено: всегда карточка',
                uk: 'OK на серіалі в Історії одразу відкриває роздачу, яку ви дивилися, оминаючи картку. Вимкнено: завжди картка'
            },
            season_jump_none: {
                en: 'No releases of season {season} in these results',
                ru: 'Раздач {season} сезона в этих результатах нет',
                uk: 'Роздач {season} сезону в цих результатах немає'
            },
            season_jump_nosaved: {
                en: 'No season saved yet: open any episode first',
                ru: 'Сезон ещё не сохранён: сначала откройте любую серию',
                uk: 'Сезон ще не збережено: спочатку відкрийте будь-яку серію'
            },
            season_jump_reopen: {
                en: 'Open the torrent list again so the results can be read',
                ru: 'Откройте список торрентов заново, чтобы прочитать результаты',
                uk: 'Відкрийте список торентів заново, щоб прочитати результати'
            }
        });
    }

    function addStyles() {
        $('body').append('<style>'
            + '.watched-history{align-items:center}'
            + '.season-jump-hint{margin-left:auto;padding-left:1.5em;opacity:.6;white-space:nowrap;font-size:.9em}'
            + '.season-jump-watched{margin-bottom:1em}'
            + '.season-jump-watched__title{opacity:.6;font-size:.9em;margin:0 0 .5em .3em}'
            + '.season-jump-row{position:relative;display:flex;align-items:center;border-radius:.3em;background-color:rgba(0,0,0,.3);padding:.8em 1em;margin-bottom:.5em}'
            + '.season-jump-row__tag{flex-shrink:0;min-width:3.2em;margin-right:1em;padding:.3em .5em;border-radius:.3em;background:rgba(255,255,255,.12);text-align:center;font-weight:600}'
            + '.season-jump-row__body{min-width:0}'
            + '.season-jump-row__title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
            + '.season-jump-row__meta{opacity:.6;font-size:.85em;margin-top:.2em}'
            + '.season-jump-row.focus::after{content:"";position:absolute;top:-.3em;left:-.3em;right:-.3em;bottom:-.3em;border:.3em solid #fff;border-radius:.6em}'
            + '</style>');
    }

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'season_jump',
            name: Lampa.Lang.translate('season_jump_settings'),
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'season_jump',
            param: {name: 'season_jump_history', type: 'trigger', default: true},
            field: {
                name: Lampa.Lang.translate('season_jump_history'),
                description: Lampa.Lang.translate('season_jump_history_descr')
            }
        });
    }

    function start() {
        if (window.torrent_season_jump_plugin) return;
        window.torrent_season_jump_plugin = true;

        addTexts();
        addStyles();

        // Keeps the results object of each torrent search: the list sorts and trims it in place, so it stays complete.
        var originalGet = Lampa.Parser.get;
        Lampa.Parser.get = function (params, oncomplite, onerror) {
            return originalGet.call(Lampa.Parser, params, function (data) {
                if (data && data.Results && params && params.movie) last = {movie: params.movie, data: data};
                oncomplite(data);
            }, onerror);
        };

        // The list sends "render" for each row before it attaches itself to the page, so the plaque is bound a moment
        // later, once for the whole batch.
        var binding = null;
        Lampa.Listener.follow('torrent', function (event) {
            // A release opened from the normal list is remembered too, so the plaque jumps back to it next time.
            if (event.type === 'onenter' && last) rememberOpened(last.movie, event.element);
            if (event.type !== 'render') return;
            clearTimeout(binding);
            binding = setTimeout(bindPlaque, 50);
        });

        // History list: OK on a series you watched through a release opens that release straight away, without the card.
        var originalCall = Lampa.Router.call;
        Lampa.Router.call = function (name, data) {
            if (name === 'full' && data && openFromHistory(data)) return;
            return originalCall.apply(Lampa.Router, arguments);
        };

        addSettings();
    }

    if (window.appready) {
        start();
    } else {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') start();
        });
    }
})();
