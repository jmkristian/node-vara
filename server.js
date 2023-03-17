/** Utilities for exchanging data via VARA FM or VARA HF. */

const Bunyan = require('bunyan');
const EventEmitter = require('events');
const Net = require('net');
const Stream = require('stream');

const DefaultLogID = 'VARA';
const KByte = 1 << 10;

const LogNothing = Bunyan.createLogger({
    name: 'VARA',
    level: Bunyan.FATAL + 100,
});

function getLogger(options, that) {
    if (!(options && options.logger)) {
        return LogNothing;
    } else if (that) {
        return options.logger.child({'class': that.constructor.name});
    } else {
        return options.logger;
    }
}

function getDataSummary(data) {
    if (Buffer.isBuffer(data)) {
        if (data.length <= 32) {
            return data.toString('binary').replace(/\r/g, '\\r');
        } else {
            return data.toString('binary', 0, 32).replace(/\r/g, '\\r') + '...';
        }
    } else {
        var s = data + '';
        if (s.length <= 32) {
            return s.replace(/\r/g, '\\r');
        } else {
            return s.substring(0, 32).replace(/\r/g, '\\r') + '...';
        }
    }
}

/** Pipes data from a Readable stream to a fromVARA method. */
class VARAReceiver extends Stream.Writable {

    constructor(options, target) {
        super(); // The defaults are good.
        this.log = getLogger(options, this);
        this.target = target;
    }

    _write(chunk, encoding, callback) {
        try {
            if (!Buffer.isBuffer(chunk)) {
                throw `VARAReceiver._write chunk isn't a Buffer`;
            } else if (!this.target) {
                throw 'Lost received data ' + getDataSummary(chunk);
            } else {
                if (this.log.trace()) {
                    this.log.trace('< %s', getDataSummary(chunk));
                }
                this.target.fromVARA(chunk);
            }
            callback(null);
        } catch(err) {
            this.log.error(err);
            callback(err);
        }
    }
}

/** Exchanges bytes between one local call sign and one remote call sign. */
class Connection extends Stream.Duplex {
    /* It's tempting to simply provide the dataSocket to the application, but
       this doesn't work. The dataSocket doesn't always emit close when you
       expect. And when the application calls connection.end(data), we must
       wait for VARA to report that it has transmitted all the data before
       closing the dataSocket. And it's not clear from the documentation
       whether VARA closes the dataSocket when the VARA connection is
       disconnected.
    */

    constructor(options, dataSocket) {
        super({
            allowHalfOpen: true,
            emitClose: false, // emitClose: true doesn't always emit close.
            readableObjectMode: false,
            readableHighWaterMark: 4 * KByte,
            writableObjectMode: false,
            writableHighWaterMark: 4 * KByte,
        });
        this.log = getLogger(options, this);
        this.dataSocket = dataSocket;
        this.bufferLength = 0;
        var that = this;
        this.on('end', function onEnd(err) {
            that.ended = true;
        });
        this.on('close', function onClose(err) {
            if (!that.ended) {
                that.ended = true;
                that.emit('end');
            }
            that.closed = true;
        });
    }

    _write(data, encoding, callback) {
        if (this.ended) {
            callback();
        } else {
            if (this.log.debug()) {
                this.log.debug('data> %s', getDataSummary(data));
            }
            this.bufferLength += data.length;
            this.dataSocket.write(data, encoding, callback);
        }
    }

    _read(size) {
        this.receiveBufferIsFull = false;
        // fromVARA calls this.push.
    }

    _final(callback) {
        this.log.debug('_final');
        callback();
    }

    _destroy(err, callback) {
        this.log.debug('_destroy');
        // The documentation seems to say this.destroy() should emit
        // 'end' and 'close', but I find that doesn't always happen.
        // This works reliably:
        if (!this.ended) {
            this.ended = true;
            this.emit('end');
        }
        if (!this.closed) {
            this.closed = true;
            this.emit('close');
        }
        delete this.dataSocket;
        callback(err);
    }

    fromVARA(buffer) {
        if (this.log.debug()) {
            this.log.debug('data< %s', getDataSummary(buffer));
        }
        if (this.receiveBufferIsFull) {
            this.emit('error',
                      new Error('VARA receive buffer overflow: '
                                + getDataSummary(buffer)));
        } else {
            this.receiveBufferIsFull = !this.push(buffer);
        }
    }

} // Connection

/** Similar to net.Server, but for VARA connections.
    Each 'connection' event provides a Duplex stream for exchanging data via
    one VARA connection. The remote call sign is connection.theirCall. To
    disconnect, call connection.end() or destroy(). The connection emits a
    'close' event when VARA is disconnected.
*/
class Server extends EventEmitter {

    constructor(options, onConnection) {
        super();
        this.log = getLogger(options, this);
        if (!options) {
            this.emit('error', new Error(`missing options`));
            this.close();
        } else {
            this.options = options;
            this.outputBuffer = [];
            if (onConnection) this.on('connection', onConnection);
        }
    }
    
    listen(options, callback) {
        this.log.trace('listen(%o)', options);
        if (!options) {
            this.emit('error', new Error('listen called without options'));
        } else {
            this.myCallSigns = options.myCallSigns ? options.myCallSigns.join(' ') : undefined;
            if (!this.myCallSigns) { // possibly ''
                this.emit('error', new Error('listen called without myCallSigns'));
            } else {
                if (callback) {
                    this.on('listening', callback);
                }
                this.connectVARA();
            }
        }
    }

    close(afterClose) {
        this.log.debug(`close()`);
        this.iAmClosed = true;
        this.socket.destroy();
        if (afterClose) afterClose();
    }

    toVARA(line, waitFor) {
        this.outputBuffer.push(line);
        this.outputBuffer.push(waitFor);
        if (this.waitingFor == null) {
            this.flushToVARA();
        }
    }

    flushToVARA() {
        if (this.outputBuffer.length) {
            var line = this.outputBuffer.shift();
            var waitFor = this.outputBuffer.shift();
            this.log.debug(`> ${line}`);
            this.socket.write(line + '\r');
            this.waitingFor = waitFor && waitFor.toLowerCase();
        }
    }

    fromVARA(buffer) {
        if (this.inputBuffer == null) {
            this.inputBuffer = '';
        }
        this.inputBuffer += buffer.toString('utf-8');
        var CR;
        while (0 <= (CR = this.inputBuffer.indexOf('\r'))) {
            var line = this.inputBuffer.substring(0, CR);
            this.inputBuffer = this.inputBuffer.substring(CR + 1);
            var parts = line.split(/\s+/);
            var part0 = parts[0].toLowerCase();
            switch(part0) {
            case 'busy':
            case 'iamalive':
            case 'ptt':
                // boring
                this.log.trace(`< ${line}`);
                break;
            default:
                this.log.debug(`< ${line}`);
            }
            if (this.waitingFor && this.waitingFor == part0) {
                this.waitingFor = null;
                this.flushToVARA();
            }
            switch(part0) {
            case '':
                break;
            case 'pending':
                this.connectDataSocket();
                break;
            case 'cancelpending':
                if (!this.isConnected) {
                    this.disconnectData();
                }
                break;
            case 'connected':
                this.connectData(parts);
                break;
            case 'disconnected':
                this.isConnected = false;
                this.disconnectData(parts[1]);
                break;
            case 'buffer':
                if (this.endingData &&
                    (this.connection.bufferLength = parseInt(parts[1])) <= 0) {
                    this.endingData = false;
                    this.disconnectData();
                    /* This isn't foolproof. If we send data simultaneous
                       with receiving 'BUFFER 0' from VARA, we might call
                       disconnectData prematurely and consequently VARA
                       would lose the data.
                    */
                }
                break;
            case 'missing':
                this.log.error(`< ${line}`);
                this.close();
                break;
            case 'wrong':
                this.log.warn(`< ${line}`);
                this.waitingFor = null;
                this.flushToVARA();
                break;
            default:
                // We already logged it. No other action needed.
            }
        }
    }

    connectVARA() {
        this.log.debug(`connectVARA`);
        if (this.socket) {
            this.socket.destroy();
        }
        this.socket = new Net.Socket();
        var that = this;
        this.socket.on('error', function(err) {
            that.log.trace('socket %s', err || '');
            that.emit('error', err);
            if (err &&
                (`${err}`.includes('ECONNREFUSED') ||
                 `${err}`.includes('ETIMEDOUT'))) {
                that.close();
            }
        });
        // VARA might close the socket. The documentation doesn't say.
        this.socket.on('close', function(info) {
            that.log.debug('socket close %s', info || '');
            if (!that.iAmClosed) {
                that.connectVARA();
            }
        });
        ['timeout', 'end', 'finish'].forEach(function(event) {
            that.socket.on(event, function(info) {
                that.log.debug('socket %s %s', event, info || '');
            });
        });
        this.socket.pipe(new VARAReceiver(this.options, this));
        this.socket.connect(this.options, function(err) {
            if (err) {
                that.log.warn(err, `socket`);
            }
            that.toVARA('VERSION', 'VERSION');
            that.toVARA(`MYCALL ${that.myCallSigns}`, 'OK');
            // that.toVARA(`CHAT OFF`, 'OK'); // seems to be unnecessary
            that.toVARA('LISTEN ON', 'OK');
            that.emit('listening', {myCallSigns: that.myCallSigns.split(/\s+/)});
        });
    }

    connectDataSocket() {
        if (!this.dataSocket) {
            this.log.debug('connectDataSocket');
            this.dataSocket = new Net.Socket();
            var that = this;
            ['error', 'timeout'].forEach(function(event) {
                that.dataSocket.on(event, function onDataSocketEvent(info) {
                    that.log.debug('dataSocket %s %s', event, info || '');
                    if (that.connection) {
                        that.connection.emit(event, info);
                    }
                });
            });
            ['end', 'close'].forEach(function(event) {
                that.dataSocket.on(event, function(err) {
                    if (err) that.log.warn('dataSocket %s %s', event, err);
                    else that.log.debug('dataSocket %s', event);
                    that.disconnectData(err);
                    delete that.dataSocket;
                });
            });
            this.dataSocket.connect({
                host: this.options.host,
                port: this.options.dataPort,
            });
        }
    }

    connectData(parts) {
        if (this.dataSocket && this.dataReceiver) {
            // It appears we're re-using an old dataSocket.
            this.dataSocket.unpipe(this.dataReceiver);
            delete this.dataReceiver;
        }
        this.connectDataSocket(); // if necessary
        this.connection =
            new Connection(this.options, this.dataSocket);
        var that = this;
        ['end', 'close'].forEach(function(event) {
            that.connection.on(event, function(err) {
                that.log.debug('connection %s %s', event, err || '');
            });
        });
        this.connection.on('finish', function(err) {
            if (err) that.log.warn('connection finish %s', err);
            else that.log.debug('connection finish');
            if (that.isConnected) {
                if (that.connection.bufferLength <= 0) {
                    that.disconnectData(err);
                } else {
                    /* If we send DISCONNECT now, VARA will lose the data in its
                       buffer. So, wait until VARA reports that its buffer is empty
                       and then end the dataSocket.
                    */
                    that.endingData = true;
                }
            }
        });
        this.connection.theirCallSign = parts[1];
        this.connection.myCallSign = parts[2];
        this.dataReceiver
            = new VARAReceiver(this.options, this.connection);
        this.dataSocket.pipe(this.dataReceiver);
        this.isConnected = true;
        this.emit('connection', this.connection);
    }

    disconnectData(err) {
        if (this.isConnected) {
            this.toVARA('DISCONNECT');
        }
        this.isConnected = false;
        this.endingData = false;
        if (this.dataReceiver) {
            if (this.dataSocket) {
                this.dataSocket.unpipe(this.dataReceiver);
            }
            delete this.dataReceiver;
        }
        if (this.connection) {
            try {
                this.connection.destroy(err);
            } catch(err) {
                this.log.error(err);
            }
            delete this.connection;
        }
    }

} // Server

exports.Server = Server;
exports.toDataSummary = getDataSummary;
