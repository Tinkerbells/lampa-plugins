// A recording stand-in for Lampa, enough to run a plugin in Node and assert on what it does.
// Usage: var env = require('./lampa-fake.js').install({ favorite: {...}, storage: {...} });
//        eval(fs.readFileSync('my-plugin.js', 'utf8'));
//        env.fire('storage', {name: 'favorite'});  env.requests, env.settings, env.noty ...
// Extend it with the pieces your plugin touches; keep it small and honest (it checks nothing about the real API).

exports.install = function (options) {
    options = options || {};
    var env = {
        requests: [],      // {method, url, contentType, body}
        settings: [],      // names of SettingsApi params
        settingComponents: [], // names of SettingsApi components
        noty: [],          // Noty.show texts
        listeners: {},     // 'storage' | 'favorite' | 'app' | 'document:<event>' -> handler
        failNext: 0,       // make the next N XHRs fail
        storage: options.storage || {},
        favorite: options.favorite || {card: []},
        timers: [],
        respond: null,     // function (request) -> {status, text}
        tmdb: null,        // function (url) -> parsed JSON for Lampa.Reguest().silent
        pushed: [],        // Activity.push params
        components: [],
        routed: []
    };

    function sub(name) {
        return {follow: function (event, fn) { env.listeners[name] = fn; }, remove: function () {}};
    }

    global.window = {appready: options.appready !== false};
    global.document = {
        hidden: false,
        addEventListener: function (event, fn) { env.listeners['document:' + event] = fn; }
    };

    global.XMLHttpRequest = function () {
        var self = this;
        this.open = function (method, url) { self.method = method; self.url = url; };
        this.headers = {};
        this.setRequestHeader = function (name, value) {
            self.headers[name] = value;
            if (/content-type/i.test(name)) self.contentType = value;
        };
        this.send = function (body) {
            if (env.failNext > 0) {
                env.failNext--;
                return setTimeout(function () { self.onerror(); }, 1);
            }
            var request = {method: self.method, url: self.url, contentType: self.contentType, headers: self.headers, body: body};
            env.requests.push(request);
            // env.respond(request) -> {status, text}; the default is an empty 200.
            var reply = env.respond ? env.respond(request) : {status: 200, text: ''};
            self.status = reply.status;
            self.responseText = reply.text;
            setTimeout(function () { self.onload(); }, 1);
        };
    };

    global.Lampa = {
        Storage: {
            get: function (key, fallback) {
                if (key === 'favorite') return env.favorite;
                return key in env.storage ? env.storage[key] : fallback;
            },
            set: function (key, value) { env.storage[key] = value; },
            field: function (key) { return env.storage[key]; },
            listener: sub('storage')
        },
        Favorite: {
            get: function (query) {
                var ids = env.favorite[query.type] || [];
                return ids.map(function (id) {
                    return env.favorite.card.filter(function (card) { return card.id === id; })[0];
                });
            },
            all: function () { return env.favorite; },
            listener: sub('favorite')
        },
        Lang: {add: function () {}, translate: function (key) { return key; }},
        SettingsApi: {
            addComponent: function (c) { env.settingComponents.push(c.component); },
            addParam: function (p) { env.settings.push(p.param.name); }
        },
        Noty: {show: function (text) { env.noty.push(text); }},
        Listener: sub('app'),
        TMDB: {api: function (path) { return 'https://tmdb.test/3/' + path; }, key: function () { return 'k'; }},
        Reguest: function () {
            this.silent = function (url, ok, fail) {
                if (!env.tmdb) return fail();
                var json = env.tmdb(url);
                json ? setTimeout(function () { ok(json); }, 1) : setTimeout(fail, 1);
            };
            this.clear = function () {};
        },
        Component: {add: function (name, fn) { env.components.push({name: name, fn: fn}); }},
        Activity: {push: function (params) { env.pushed.push(params); }},
        Router: {call: function (name, data) { env.routed.push({name: name, data: data}); }},
        Manifest: {app_digital: 328}
    };

    env.fire = function (name, event) {
        if (!env.listeners[name]) throw new Error('nothing subscribed to ' + name);
        env.listeners[name](event);
    };
    return env;
};
