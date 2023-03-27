const MockNet = require('./mockNet.js');
const Stream = require('stream');

const exposePromise = MockNet.exposePromise;
const log = MockNet.log;

class happyNet extends MockNet.mockNet {
    constructor(spec, options) {
        super(spec, options);
        this.respond = function(chunk, encoding) {
            return Buffer.from(chunk.toString('binary').toUpperCase(), 'binary');
        };
    }
}

describe('mockNet', function() {
    
    let net

    beforeEach(function() {
        net = new happyNet(this, {logger: MockNet.log});
    });

    afterEach(function() {
        if (this.theSocket) this.theSocket.destroy();
    });

    it('should pipe a response', function() {
        const request = exposePromise();
        const response = new Promise(function(resolve, reject) {
            reader = new Stream.Writable({
                write: function(chunk, encoding, callback) {
                    const actual = chunk.toString('binary');
                    log.debug('received %o', actual);
                    expect(actual).toEqual('ABCD');
                    resolve();
                    if (callback) callback();
                }
            });
            const socket = net.createConnection(null, function() {
                socket.pipe(reader);
                // Send the request:
                socket.write("abcd", null, function(err) {
                    if (err) request.reject(err);
                    else request.resolve();
                });
            });
        });
        return expectAsync(Promise.all([request.promise, response])).toBeResolved();
    });

    it('should pipe several responses', function() {
        // Send some requests:
        const requests = ['abcd', 'efgh', 'ijkl'];
        // Expect some responses:
        const expected = [
            [exposePromise(), 'ABCD'],
            [exposePromise(), 'EFGH'],
            [exposePromise(), 'IJKL'],
        ];
        const results = expected.map(e => e[0].promise);
        var expectIndex = 0;
        const reader = new Stream.Writable({
            write: function(chunk, encoding, callback) {
                const actual = chunk.toString('binary');
                log.debug('response %o', actual);
                const item = expected[expectIndex++];
                expect(actual).toEqual(item[1]);
                item[0].resolve();
                if (callback) callback();
            }});
        const socket = net.createConnection(null, function() {
            socket.pipe(reader);
            // Send the requests:
            var requestIndex = 0;
            new Stream.Readable({
                read: function(size) {
                    if (requestIndex < requests.length) {
                        const request = requests[requestIndex++];
                        log.debug('request %o', request);
                        this.push(Buffer.from(request, 'binary'));
                    }
                },
            }).pipe(socket);
        });
        return expectAsync(Promise.all(results)).toBeResolved();
    });

}); // mockNet
