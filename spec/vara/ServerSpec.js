const VARA = require('../../server.js');
const Bunyan = require('bunyan');
const MockNet = require('../mockNet/mockNet.js');
const Net = require('net');
const Readline = require('readline');
const sinon = require('sinon');
const Stream = require('stream');
const util = require('util');

const ECONNREFUSED = MockNet.ECONNREFUSED;
const ETIMEDOUT = MockNet.ETIMEDOUT;
const exposePromise = MockNet.exposePromise;
const log = MockNet.log;
const newError = MockNet.newError;

const MockVersion = 'VERSION mock\r';

class happyNet extends MockNet.mockNet {
    constructor(spec, options) {
        super(spec, options);
        this.respond = function(chunk, encoding) {
            const request = chunk.toString('binary');
            switch(request.toLowerCase()) {
            case 'bogus\r':
                return 'WRONG\r';
            case 'version\r':
                return MockVersion;
            default:
                return 'OK\r';
            }
        };
    }
}

class listenFails extends happyNet {
    constructor(spec, options) {
        super(spec, options);
        this.respond = function(chunk, encoding) {
            const request = chunk.toString('binary');
            switch(request.toLowerCase()) {
            case 'version\r':
                return MockVersion;
            case 'listen on\r':
                return 'WRONG\r';
            default:
                return 'OK\r';
            }
        };
    }
}

class LineConsumer {
    constructor(consume) {
        this.consume = consume;
    }
    fromVARA(line) {
        this.consume(line);
    }
}

describe('Server', function() {

    const sandbox = sinon.createSandbox();
    let serverOptions, server

    beforeEach(function() {
        const that = this;
        serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            Net: new happyNet(),
            logger: log,
        };
        server = new VARA.Server(serverOptions);
    });

    afterEach(function() {
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
        const connectSpy = sandbox.spy(MockNet.mockSocket.prototype, 'connect');
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
        const destroySpy = sandbox.spy(MockNet.mockSocket.prototype, 'destroy');
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
            {Net: new MockNet.noTNC(spec)}
        ));
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
            {Net: new MockNet.noTNCHost(spec)}
        ));
        const closed = new Promise(function(resolve, reject) {
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                log.debug('error %o from server', err);
                expect(err.code).toEqual(ETIMEDOUT);
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should not listen if TNC refuses', function() {
        const spec = this;
        server = new VARA.Server(Object.assign(
            {}, serverOptions,
            {Net: new listenFails(spec)}
        ));
        const closed = new Promise(function(resolve, reject) {
            var resolved = false;
            server.on('listening', function(err) {
                log.debug('listening %s', err || '');
                reject('listening');
            });
            server.on('error', function(err) {
                log.debug(err);
                if (!resolved) resolve(err);
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(closed).toBeResolved();
    });

}); // Server
