'use strict';

var winston = require('winston'),
	async = require('async');

module.exports = function(Plugins) {

	/*
		`data` is an object consisting of (* is required):
			`data.hook`*, the name of the NodeBB hook
			`data.method`*, the method called in that plugin
			`data.priority`, the relative priority of the method when it is eventually called (default: 10)
	*/
	Plugins.registerHook = function(id, data, callback) {
		function register() {
			Plugins.loadedHooks[data.hook] = Plugins.loadedHooks[data.hook] || [];
			Plugins.loadedHooks[data.hook].push(data);

			if (typeof callback === 'function') {
				callback();
			}
		}

		var method;

		if (data.hook && data.method) {
			data.id = id;
			if (!data.priority) {
				data.priority = 10;
			}

			if (typeof data.method === 'string' && data.method.length > 0) {
				method = data.method.split('.').reduce(function(memo, prop) {
					if (memo && memo[prop]) {
						return memo[prop];
					} else {
						// Couldn't find method by path, aborting
						return null;
					}
				}, Plugins.libraries[data.id]);

				// Write the actual method reference to the hookObj
				data.method = method;

				register();
			} else if (typeof data.method === 'function') {
				register();
			} else {
				winston.warn('[plugins/' + id + '] Hook method mismatch: ' + data.hook + ' => ' + data.method);
			}
		}
	};

	Plugins.fireHook = function(hook, params, callback) {
		callback = typeof callback === 'function' ? callback : function() {};

		var hookList = Plugins.loadedHooks[hook];

		if (!Array.isArray(hookList) || !hookList.length) {
			return callback(null, params);
		}

		var hookType = hook.split(':')[0];
		switch (hookType) {
			case 'filter':
				fireFilterHook(hook, hookList, params, callback);
				break;
			case 'action':
				fireActionHook(hook, hookList, params, callback);
				break;
			case 'static':
				fireStaticHook(hook, hookList, params, callback);
				break;
			default:
				winston.warn('[plugins] Unknown hookType: ' + hookType + ', hook : ' + hook);
				break;
		}
	};

	function fireFilterHook(hook, hookList, params, callback) {
		async.reduce(hookList, params, function(params, hookObj, next) {
			if (typeof hookObj.method !== 'function') {
				if (global.env === 'development') {
					winston.warn('[plugins] Expected method for hook \'' + hook + '\' in plugin \'' + hookObj.id + '\' not found, skipping.');
				}
				return next(null, params);
			}

			hookObj.method(params, next);

		}, function(err, values) {
			if (err) {
				winston.error('[plugins] ' + hook + ',  ' + err.message);
			}

			callback(err, values);
		});
	}

	function fireActionHook(hook, hookList, params, callback) {
		async.each(hookList, function(hookObj, next) {

			if (typeof hookObj.method !== 'function') {
				if (global.env === 'development') {
					winston.warn('[plugins] Expected method for hook \'' + hook + '\' in plugin \'' + hookObj.id + '\' not found, skipping.');
				}
				return next();
			}

			hookObj.method(params);
			next();
		}, callback);
	}

	function fireStaticHook(hook, hookList, params, callback) {
		async.each(hookList, function(hookObj, next) {
			if (typeof hookObj.method === 'function') {
				var timedOut = false;

				var timeoutId = setTimeout(function() {
					winston.warn('[plugins] Callback timed out, hook \'' + hook + '\' in plugin \'' + hookObj.id + '\'');
					timedOut = true;
					next();
				}, 5000);

				hookObj.method(params, function() {
					clearTimeout(timeoutId);
					if (!timedOut) {
						next.apply(null, arguments);
					}
				});
			} else {
				next();
			}
		}, callback);
	}

	Plugins.hasListeners = function(hook) {
		return !!(Plugins.loadedHooks[hook] && Plugins.loadedHooks[hook].length > 0);
	};
};