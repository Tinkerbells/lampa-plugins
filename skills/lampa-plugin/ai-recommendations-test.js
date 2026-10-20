// Drives ai-recommendations.js with the fake Lampa and fake providers. Run from the repo root:
//   node skills/lampa-plugin/ai-recommendations-test.js
var fs = require('fs');
var path = require('path');
var assert = require('assert');

function movie(id, title, year) {
    return {id: id, title: title, original_title: title, release_date: year + '-01-01', poster_path: '/p' + id + '.jpg'};
}

// 60 watched movies, newest first (Lampa inserts new history at the front).
var history = [];
var cards = [];
for (var i = 1; i <= 60; i++) {
    cards.push(movie(i, 'Watched ' + i, 2000 + (i % 20)));
    history.push(i);
}
cards.push(movie(900, 'Queued One', 2020), movie(901, 'Dropped One', 2019));
cards.push({id: 700, name: 'Liked Show', original_name: 'Liked Show', first_air_date: '2015-05-05'});

var env = require('./lampa-fake.js').install({
    storage: {ai_recs_key: 'sk-test', language: 'ru'},
    favorite: {card: cards, history: history, wath: [900], thrown: [901], like: [700]}
});
global.$ = function () { return {on: function () {}, append: function () {}, eq: function () { return {append: function () {}}; }}; };
global.$.fn = {};

eval(fs.readFileSync(path.join(__dirname, '..', '..', 'ai-recommendations.js'), 'utf8'));

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function modelReply(items) {
    return {status: 200, text: JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({recommendations: items})}]})};
}

(async function () {
    // The Maker stand-in records the callbacks and lets the test run onCreate.
    var used = null;
    global.Lampa.Maker = {
        make: function (name, object, create) {
            var module = {MASK: {base: 1}, toggle: function () { return 'mod'; }};
            create(module);
            var comp = {
                activity: {loader: function () {}},
                built: null,
                emptied: false,
                use: function (handlers) { used = handlers; },
                build: function (data) { comp.built = data; },
                empty: function () { comp.emptied = true; }
            };
            return comp;
        }
    };
    global.Lampa.Background = {change: function () {}};
    global.Lampa.Utils = {cardImgBackground: function () { return ''; }};

    function open(force) {
        var comp = env.components[0].fn({force: force});
        used.onCreate.call(comp);
        return comp;
    }

    await sleep(20);

    // ---- Claude: request shape, recent list length, and what is excluded
    var sent;
    env.respond = function (request) {
        sent = request;
        return modelReply([
            {type: 'movie', title: 'Новый фильм', original_title: 'Fresh Movie', year: 2021, reason: 'Потому что вам нравится Watched 1'},
            {type: 'movie', title: 'Уже в очереди', original_title: 'Queued One', year: 2020, reason: 'x'},
            {type: 'tv', title: 'Сериал', original_title: 'Fresh Show', year: 2018, reason: 'Серьёзный сериал'},
            {type: 'movie', title: 'Нет в TMDB', original_title: 'Does Not Exist', year: 1999, reason: 'x'},
            {type: 'movie', title: 'Fresh Movie again', original_title: 'Fresh Movie', year: 2021, reason: 'dup'}
        ]);
    };
    env.tmdb = function (url) {
        var query = decodeURIComponent(/query=([^&]*)/.exec(url)[1]);
        var type = /search\/(movie|tv)/.exec(url)[1];
        if (query === 'Fresh Movie') return {results: [movie(5000, 'Fresh Movie', 2021)]};
        if (query === 'Queued One') return {results: [movie(900, 'Queued One', 2020)]};
        if (query === 'Fresh Show') return {results: [{id: 6000, name: 'Fresh Show', first_air_date: '2018-01-01'}]};
        return {results: []};
    };

    var comp = open(false);
    await sleep(80);

    assert.ok(sent, 'a request went out');
    assert.strictEqual(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(sent.headers['x-api-key'], 'sk-test');
    assert.strictEqual(sent.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(sent.headers['anthropic-dangerous-direct-browser-access'], 'true');
    var body = JSON.parse(sent.body);
    assert.strictEqual(body.model, 'claude-haiku-5-5');
    assert.strictEqual(body.output_config.format.type, 'json_schema');
    assert.strictEqual(body.output_config.format.schema.additionalProperties, false);
    var prompt = body.messages[0].content;
    assert.ok(prompt.indexOf('- Watched 1 (') >= 0 && prompt.indexOf('- Watched 30 (') >= 0, 'newest 30 are in the prompt');
    assert.ok(prompt.indexOf('- Watched 31 (') < 0, 'older ones are not (default 30)');
    assert.ok(prompt.indexOf('Watched 1 (') < prompt.indexOf('Watched 2 ('), 'newest first');
    assert.ok(prompt.indexOf('Queued One') >= 0 && prompt.indexOf('Dropped One') >= 0 && prompt.indexOf('Liked Show') >= 0);
    assert.ok(/Russian/.test(prompt), 'asks for the Lampa language');

    assert.ok(comp.built, 'the list was built');
    var titles = comp.built.results.map(function (c) { return c.title || c.name; });
    assert.deepStrictEqual(titles, ['Fresh Movie', 'Fresh Show'], 'queued, missing and duplicate titles are dropped');
    assert.strictEqual(comp.built.results[0].ai_reason, 'Потому что вам нравится Watched 1');
    assert.strictEqual(comp.built.results[1].name, 'Fresh Show');

    // ---- cache: opening again asks nothing
    var before = env.requests.length;
    var again = open(false);
    await sleep(30);
    assert.strictEqual(env.requests.length, before, 'served from the cache');
    assert.ok(again.built, 'built from the cache');
    open(true);
    await sleep(80);
    assert.strictEqual(env.requests.length, before + 1, 'force asks again');

    // ---- the setting changes how many recent titles go out
    env.storage.ai_recs_recent = '10';
    open(true);
    await sleep(80);
    var prompt10 = JSON.parse(sent.body).messages[0].content;
    assert.ok(prompt10.indexOf('- Watched 10 (') >= 0 && prompt10.indexOf('- Watched 11 (') < 0, 'recent=10 keeps ten');

    // ---- errors become a message, not a crash
    env.storage.ai_recs_cache = '';
    env.respond = function () { return {status: 401, text: JSON.stringify({error: {message: 'invalid x-api-key'}})}; };
    var bad = open(true);
    await sleep(60);
    assert.ok(bad.emptied, 'empty state on a bad key');
    assert.strictEqual(env.noty[env.noty.length - 1], 'ai_recs_err_key');

    // ---- OpenAI-compatible: bearer key, json mode, and a retry when the server does not know response_format
    env.storage.ai_recs_provider = 'openai';
    env.storage.ai_recs_model = 'my-model';
    env.storage.ai_recs_base = 'http://192.168.1.5:8080/v1/';
    var calls = [];
    env.respond = function (request) {
        calls.push(JSON.parse(request.body));
        if (calls.length === 1) return {status: 400, text: 'unknown field response_format'};
        return {status: 200, text: JSON.stringify({choices: [{message: {content: 'Here:\n```json\n' + JSON.stringify({recommendations: [{type: 'movie', title: 'Новый', original_title: 'Fresh Movie', year: 2021, reason: 'ok'}]}) + '\n```'}}]})};
    };
    var compat = open(true);
    await sleep(100);
    var last = env.requests[env.requests.length - 1];
    assert.strictEqual(last.url, 'http://192.168.1.5:8080/v1/chat/completions');
    assert.strictEqual(last.headers.Authorization, 'Bearer sk-test');
    assert.ok(calls[0].response_format && !calls[1].response_format, 'retried without response_format');
    assert.strictEqual(calls[1].model, 'my-model');
    assert.ok(compat.built && compat.built.results.length === 1, 'tolerant JSON parsing');

    // ---- no key, empty lists
    env.storage.ai_recs_provider = 'anthropic';
    env.storage.ai_recs_key = '';
    env.storage.ai_recs_base = '';
    var nokey = open(true);
    assert.ok(nokey.emptied && env.noty[env.noty.length - 1] === 'ai_recs_err_nokey');

    console.log('ok');
    process.exit(0);
})().catch(function (e) { console.error(e); process.exit(1); });
