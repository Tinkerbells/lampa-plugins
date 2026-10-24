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
            /(?:сезон|season)\s*[:№#]?\s*(\d{1,2})(?!\d)/g,
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

    // Lampa itself remembers every release you opened (`torrents_view`, shown as `element.viewed` in the results).
    // On top of that the plugin keeps the last release it saw you open for each series.
    var LAST_KEY = 'season_jump_last';

    function lastOpened(movie) {
        var all = Lampa.Storage.get(LAST_KEY, '{}') || {};
        return (movie && all[movie.id]) || null;
    }

    function rememberOpened(movie, element) {
        if (!movie || !element || !element.hash) return;

        var all = Lampa.Storage.get(LAST_KEY, '{}') || {};
        all[movie.id] = {hash: element.hash, title: String(element.Title || '').substring(0, 160)};
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

    // The plaque is rebuilt with the list (filter, sort), so it is bound again on every row render.
    function bindPlaque() {
        var plaque = $('.watched-history');
        if (!plaque.length) return;

        var season = last ? watchedSeason(last.movie) : 0;

        plaque.off('hover:enter.season_jump');
        plaque.find('.season-jump-hint').remove();
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
            + '</style>');
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
    }

    if (window.appready) {
        start();
    } else {
        Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') start();
        });
    }
})();
