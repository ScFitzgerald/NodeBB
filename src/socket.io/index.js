"use strict";

var	SocketIO = require('socket.io'),
	socketioWildcard = require('socketio-wildcard')(),
	util = require('util'),
	async = require('async'),
	path = require('path'),
	fs = require('fs'),
	nconf = require('nconf'),
	cookieParser = require('cookie-parser')(nconf.get('secret')),
	winston = require('winston'),

	db = require('../database'),
	user = require('../user'),
	topics = require('../topics'),
	logger = require('../logger'),
	ratelimit = require('../middleware/ratelimit'),

	Sockets = {},
	Namespaces = {};

var io;

Sockets.init = function(server) {
	requireModules();

	var config = {
		log: true,
		'log level': process.env.NODE_ENV === 'development' ? 2 : 0,
		transports: ['websocket', 'xhr-polling', 'jsonp-polling', 'flashsocket'],
		'browser client minification': true,
		resource: nconf.get('relative_path') + '/socket.io'
	};

	addRedisAdapter(config);

	io = socketioWildcard(SocketIO).listen(server, config);

	io.on('connection', onConnection);

	Sockets.server = io;
};

function onConnection(socket) {
	socket.ip = socket.request.connection.remoteAddress;

	logger.io_one(socket, socket.uid);

	authorize(socket, function(err) {
		if (err) {
			return winston.error(err.stack);
		}

		onConnect(socket);
	});

	socket.on('disconnect', function() {
		onDisconnect(socket);
	});

	socket.on('*', function(payload) {
		onMessage(socket, payload);
	});
}

function onConnect(socket) {
	if (socket.uid) {
		socket.join('uid_' + socket.uid);
		socket.join('online_users');

		async.parallel({
			user: function(next) {
				user.getUserFields(socket.uid, ['username', 'userslug', 'picture', 'status', 'email:confirmed'], next);
			},
			isAdmin: function(next) {
				user.isAdministrator(socket.uid, next);
			}
		}, function(err, userData) {
			if (err || !userData.user) {
				return;
			}
			userData.user.uid = socket.uid;
			userData.user.isAdmin = userData.isAdmin;
			userData.user['email:confirmed'] = parseInt(userData.user['email:confirmed'], 10) === 1;
			socket.emit('event:connect', userData.user);

			socket.broadcast.emit('event:user_status_change', {uid: socket.uid, status: userData.user.status});
		});
	} else {
		socket.join('online_guests');
		socket.emit('event:connect', {
			username: '[[global:guest]]',
			isAdmin: false,
			uid: 0
		});
	}
}

function onDisconnect(socket) {
	if (socket.uid) {
		var socketCount = Sockets.getUserSocketCount(socket.uid);
		if (socketCount <= 0) {
			socket.broadcast.emit('event:user_status_change', {uid: socket.uid, status: 'offline'});
		}

		// TODO: if we can get socket.rooms here this can be made more efficient,
		// see https://github.com/Automattic/socket.io/issues/1897
		io.sockets.in('online_users').emit('event:user_leave', socket.uid);
	}
}

function onMessage(socket, payload) {
	if (!payload.data.length) {
		return winston.warn('[socket.io] Empty payload');
	}

	var eventName = payload.name;
	var params = payload.args.length ? payload.args[0] : null;
	var callback = typeof payload.data[payload.data.length - 1] === 'function' ? payload.data[payload.data.length - 1] : function() {};

	if (!eventName) {
		return winston.warn('[socket.io] Empty method name');
	}

	if (ratelimit.isFlooding(socket)) {
		winston.warn('[socket.io] Too many emits! Disconnecting uid : ' + socket.uid + '. Message : ' + eventName);
		return socket.disconnect();
	}

	var parts = eventName.toString().split('.'),
		namespace = parts[0],
		methodToCall = parts.reduce(function(prev, cur) {
			if (prev !== null && prev[cur]) {
				return prev[cur];
			} else {
				return null;
			}
		}, Namespaces);

	if(!methodToCall) {
		if (process.env.NODE_ENV === 'development') {
			winston.warn('[socket.io] Unrecognized message: ' + eventName);
		}
		return;
	}

	if (Namespaces[namespace].before) {
		Namespaces[namespace].before(socket, eventName, function() {
			callMethod(methodToCall, socket, params, callback);
		});
	} else {
		callMethod(methodToCall, socket, params, callback);
	}
}

function requireModules() {
	fs.readdir(__dirname, function(err, files) {
		files.splice(files.indexOf('index.js'), 1);

		async.each(files, function(lib, next) {
			if (lib.substr(lib.length - 3) === '.js') {
				lib = lib.slice(0, -3);
				Namespaces[lib] = require('./' + lib);
			}

			next();
		});
	});
}

function authorize(socket, next) {
	var handshake = socket.handshake,
		sessionID;

	if (!handshake) {
		return next(new Error('[[error:not-authorized]]'));
	}

	cookieParser(handshake, {}, function(err) {
		if (err) {
			return next(err);
		}

		var sessionID = handshake.signedCookies['express.sid'];

		db.sessionStore.get(sessionID, function(err, sessionData) {
			if (err) {
				return next(err);
			}

			if (sessionData && sessionData.passport && sessionData.passport.user) {
				socket.uid = parseInt(sessionData.passport.user, 10);
			} else {
				socket.uid = 0;
			}
			next();
		});
	});
}

function addRedisAdapter(config) {
	// If a redis server is configured, use it as a socket.io store, otherwise, fall back to in-memory store
	if (nconf.get('redis')) {
		var RedisStore = require('socket.io/lib/stores/redis'),
			database = require('../database/redis'),
			pub = database.connect(),
			sub = database.connect(),
			client = database.connect();

		// "redis" property needs to be passed in as referenced here: https://github.com/Automattic/socket.io/issues/808
		// Probably fixed in socket.IO 1.0
		config.store = new RedisStore({
			redis: require('redis'),
			redisPub : pub,
			redisSub : sub,
			redisClient : client
		});
	} else if (nconf.get('cluster')) {
		winston.warn('[socket.io] Clustering detected, you are advised to configure Redis as a websocket store.');
	}
}

function callMethod(method, socket, params, callback) {
	method.call(null, socket, params, function(err, result) {
		callback(err ? {message: err.message} : null, result);
	});
}

Sockets.logoutUser = function(uid) {
	io.sockets.in('uid_' + uid).emit('event:disconnect');
};

Sockets.in = function(room) {
	return io.sockets.in(room);
};

Sockets.getSocketCount = function() {
	// TODO: io.sockets.adapter.sids is local to this worker
	// use redis-adapter

	var clients = Object.keys(io.sockets.adapter.sids || {});
	return Array.isArray(clients) ? clients.length : 0;
};

Sockets.getUserSocketCount = function(uid) {
	// TODO: io.sockets.adapter.rooms is local to this worker
	// use .clients('uid_' + uid, fn)

	var roomClients = Object.keys(io.sockets.adapter.rooms['uid_' + uid] || {});
	return Array.isArray(roomClients) ? roomClients.length : 0;
};

Sockets.getOnlineAnonCount = function () {
	// TODO: io.sockets.adapter.rooms is local to this worker
	// use .clients()

	var guestSocketIds = Object.keys(io.sockets.adapter.rooms.online_guests || {});
	return Array.isArray(guestSocketIds) ? guestSocketIds.length : 0;
};

Sockets.reqFromSocket = function(socket) {
	var headers = socket.request.headers,
		host = headers.host,
		referer = headers.referer || '';

	return {
		ip: headers['x-forwarded-for'] || socket.ip,
		host: host,
		protocol: socket.request.connection.encrypted ? 'https' : 'http',
		secure: !!socket.request.connection.encrypted,
		url: referer,
		path: referer.substr(referer.indexOf(host) + host.length),
		headers: headers
	};
};

Sockets.isUserOnline = function(uid) {
	// TODO: io.sockets.adapter.rooms is local to this worker
	// use .clients('uid_' + uid, fn)
	return io ? !!io.sockets.adapter.rooms['uid_' + uid] : false;
};

Sockets.isUsersOnline = function(uids, callback) {
	callback(null, uids.map(Sockets.isUserOnline));
};

Sockets.getUsersInRoom = function (uid, roomName, callback) {
	if (!roomName) {
		return;
	}

	var	uids = Sockets.getUidsInRoom(roomName);
	var total = uids.length;
	uids = uids.slice(0, 9);
	if (uid) {
		uids = [uid].concat(uids);
	}
	if (!uids.length) {
		return callback(null, {users: [], total: 0 , room: roomName});
	}
	user.getMultipleUserFields(uids, ['uid', 'username', 'userslug', 'picture', 'status'], function(err, users) {
		if (err) {
			return callback(err);
		}

		users = users.filter(function(user) {
			return user && user.status !== 'offline';
		});

		callback(null, {
			users: users,
			room: roomName,
			total: Math.max(0, total - uids.length)
		});
	});
};

Sockets.getUidsInRoom = function(roomName) {
	// TODO : doesnt work in cluster

	var uids = [];

	var socketids = Object.keys(io.sockets.adapter.rooms[roomName] || {});
	if (!Array.isArray(socketids) || !socketids.length) {
		return [];
	}

	for(var i=0; i<socketids.length; ++i) {
		var socketRooms = Object.keys(io.sockets.adapter.sids[socketids[i]]);
		if (Array.isArray(socketRooms)) {
			socketRooms.forEach(function(roomName) {
				if (roomName.indexOf('uid_') === 0 ) {
					uids.push(roomName.split('_')[1]);
				}
			});
		}
	}

	return uids;
};


/* Exporting */
module.exports = Sockets;
