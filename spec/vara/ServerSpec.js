const Bunyan = require('bunyan');
const Net = require('net');
const Stream = require('stream');
const VARA = require('../../index.js');

const logStream = new Stream();
const logger = Bunyan.createLogger({
    name: 'ServerSpec',
    level: Bunyan.ERROR,
    streams: [{
        type: "raw",
        stream: logStream,
    }],
});
logStream.writable = true;
logStream.write = function(item) {
    console.log(`${item.level}: ${item.msg}`);
}

const realSocket = Net.Socket;
var aSocket = null;

class mockSocket extends Stream.Duplex {
    constructor(options) {
        super({});
        logger.debug('new mockSocket(%o)', options);
        spyOn(this, 'on');
        spyOn(this, 'pipe');
        // spyOn(this, 'connect'); // doesn't work
        // spyOn(this, 'destroy'); // doesn't work
        // spyOn(this, '_write'); // doesn't work
        aSocket = this; 
    }
    connect(options, callback) {
        logger.debug(`connect(%s, %s)`, options, typeof callback);
        if (callback) callback('not really an error');
    }
    _destroy(err, callback) {
        if (callback) callback(err);
    }
    _read(size) {
        this.receiveBufferIsFull = false;
    }
    _write(data, encoding, callback) {
        logger.debug(`_write(%s, %s, %s)`, data.toString(), encoding, typeof callback);
        this.receiveBufferIsFull = this.push('OK\r');
        if (callback) callback();
    }
}

describe('Server', function() {

    let server, serverOptions

    beforeAll(function() {
        Net.Socket = mockSocket;
    });

    afterAll(function() {
        Net.Socket = realSocket;
    });

    beforeEach(function() {
        serverOptions = {
            host: Math.floor(Math.random() * (1 << 20)).toString(36),
            port: Math.floor(Math.random() * ((1 << 16) - 1)) + 1,
            logger: logger,
        };
        server = new VARA.Server(serverOptions);
    });

    afterEach(function() {
        try {
            server.close();
        } catch(err) {
        }
    });

    it('should not close when not listening', function() {
        server.close(function(err) {
            expect(err).toBeTruthy();
        });
    });

    it('should require TNC port', function() {
        new VARA.Server({port: serverOptions.port});
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

    it('should require myCallSigns', function() {
        try {
            server.listen({});
            fail('no options.myCallSigns');
        } catch(err) {
        }
    });

    it('should emit listening', function() {
        var listening = false;
        server.listen({myCallSigns: ['N0CALL']}, function() {
            listening = true;
        });
        expect(listening).toBe(true);
        expect(server.listening).toBe(true);
    });

    it('should connect to VARA TNC', function() {
        spyOn(mockSocket.prototype, 'connect');
        server.listen({
            myCallSigns: ['N0CALL'],
        });
        expect(aSocket.on).toHaveBeenCalled();
        expect(aSocket.pipe).toHaveBeenCalledTimes(1);
        expect(aSocket.connect).toHaveBeenCalledWith(
            jasmine.objectContaining({
                host: serverOptions.host,
                port: serverOptions.port,
            }),
            jasmine.any(Function)
        );
    });

    it('should disconnect from VARA TNC', function() {
        var closed = false;
        spyOn(mockSocket.prototype, 'destroy');
        server.listen({myCallSigns: ['N0CALL']});
        server.on('close', function(err) {
            closed = true;
        });
        server.close();
        expect(closed).toBe(true);
        expect(aSocket.destroy).toHaveBeenCalled();
    });

    it('should not listen twice', function() {
        var actual = null;
        server.listen({myCallSigns: ['N0CALL']});
        try {
            server.listen({myCallSigns: ['N0CALL']});
            fail();
        } catch(err) {
            actual = err;
        }
        expect(actual).toEqual(jasmine.objectContaining({
            code: 'ERR_SERVER_ALREADY_LISTEN',
        }));
    });
});
