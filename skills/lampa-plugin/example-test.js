// Example: drives free-my-tv.js with the fake Lampa. Run from the repo root: node skills/lampa-plugin/example-test.js
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var env = require('./lampa-fake.js').install({
    favorite: {
        card: [
            {id: 1514026, title: 'Buddy', original_title: 'Buddy', release_date: '2026-08-27', poster_path: '/p.jpg', vote_average: 7.1},
            {id: 4607, name: 'Lost', original_name: 'Lost', first_air_date: '2004-09-22', poster_path: '/l.jpg'}
        ],
        wath: [1514026],
        history: [4607, 1514026]
    }
});

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

eval(fs.readFileSync(path.join(__dirname, '..', '..', 'free-my-tv.js'), 'utf8'));

(async function () {
    await sleep(1900);   // the plugin waits 1.5 s after start
    assert.strictEqual(env.requests.length, 1, 'one send after start');
    var body = JSON.parse(env.requests[0].body);
    assert.deepStrictEqual(body.lists.wath, ['movie:1514026']);
    assert.deepStrictEqual(body.lists.history, ['tv:4607', 'movie:1514026']);
    assert.strictEqual(body.cards['tv:4607'].type, 'tv');
    assert.strictEqual(env.requests[0].contentType, 'text/plain;charset=UTF-8');
    assert.deepStrictEqual(env.settings, ['free_my_tv_send', 'free_my_tv_host']);

    env.fire('storage', {name: 'favorite'});
    env.fire('storage', {name: 'favorite'});   // two quick changes: one send
    env.fire('storage', {name: 'other'});      // unrelated key: ignored
    await sleep(1900);
    assert.strictEqual(env.requests.length, 2, 'changes are debounced into one send');

    env.failNext = 1;                          // receiver down: retried after 5 s
    env.fire('storage', {name: 'favorite'});
    await sleep(1900);
    assert.strictEqual(env.requests.length, 2, 'the failed send is not recorded');
    await sleep(5200);
    assert.strictEqual(env.requests.length, 3, 'retried after the failure');

    console.log('ok');
    process.exit(0);
})().catch(function (e) { console.error(e); process.exit(1); });
