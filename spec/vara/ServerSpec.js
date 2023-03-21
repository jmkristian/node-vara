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
    constructor() {
        super({});
        logger.debug(`new mockSocket`);
        spyOn(this, 'on');
        spyOn(this, 'pipe');
        // spyOn(this, 'connect'); // doesn't work
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

    let server

    beforeAll(function() {
        Net.Socket = mockSocket;
    });

    afterAll(function() {
        Net.Socket = realSocket;
    });

    beforeEach(function() {
        server = new VARA.Server({logger: logger});
    });

    afterEach(function() {
        server.close();
    });

    it('should not close when not listening', function() {
        server.close(function(err) {
            expect(err).toBeTruthy();
        });
    });

    it('should require myCallSigns', function() {
        try {
            server.listen({});
            fail();
        } catch(err) {
        }
    });

    it('should emit listening', function() {
        var listening = false;
        server.listen({myCallSigns: ['N0CALL']}, function() {
            listening = true;
        });
        expect(listening).toBe(true);
    });

    it('should connect to VARA TNC', function() {
        spyOn(mockSocket.prototype, 'connect');
        server.listen({myCallSigns: ['N0CALL']});
        expect(aSocket.on).toHaveBeenCalled();
        expect(aSocket.connect).toHaveBeenCalledTimes(1);
        expect(aSocket.pipe).toHaveBeenCalledTimes(1);
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
