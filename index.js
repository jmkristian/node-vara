'use strict';
const server = require('./server.js');

/** Communicate via AX.25 in the style of node net, using an AGWPE-compatible TNC. */

exports.Server = server.Server;
exports.HF = 'HF';
exports.FM = 'FM';
