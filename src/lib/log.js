const fs = require('fs');
const path = require('path');

const homeDirPath = path.join(__dirname, '../../');

function getFilesizeInBytes(filename) {
  try {
    const stats = fs.statSync(filename);
    const fileSizeInBytes = stats.size;
    return fileSizeInBytes;
  } catch (e) {
    console.log(e);
    return 0;
  }
}

function ensureString(parameter) {
  return typeof parameter === 'string' ? parameter : JSON.stringify(parameter);
}

function writeToFile(filepath, args) {
  // this function was raising if args are undefined or null, i.e. no message propery.
  // This isn't the best, as you can no longer log an empty line, however we should
  // replace this module with a standard logging module, like pino.
  if (!args) return;

  const size = getFilesizeInBytes(filepath);
  let flag = 'a+';
  if (size > (25 * 1024 * 1024)) { // 25MB
    flag = 'w'; // rewrite file
  }
  const stream = fs.createWriteStream(filepath, { flags: flag });
  stream.write(`${new Date().toISOString()}          ${ensureString(args.message || args)}\n`);
  if (args.stack && typeof args.stack === 'string') {
    stream.write(`${args.stack}\n`);
  }
  stream.end();
}

function debug(args) {
  try {
    // we are already logging to file. Don't log to console, as it hides
    // all the actual calls to console.log
    // console.log(args);
    // write to file
    const filepath = `${homeDirPath}debug.log`;
    writeToFile(filepath, args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function error(args) {
  try {
    // console.error(args);
    // write to file
    const filepath = `${homeDirPath}error.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function warn(args) {
  try {
    // console.warn(args);
    // write to file
    const filepath = `${homeDirPath}warn.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function info(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${homeDirPath}info.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function bugtrack(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${homeDirPath}bugtrack.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

module.exports = {
  error,
  warn,
  info,
  debug,
  bugtrack,
};
