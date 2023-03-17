# node-vara
Communicate via radio in the style of
[node net](https://nodejs.org/docs/latest-v8.x/api/net.html),
using a
[VARA](https://rosmodem.wordpress.com/)
FM or HF modem.
```js
const VARA = require('@jmkristian/node-vara');
const Bunyan = require('bunyan');

var server = new VARA.Server ({
        host: 'vara-fm-server-host', // default: localhost
        port: 8300, // default: 8300
        dataPort: 8301, // default: port + 1
        logger: Bunyan.createLogger({name: 'VARA'}), /* default: no logging
            An object compatible with the Bunyan logger interface, or null. */
    },
    function onConnection(connection) { // handles 'connection' events
        console.log('connection'
                    + ' from ' + connection.theirCallSign
                    + ' to ' + connection.myCallSign);
        connection.write(...); // transmit data
        connection.pipe(...); // receive data
    });

server.listen({
        myCallSigns: ['A1CALL-1', 'B2CALL-10']  // This server's call signs.
    },
    function onListening(info) { // called when the server begins listening
        console.log('VARA listening ' + (info || ''));
    });
```
