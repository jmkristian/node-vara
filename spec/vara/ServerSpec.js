const VARA = require('../../server.js');
const Bunyan = require('bunyan');
const Net = require('net');
const sinon = require('sinon');
const Stream = require('stream');
const util = require('util');

const ECONNREFUSED = 'ECONNREFUSED';
const ETIMEDOUT = 'ETIMEDOUT';

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

function newError(message, code) {
    const err = new Error(message);
    if (code) err.code = code;
    return err;
}

/** A LineReceiver, but with a distinct class name (for logging). */
class stubReceiver extends VARA.LineReceiver {
    constructor(options, target) {
        super(options, target);
    }
}

class mockSocket extends Stream.Duplex {
    constructor(options, spec, respond) {
        super({
            readable: true, // default
            writable: true, // default
        });
        const that = this;
        this.log = (options ? (options.logger || LogNothing) : log)
            .child({'class': 'mockSocket'});
        this.log.debug('new(%o)', options);
        this.respond = respond;
        this._read_buffer = [];
        this._pushable = false;
        this.receiver = new stubReceiver({logger: options && options.logger}, this);
        this.on('pipe', function(from) {
            that.log.debug('pipe from %s', from.constructor.name);
        });
        this.on('unpipe', function(from) {
            that.log.debug('unpipe from %s', from.constructor.name);
        });
        spec.theSocket = this;
    }
    fromVARA(line) {
        try {
            this.toReader(this.respond(line) + '\r');
        } catch(err) {
            this.emit('error', err);
        }
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
        this.receiver.write(data, encoding, callback);
    }
    _read(size) {
        this.log.trace(`_read(%d)`, size);
        this._pushable = true;
        setTimeout(function(that) {
            that.pushMore();
        }, 10, this);
    }
    pushMore() {
        while (this._pushable && this._read_buffer.length > 0) {
            const response = this._read_buffer.shift();
            this.log.trace('push %s', response);
            this._pushable = this.push(response);
        }
    }
    toReader(response) {
        this.log.trace('toReader %o', response);
        if (response) {
            this._read_buffer.push(response);
            this.pushMore();
        }
    }
}

function happySocket(options, spec) {
    return new mockSocket(options, spec, function(request) {
        switch(request.toLowerCase()) {
        case 'bogus':
            return 'WRONG';
        default:
            return 'OK';
        }
    });
}

function noTNC(options, spec) {
    const socket = happySocket(options, spec);
    socket.connect = function(that, options, callback) {
        socket.emit('error', newError('noTNC', ECONNREFUSED));
    };
    return socket;
}

function noTNCHost(options, spec) {
    const socket = happySocket(options, spec);
    socket.connect = function(that, options, callback) {
        socket.emit('error', newError('noTNCHost', ETIMEDOUT));
    };
    return socket;
}

function exposePromise() {
    const result = {};
    result.promise = new Promise(function(resolve, reject) {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}

class LineConsumer {
    constructor(consume) {
        this.consume = consume;
    }
    fromVARA(line) {
        this.consume(line);
    }
}

describe('mockSocket', function() {

    let socket

    beforeEach(function() {
    });

    afterEach(function() {
        socket.destroy();
    });

    it('should pipe a response', function() {
        const spec = this;
        const request = exposePromise();
        const response = new Promise(function(resolve, reject) {
            const receiver = new stubReceiver({logger: log}, new LineConsumer(function(actual) {
                log.debug('received %s', actual);
                expect(actual).toEqual('OK');
                resolve();
            }));
            socket = happySocket({logger: log}, spec);
            socket.connect(null, function() {
                socket.pipe(receiver);
                socket.write('LISTEN ON\r', null, function(err) {
                    if (err) request.reject(err);
                    else request.resolve();
                });
            });
        });
        return expectAsync(Promise.all([request.promise, response])).toBeResolved();
    });

    it('should pipe 2 responses', function() {
        const spec = this;
        // Send some requests:
        const requests = ['VERSION', 'BOGUS'];
        // Expect some responses:
        const expected = [
            [exposePromise(), 'OK'],
            [exposePromise(), 'WRONG'],
        ];
        const results = expected.map(e => e[0].promise);
        var expectIndex = 0;
        const receiver = new stubReceiver({logger: log}, new LineConsumer(function(actual) {
            log.debug('response %s', actual);
            const item = expected[expectIndex++];
            expect(actual).toEqual(item[1]);
            item[0].resolve();
        }));
        socket = happySocket({logger: log}, spec);
        socket.connect(null, function() {
            socket.pipe(receiver);
            // Send the requests:
            var requestIndex = 0;
            new Stream.Readable({
                read: function(size) {
                    if (requestIndex < requests.length) {
                        const request = requests[requestIndex++];
                        log.debug('request %o', request);
                        this.push(request + '\r');
                    }
                },
            }).pipe(socket);
        });
        return expectAsync(Promise.all(results)).toBeResolved();
    });

}); // mockSocket

describe('Server', function() {

    const sandbox = sinon.createSandbox();
    let serverOptions, server, newSocket

    beforeEach(function() {
        const that = this;
        newSocket = function(options) {
            return happySocket(options, that);
        };
        serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            newSocket: newSocket,
            logger: log,
        };
        server = new VARA.Server(serverOptions);
    });

    afterEach(function() {
        server.close();
        sandbox.restore();
    });

    it('should not close when closed', function() {
        server.close(function(err) {
            expect(err).toBeTruthy();
        });
    });

    it('should require TNC port', function() {
        try {
            new VARA.Server();
            fail('no options');
        } catch(err) {
        }
        try {
            new VARA.Server({host: serverOptions.host});
            fail('no options.port');
        } catch(err) {
        }
    });

    it('should require the VARA host', function() {
        try {
            server.listen({});
            fail('no options.host');
        } catch(err) {
        }
    });

    it('should not listen when listening', function() {
        var actual = null;
        server.listen({host: ['N0CALL']});
        try {
            server.listen({host: ['N0CALL']});
            fail();
        } catch(err) {
            actual = err;
        }
        expect(actual).toEqual(jasmine.objectContaining({
            code: 'ERR_SERVER_ALREADY_LISTEN',
        }));
    });

    it('should callback from listening', function() {
        log.debug('Server should callback from listening');
        const listening = new Promise(function(resolve, reject) {
            server.listen({host: 'N0CALL'}, function() {
                if (server.listening) {
                    setTimeout(resolve, 500);
                    // The timeout isn't really neccessary, but
                    // it makes the log output more interesting.
                } else {
                    reject('!server.listening');
                }
            });
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should emit listening', function() {
        log.debug('Server should emit listening');
        const listening = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                if (server.listening) {
                    resolve();
                } else {
                    reject('!server.listening');
                }
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should connect to TNC', function() {
        log.debug('Server should connect to TNC');
        const connectSpy = sandbox.spy(mockSocket.prototype, 'connect');
        const connected = new Promise(function(resolve, reject) {
            server.listen({host: ['N0CALL']}, function() {
                // Give the server some time to connect the socket.
                setTimeout(function() {
                    expect(connectSpy.calledOnce).toBeTruthy();
                    expect(connectSpy.getCall(0).args[0])
                        .toEqual(jasmine.objectContaining({
                            host: serverOptions.host,
                            port: serverOptions.port,
                        }));
                    resolve();
                }, 500);
            });
        });
        return expectAsync(connected).toBeResolved();
    });

    it('should disconnect from TNC', function() {
        log.debug('Server should disconnect from TNC');
        const destroySpy = sandbox.spy(mockSocket.prototype, 'destroy');
        const closed = new Promise(function(resolve, reject) {
            server.on('close', function(err) {
                expect(destroySpy.calledOnce).toBeTruthy();
                resolve();
            });
            server.listen({host: 'N0CALL'}, function() {
                // Give the server some time to connect the socket.
                setTimeout(function() {
                    server.close();
                }, 500);
            });
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should report no TNC', function() {
        log.debug('Server should report no TNC');
        const spec = this;
        server = new VARA.Server(Object.assign(
            {}, serverOptions,
            {newSocket: function(options) {
                return noTNC(options, spec);
            }}));
        const closed = new Promise(function(resolve, reject) {
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                expect(err.code).toEqual(ECONNREFUSED);
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should report no TNC host', function() {
        log.debug('Server should report no TNC host');
        const spec = this;
        server = new VARA.Server(Object.assign(
            {}, serverOptions,
            {newSocket: function(options) {
                return noTNCHost(options, spec);
            }}));
        const closed = new Promise(function(resolve, reject) {
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                expect(err.code).toEqual(ETIMEDOUT);
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(closed).toBeResolved();
    });

}); // Server
