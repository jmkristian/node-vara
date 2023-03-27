/** Utilities for exchanging data via VARA FM or VARA HF. */

const EventEmitter = require('events');
const Net = require('net');
const Readline = require('readline');
const Stream = require('stream');

const DefaultLogID = 'VARA';
const KByte = 1 << 10;
const ERR_INVALID_ARG_VALUE = 'ERR_INVALID_ARG_VALUE';

const LogNothing = {
    child: function(){return LogNothing;},
    trace: function(){},
    debug: function(){},
    info: function(){},
    warn: function(){},
    error: function(){},
    fatal: function(){},
};

function getLogger(options, that) {
    if (!(options && options.logger)) {
        return LogNothing;
    } else if (that) {
        return options.logger.child({'class': that.constructor.name});
    } else {
        return options.logger;
    }
}

function newError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
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
class DataReceiver extends Stream.Writable {

    constructor(options, target) {
        super(); // The defaults are good.
        if (!target) {
            this.log.warn(newError('no target', ERR_INVALID_ARG_VALUE));
        }
        this.log = getLogger(options, this);
        this.target = target;
    }

    _write(chunk, encoding, callback) {
        try {
            if (!Buffer.isBuffer(chunk)) {
                throw newError(`DataReceiver._write chunk isn't a Buffer`,
                               ERR_INVALID_ARG_VALUE);
            }
            if (this.log.trace()) {
                this.log.trace('< %s', getDataSummary(chunk));
            }
            this.target.fromVARA(chunk);
            callback(null);
        } catch(err) {
            this.log.warn(err);
            callback(err);
        }
    }
}

/** Exchanges bytes between one local call sign and one remote call sign. */
class Connection extends Stream.Duplex {
    /* It's tempting to simply provide the dataSocket to the application, but
       that doesn't work. The dataSocket doesn't always emit close when you
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
        this._pushable = true;
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
        if (this._pushable) {
            this._pushable = this.push(buffer);
        } else {
            this.emit('error', new Error(
                'VARA receive buffer overflow: ' + getDataSummary(buffer)
            ));
        }
    }

} // Connection

/** Similar to net.Server, but for VARA connections.
    Each 'connection' event provides a Duplex stream for exchanging data via
    one VARA connection. The remote call sign is connection.remoteAddress.
    To disconnect, call connection.end() or destroy(). The connection emits
    a 'close' event when VARA is disconnected.
*/
class Server extends EventEmitter {

    constructor(options, onConnection) {
        super();
        if (!(options && options.port)) throw new Error('no options.port');
        this.log = getLogger(options, this);
        this.options = options;
        this.listening = false;
        this.outputBuffer = [];
        if (onConnection) this.on('connection', onConnection);
    }
    
    listen(options, callback) {
        this.log.trace('listen(%o)', options);
        if (!(options && options.host && (!Array.isArray(options.host) || options.host.length > 0))) {
            throw newError('no options.host', ERR_INVALID_ARG_VALUE);
        }
        if (this.listening) {
            throw newError('Server is already listening.', 'ERR_SERVER_ALREADY_LISTEN');
        }
        this.listening = true;
        this.host = options.host;
        if (callback) {
            this.on('listening', callback);
        }
        this.connectVARA();
    }

    close(callback) {
        this.log.trace('close()');
        if (!this.listening) {
            if (callback) callback(new Error('Server is already closed'));
        } else {
            this.listening = false;
            if (this.socket) this.socket.destroy();
            this.emit('close');
            if (callback) callback();
        }
    }

    toVARA(line, waitFor) {
        this.log.trace('toVARA(%s, %s)', line, waitFor);
        this.outputBuffer.push(line);
        this.outputBuffer.push(waitFor);
        if (this.waitingFor == null) {
            this.flushToVARA();
        }
    }

    flushToVARA() {
        this.log.trace('flushToVara');
        if (this.outputBuffer.length) {
            var line = this.outputBuffer.shift();
            var waitFor = this.outputBuffer.shift();
            this.log.debug(`> ${line}`);
            this.lastRequest = line;
            this.waitingFor = waitFor && waitFor.toLowerCase();
            this.socket.write(line + '\r');
        }
    }

    fromVARA(line) {
        var parts = line.split(/\s+/);
        var part0 = parts[0].toLowerCase();
        switch(part0) {
        case '':
        case 'busy':
        case 'iamalive':
        case 'ptt':
            // boring
            this.log.trace(`< ${line}`);
            break;
        default:
            this.log.debug(`< ${line}`);
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
        case 'ok':
            if (this.lastRequest == 'LISTEN ON') {
                this.log.trace(`lastRequest ${this.lastRequest}`);
                this.emit('listening', {
                    host: (!Array.isArray(this.host) || this.host.length > 1)
                        ? this.host
                        : this.host.length == 1 ? this.host[0]
                        : undefined,
                });
            }
            break;
        case 'wrong':
            if (this.waitingFor) {
                this.emit('error', newError(`TNC responded "${line}"`
                                            + ` (not "${this.waitingFor}")`
                                            + ` in response to "${this.lastRequest}"`));
            } else {
                this.emit('error', newError(`TNC responded "${line}"`));
            }
            this.waitingFor = undefined;
            this.flushToVARA();
            break;
        default:
            // We already logged it. No other action needed.
        }
        if (this.waitingFor == part0) {
            this.waitingFor = undefined;
            this.lastRequest = undefined;
            this.flushToVARA();
        }
    }

    _createConnection(connectOptions, onConnected) {
        const options = Object.assign({host: '127.0.0.1'}, connectOptions);;
        delete options.dataPort;
        delete options.logger;
        delete options.Net;
        this.log.trace('%s.createConnection(%s)',
                       this.options.Net ? 'options.Net' : 'Net',
                       options);
        return (this.options.Net || Net).createConnection(options, onConnected);
    }

    connectVARA() {
        this.log.trace(`connectVARA`);
        try {
            if (this.socket) {
                this.socket.destroy();
            }
            const that = this;
            const myCallSigns = Array.isArray(this.host)
                  ? this.host.join(' ')
                  : this.host + '';
            this.socket = this._createConnection(this.options, function onConnected(err) {
                that.log.trace('socket connected %s', err || '');
                const reader = Readline.createInterface({
                    input: that.socket,
                });
                reader.on('line', function(line) {
                    that.fromVARA(line);
                });
                reader.on('error', function(err) {});
                that.toVARA('VERSION', 'VERSION');
                that.toVARA(`MYCALL ${myCallSigns}`, 'OK');
                // that.toVARA(`CHAT OFF`, 'OK'); // seems to be unnecessary
                that.toVARA('LISTEN ON', 'OK');
            });
            this.socket.on('error', function(err) {
                that.log.trace(err, 'socket');
                that.emit('error', err);
                if (err &&
                    (err.code == 'ECONNREFUSED' ||
                     err.code == 'ETIMEDOUT')) {
                    that.close();
                }
            });
            // VARA might close the socket. The documentation doesn't say.
            this.socket.on('close', function(info) {
                that.log.trace('socket close %s', info || '');
                if (that.listening) {
                    that.connectVARA();
                }
            });
            ['timeout', 'end', 'finish'].forEach(function(event) {
                that.socket.on(event, function(info) {
                    that.log.debug('socket emitted %s %s', event, info || '');
                });
            });
        } catch(err) {
            this.emit('error', err);
        }
    }

    connectDataSocket() {
        const that = this;
        const emitEvent = function(event, err) {
            if (that.connection) {
                that.connection.emit(event, info);
            } else {
                that.emit(event, info);
            }
        };
        try {
            if (!this.dataSocket) {
                this.log.debug('connectDataSocket');
                this.dataSocket = this._createConnection(
                    Object.assign({}, this.options,
                                  {port: this.options.dataPort || this.options.port + 1}),
                    function onConnected(err) {
                        that.log.trace('dataSocket connected %s', err || '');
                    });
                ['error', 'timeout'].forEach(function(event) {
                    that.dataSocket.on(event, function onDataSocketEvent(info) {
                        that.log.trace('dataSocket %s %s', event, info || '');
                        emitEvent(event, info);
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
            }
        } catch(err) {
            emitEvent('error', err);
        }
    }

    connectData(parts) {
        this.log.debug('connectData(%o)', parts);
        if (this.dataSocket && this.dataReceiver) {
            // It appears we're re-using an old dataSocket.
            this.dataSocket.unpipe(this.dataReceiver);
            delete this.dataReceiver;
        }
        this.connectDataSocket(); // if necessary
        this.connection = new Connection(this.options, this.dataSocket);
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
        this.connection.remoteAddress = parts[1];
        this.connection.localAddress = parts[2];
        this.dataReceiver = new DataReceiver(this.options, this.connection);
        this.dataSocket.pipe(this.dataReceiver);
        this.isConnected = true;
        this.emit('connection', this.connection);
    }

    disconnectData(err) {
        if (err) this.log.debug(err, 'disconnectData');
        else this.log.debug('disconnectData', err);
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
