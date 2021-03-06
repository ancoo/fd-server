/**
*@description 服务主线程入口
*@updateTime 2014-02-20/28 添加日志管理
*/

var fs = require("fs");
var dns = require('dns');
var os = require('os');
var sys = os.platform();
var async = require("async");
var hosts = require("hosts-group");
var bouncy = require('bouncy');
var Path = require("path");
var nproxy = require("nproxy");
var expr = require("./app.js");
var log = require('../log/logger');
var logger = log.getLogger("operate");
var config = require('../sysconfig');
var utils = require('../utils');
var nodeStatic = require('node-static').Server;
var http = require('http');
var url = require('url');
var vm = require('vm');
var qs = require('querystring');
var request = require('request');
var listFilePath = Path.join(__dirname, "proxy_list.js");
var r = request.defaults({
	'proxy': 'http://' + config.nproxy.host + ':' + config.nproxy.port
});

process.setMaxListeners(0);

function fdMaster() {
	this.configPath = Path.join(__dirname, "../../config.json");
	this.vhost = [];
	this.proxy = [];
	this.routeList = {}; //域名:端口
	this.statics = []; //所有static server
	this.staticsSockets = [];
	this.proxyServer = null;
	this.bouncyServer = null;
	this.init();
}

fdMaster.prototype = {
	constructor: fdMaster,
	init: function() {

		var content = {
			config: {
				"vhost": {},
				"proxy": [],
				"proxyGroup": [],
				"port": 8989
			}
		};

		if (!fs.existsSync(this.configPath)) {
			fs.writeFileSync(this.configPath, JSON.stringify(content.config,null,4));
			logger.info("auto product config.json success.....");
		}
		this.setup();
	},
	setup: function() {
		var self = this;
		utils.watchFile(self.configPath, function(err, json) {
			if (err) logger.error(err);
			else {
				logger.debug("配置文件变化,开始更新服务");
				self.restart(utils.noop);
			}
		},
		3);
	},
	_batchData: function(data) {
		//初始化vhost配置数据
		this.vhosts = [];
		this.proxy = [];
		this.routeList = {};
		//私有路由-uipage port转发
		this.vhosts.push({
			port: config.uipage.port,
			openOnlineProxy: 0,
			domain: config.uipage.host,
			status: true
		});
		for (var i in data.vhost) {
			var v = data.vhost[i];
			this.vhosts.push({
				openOnlineProxy: v['openOnlineProxy'],
				path: v['path'],
				domain: i,
				status: v['status']
			});
		}
		this.vhosts = utils._.filter(this.vhosts, function(item) {
			return item.status;
		});
		data.proxy = utils._.filter(data.proxy, {
			disabled: false
		});
		this.proxy = data.proxy;
	},
	reload: function(cb) {
		var self = this,
		json = utils.fileToJson(this.configPath);
		this._batchData(json);
		async.series([
		function(callback) {
			self.setupProxy(callback);
		},
		function(callback) {
			self.setupVhost(callback);
		}], cb);

	},
	start: function(cb) {
		var self = this,
		json = utils.fileToJson(this.configPath);
		this._batchData(json);
		async.series([
		function(callback) {
			hosts.set(config.uipage.host, config.uipage.ip);
			expr.listen(config.uipage.port, callback);
		},
		function(callback) {
			self.setupProxy(callback);
		},
		function(callback) {
			self.setupVhost(callback);
		},function(callback){
			self.setupBouncy(callback);
		}], function() {
			logger.info('expr proxy vhost bouncy 已启动');
			if (cb) cb();
		});
	},
	stop: function(cb) {
		var self = this;
		async.series([
		function(callback) {
			self.stopProxy(callback);
		},
		function(callback) {
			logger.info('stop vhost');
			self.stopVhost(callback);
		}], function() {
			logger.info('expr proxy vhost已关闭');
			if (cb) cb();
		});
	},
	restart: function(cb) {
		var self = this;
		async.series([function(cb) {
			logger.info('restart stop');
			self.stop(cb);
		},
		function(cb) {
			logger.info('restart reload');
			self.reload(cb);
		}], function() {
			logger.info('proxy vhost已重启');
			if (cb) cb();
		});
	},
	isNode: function(req) {
		return Path.extname(url.parse(req.url).pathname) == '.node';
	},
	runNode: function(file, req, res) {
		var code = fs.readFileSync(file, 'utf-8');
		var dirname = Path.dirname(file);
		try {
			vm.runInNewContext(code, {
				logger: logger,
				'__dirname': dirname,
				addModule: function(mod) {
					return require(dirname + '/node_modules/' + mod);
				},
				require: require,
				route: function(run) {
					run(req, res);
				}
			});
		} catch(e) {
			logger.error(e);
		}
	},
	bindStatic: function(fileServer, openOnlineProxy, req, res) {
		var self = this;
		req.addListener('end', function() {
			fileServer.serve(req, res, function(err, result) {
				if (err && (err.status === 404)) {
					if (openOnlineProxy === 0) {
						res.writeHeader(404, 'text/html');
						res.end(req.url + ' is not found');
					} else {
						//本地没有文件访问线上，透明server
						dns.resolve4(req.headers.host, function(err, addresses) {
							if (err) {
								res.writeHeader(200, 'text/html');
								res.write(req.url);
								res.end(err);
							} else {
								var ip = addresses[0];
								var p = 'http://' + ip + req.url;
								req.headers['Host'] = req.headers.host;
								request({
									method: req.method,
									url: p,
									headers: req.headers
								}).pipe(res);
							}
						});
					}
				}
			});
		}).resume();
	},
	matchProxy: function(req) {
		if (fs.existsSync(listFilePath)) {
			var proxylist;
			delete require.cache[require.resolve(listFilePath)];
			proxylist = require(listFilePath);
			for (var i = 0; i < proxylist.length; i++) {
				var proxy = proxylist[i];
				var url = 'http://' + req.headers.host + req.url;
				if (proxy.pattern == url || url.match(proxy.pattern)) {
					return true;
				}
			}
		}
		return false;
	},
	catchProxy: function(req, res) {
		if (req.method == 'GET') {
			r.get('http://' + req.headers.host + req.url).pipe(res);
		} else if (req.method == 'POST') {
			var body = '';
			req.on('data', function(data) {
				body += data;
			});
			req.on('end', function() {
				r.post({
					url: 'http://' + req.headers.host + req.url,
					body: body,
					headers: req.headers
				}).pipe(res);
			});
		}
	},
	setupVhost: function(cb) {
		var self = this;
		var len = self.vhosts.length;

		if (!len) cb();
		async.each(this.vhosts, function(item, callback) {
			var path = item.path,
			port = item.port,
			openOnlineProxy = item.openOnlineProxy,
			domain = item.domain;

			//hosts.set(domain, '127.0.0.1');
			if (path && fs.existsSync(path)) {
				//配置静态服务
				if (sys === 'win32') path = path.toLowerCase();
				var fileServer = new nodeStatic(path);
				var httpServer = http.createServer(function(req, res) {
					var file = Path.join(path, url.parse(req.url).pathname);
					//缺少rewrite规则
					if (self.matchProxy(req)) {
						self.catchProxy(req, res);
						return;
					}
					if (self.isNode(req) && fs.existsSync(file)) {
						self.runNode(file, req, res);
						return;
					}
					//透明代理
					self.bindStatic(fileServer, openOnlineProxy, req, res);
				});
				httpServer.on('error', function(err) {
					logger.error(err);
				});
				httpServer.on('connection', function(socket) {
					self.staticsSockets.push(socket);
					socket.on('close', function() {
						self.staticsSockets.splice(self.staticsSockets.indexOf(socket), 1);
					});
				});
				utils.getPort(function(port) {
					self.routeList[domain] = port;
					self.statics.push(httpServer);
					//设置域名
					httpServer.listen(port, callback);
				});
			} else if (port) {
				//配置端口转发	
				self.routeList[domain] = port;
				callback();
			} else {
				logger.error(path + ' 不存在');
				callback();
			}
		},
		cb);
	},
	setupProxy: function(cb) {
		var self = this,
		listContent = "module.exports = " + JSON.stringify(this.proxy,null,4) + ";";
		fs.writeFileSync(listFilePath, listContent);
		this.proxyServer = nproxy(config.nproxy.port, {
			"responderListFilePath": listFilePath,
			"debug": false
		});
		async.parallel({
			https: function(callback) {
				self.proxyServer['httpsServer'].on('listening', callback);
			},
			http: function(callback) {
				self.proxyServer['httpServer'].on('listening', callback);
			}
		},
		cb);
	},
	setupBouncy: function(cb) {
		var self = this;
		this.bouncyServer = bouncy(function(req, res, bounce) {
			var port = self.routeList[req.headers.host];
			logger.info(port,req.headers.host);
			if (port) {
				bounce(port);
			} else {
				res.statusCode = 404;
				res.end("no such host");
			}
		});
		this.bouncyServer.on("error", function(err) {
			logger.error(err);
		});
		this.bouncyServer.on("listening", cb);
		this.bouncyServer.listen(config.bouncy.port);
	},
	stopVhost: function(cb) {
		var self = this,
		len = this.statics.length;
		if (!len) cb();
		async.each(this.statics, function(server, callback) {
			self.staticsSockets.forEach(function(socket) {
				socket.destroy();
			});
			self.staticsSockets = [];
			server.close(callback);
		},
		function() {
			self.statics = [];
			cb();
		});
	},
	stopProxy: function(cb) {
		var self = this;
		if (this.proxyServer) {
			async.parallel({
				http: function(callback) {
					self.proxyServer['httpServer'].close();
					callback();
				},
				https: function(callback) {
					self.proxyServer['httpsServer'].close();
					callback();
				}
			},
			function() {
				self.proxyServer = null;
				//fs.unlinkSync(listFilePath);
				if (cb) cb();
			});
		}
	}
};

module.exports = new fdMaster();

