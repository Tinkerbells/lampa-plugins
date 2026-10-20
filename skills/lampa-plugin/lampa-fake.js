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
        components: [],    // names of SettingsApi components
        noty: [],          // Noty.show texts
        listeners: {},     // 'storage' | 'favorite' | 'app' | 'document:<event>' -> handler
        failNext: 0,       // make the next N XHRs fail
        storage: options.storage || {},
        favorite: options.favorite || {card: []},
        timers: []
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
        this.setRequestHeader = function (name, value) { if (/content-type/i.test(name)) self.contentType = value; };
        this.send = function (body) {
            if (env.failNext > 0) {
                env.failNext--;
                return setTimeout(function () { self.onerror(); }, 1);
            }
            env.requests.push({method: self.method, url: self.url, contentType: self.contentType, body: body});
            self.status = 200;
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
            addComponent: function (c) { env.components.push(c.component); },
            addParam: function (p) { env.settings.push(p.param.name); }
        },
        Noty: {show: function (text) { env.noty.push(text); }},
        Listener: sub('app'),
        Manifest: {app_digital: 328}
    };

    env.fire = function (name, event) {
        if (!env.listeners[name]) throw new Error('nothing subscribed to ' + name);
        env.listeners[name](event);
    };
    return env;
};
