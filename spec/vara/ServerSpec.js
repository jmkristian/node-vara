const VARA = require('../../server.js');
const MockNet = require('../mockNet/mockNet.js');
const sinon = require('sinon');

const log = MockNet.log;
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

class listenFails extends MockNet.mockNet {
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

function beginSpec(spec, description) {
    log.debug('begin spec should %s %s', description, spec.serverOptions);
    spec.description = description;
}

function endSpec(spec) {
    log.debug('end spec should %s', spec.description);
}

describe('Server', function() {

    const sandbox = sinon.createSandbox();

    beforeEach(function() {
        const that = this;
        this.serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            Net: new happyNet(),
            logger: log,
        };
        this.server = new VARA.Server(this.serverOptions);
    });

    afterEach(function() {
        if (this.server) this.server.close();
        endSpec(this);
        sandbox.restore();
    });

    it('should not close when closed', function() {
        beginSpec(this, 'not close when closed');
        const server = this.server;
        const closed = new Promise(function(resolve, reject) {
            server.close(function(err) {
                expect(err).toBeTruthy();
                resolve();
            });
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should require TNC port', function() {
        beginSpec(this, 'require TNC port');
        try {
            new VARA.Server();
            fail('no options');
        } catch(err) {
        }
        try {
            new VARA.Server({host: this.serverOptions.host});
            fail('no options.port');
        } catch(err) {
        }
    });

    it('should require the VARA host', function() {
        beginSpec(this, 'require the VARA host');
        try {
            this.server.listen({spec: 'should require the VARA host'});
            fail('no options.host');
        } catch(err) {
        }
    });

    it('should not listen when listening', function() {
        beginSpec(this, 'not listen when listening');
        const server = this.server;
        const listening = new Promise(function(resolve, reject) {
            server.listen({host: ['N0CALL']}, function() {
                resolve();
            });
            try {
                server.listen({host: ['N0CALL']});
                fail();
            } catch(err) {
                expect(err).toEqual(jasmine.objectContaining({
                    code: 'ERR_SERVER_ALREADY_LISTEN',
                }));
            }
        });
        return expectAsync(listening).toBeResolved();
    });

    it('should callback from listening', function() {
        beginSpec(this, 'callback from listening');
        const server = this.server;
        const listening = new Promise(function(resolve, reject) {
            server.listen({host: 'N0CALL'}, function() {
                if (server.listening) {
                    setTimeout(resolve, 100);
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
        beginSpec(this, 'emit listening');
        const server = this.server;
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
        beginSpec(this, 'connect to TNC');
        const server = this.server;
        const expectOptions = {
            host: this.serverOptions.host,
            port: this.serverOptions.port,
        };
        const connectSpy = sandbox.spy(MockNet.mockSocket.prototype, 'connect');
        const connected = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                expect(server.listening).toEqual(true);
                expect(connectSpy.calledOnce).toBeTruthy();
                expect(connectSpy.getCall(0).args[0]).toEqual(
                    jasmine.objectContaining(expectOptions));
                resolve();
            });
            server.listen({host: ['N0CALL']});
        });
        return expectAsync(connected).toBeResolved();
    });

    it('should disconnect from TNC', function() {
        beginSpec(this, 'should disconnect from TNC');
        const server = this.server;
        const destroySpy = sandbox.spy(MockNet.mockSocket.prototype, 'destroy');
        const closed = new Promise(function(resolve, reject) {
            server.on('listening', function() {
                expect(server.listening).toEqual(true);
                server.close();
            });
            server.on('close', function(err) {
                expect(destroySpy.calledOnce).toBeTruthy();
                resolve();
            });
            server.listen({host: ['N0CALL']});
        });
        return expectAsync(closed).toBeResolved();
    });

    it('should report no TNC', function() {
        beginSpec(this, 'report no TNC');
        const spec = this;
        const server = new VARA.Server(Object.assign(
            {}, this.serverOptions,
            {Net: new MockNet.noTNC(spec)}
        ));
        const reported = new Promise(function(resolve, reject) {
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                expect(err.code).toEqual(MockNet.ECONNREFUSED);
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(reported).toBeResolved();
    });

    it('should report no TNC host', function() {
        beginSpec(this, 'report no TNC host');
        const spec = this;
        const server = new VARA.Server(Object.assign(
            {}, this.serverOptions,
            {Net: new MockNet.noTNCHost(spec)}
        ));
        const reported = new Promise(function(resolve, reject) {
            server.on('listening', function(err) {
                reject('listening');
            });
            server.on('error', function(err) {
                log.debug('error %o from server', err);
                expect(err.code).toEqual(MockNet.ETIMEDOUT);
                resolve();
            });
            server.listen({host: 'N0CALL'});
        });
        return expectAsync(reported).toBeResolved();
    });

    it('should not listen if TNC refuses', function() {
        beginSpec(this, 'not listen if TNC refuses');
        const spec = this;
        const server = new VARA.Server(Object.assign(
            {}, this.serverOptions,
            {Net: new listenFails(spec)}
        ));
        const reported = new Promise(function(resolve, reject) {
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
        return expectAsync(reported).toBeResolved();
    });

}); // Server
