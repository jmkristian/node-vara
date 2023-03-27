const Bunyan = require('bunyan');
const Stream = require('stream');
/*
const AGWPE = require('../../server.js');
const Net = require('net');
const sinon = require('sinon');
const util = require('util');
*/
const ECONNREFUSED = 'ECONNREFUSED';
const ETIMEDOUT = 'ETIMEDOUT';
const HappyPorts = '2;Port1 stub;Port2 stub';

const logStream = new Stream();
const log = Bunyan.createLogger({
    name: 'ServerSpec',
    level: Bunyan.INFO,
    streams: [{
        type: "raw",
        stream: logStream,
    }],
});
logStream.writable = true;
logStream.write = function(item) {
    var c = item['class'];
    c = c ? c + ' ' : '';
    console.log(`${item.level}: ${c}${item.msg}`);
}
const LogNothing = Bunyan.createLogger({
    name: 'ServerSpec',
    level: Bunyan.FATAL + 100,
});

function exposePromise() {
    const result = {};
    result.promise = new Promise(function(resolve, reject) {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
}

class mockSocket extends Stream.Duplex {
    constructor(spec, options, respond) {
        super({
            readable: true, // default
            writable: true, // default
        });
        const that = this;
        this.log = (options ? (options.logger || LogNothing) : log)
            .child({'class': this.constructor.name});
        this.log.debug('new(%s, %s, %s)', typeof spec, options, typeof respond);
        this.respond = respond;
        this._read_buffer = [];
        this._pushable = false;
        this.on('pipe', function(from) {
            that.log.debug('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.debug('unpipe from %s', from.constructor.name);
        });
        if (spec) spec.theSocket = this;
    }
    connect(options, callback) {
        this.log.debug(`connect(%s, %s)`, options, typeof callback);
        if (callback) callback();
    }
    _destroy(err, callback) {
        this.emit('close');
        if (callback) callback();
    }
    _write(data, encoding, callback) {
        this.log.trace('_write(%d, %s, %s)', data.length, encoding, typeof callback);
        this.toReader(this.respond(data, encoding));
        if (callback) callback();
    }
    _read(size) {
        this.log.trace(`_read(%d)`, size);
        this._pushable = true;
        setTimeout(function(that) {
            that.pushMore();
        }, 10, this);
    }
    toReader(response) {
        if (response) {
            this.log.trace('toReader %d', response.length);
            this._read_buffer.push(response);
            this.pushMore();
        }
    }
    pushMore() {
        while (this._pushable && this._read_buffer.length > 0) {
            const response = this._read_buffer.shift();
            this.log.trace('push %d', response.length);
            this._pushable = this.push(response);
        }
    }
}

class mockNet {
    constructor(spec, options) {
        log.trace('new mockNet(%s, %s)', typeof spec, options);
        this.spec = spec;
        this.options = options;
        const that = this;
        this._newSocket = function() {
            return new mockSocket(that.spec, that.options, that.respond);
        }
        this.createConnection = function createConnection(options, connectListener) {
            log.trace('mockNet._createConnection(%s, %s)', options, typeof connectListener);
            const socket = that._newSocket();
            socket.on('error', function(err) {
                log.trace(err, 'socket');
            });
            if (that._overrideConnect) {
                socket.connect = function(options, callback) {
                    log.debug('_overrideConnect(%s, %s)', options, typeof callback);
                    that._overrideConnect(socket, options, callback);
                };
            }
            // Simulate time to connect:
            setTimeout(function() {
                socket.connect(options, connectListener);
            }, 10);
            return socket;
        }
    }
}

class noTNC extends mockNet {
    constructor(spec, options) {
        super(spec, options);
        this._overrideConnect = function(socket, options, callback) {
            socket.emit('error', newError('noTNC', ECONNREFUSED));
        };
    }
}

class noTNCHost extends mockNet {
    constructor(spec, options) {
        super(spec, options);
        this._overrideConnect = function(socket, options, callback) {
            socket.emit('error', newError('noTNCHost', ETIMEDOUT));
        };
    }
}

exports.ECONNREFUSED = ECONNREFUSED;
exports.ETIMEDOUT = ETIMEDOUT;
exports.log = log;
exports.LogNothing = LogNothing;
exports.exposePromise = exposePromise;
exports.mockNet = mockNet;
exports.mockSocket = mockSocket;
exports.noTNC = noTNC;
exports.noTNCHost = noTNCHost;
