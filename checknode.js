const process = require('process');

const version = process.versions.node;
const parts = version.split('.').map(s => parseInt(s));
var exitCode = 0;
if (parts[0] % 2 == 1) {
    console.log("Tests require an even-numbered node version (not " + parts[0] + ").");
    ++exitCode;
}
if (parts[0] < 12 || (parts[0] == 12 && parts[1] < 17)) {
    console.log("Tests require node version 12.17 or later (not " + process.versions.node + ").");
    ++exitCode;
}
process.exit(exitCode);
