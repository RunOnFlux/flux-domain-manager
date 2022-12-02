const fs = require('fs');
const path = require('path');

const logsDirPath = path.join(__dirname, '../../logs/');

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
    console.log(args);
    // write to file
    const filepath = `${logsDirPath}debug.log`;
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
    const filepath = `${logsDirPath}error.log`;
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
    const filepath = `${logsDirPath}warn.log`;
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
    const filepath = `${logsDirPath}info.log`;
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
    const filepath = `${logsDirPath}bugtrack.log`;
    writeToFile(filepath, args);
    debug(args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function bugtrackB(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${logsDirPath}bugtrackB.log`;
    writeToFile(filepath, args);
  } catch (err) {
    console.error('This shall not have happened');
    console.error(err);
  }
}

function bugtrackC(args) {
  try {
    // console.log(args);
    // write to file
    const filepath = `${logsDirPath}bugtrackC.log`;
    writeToFile(filepath, args);
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
  bugtrackB,
  bugtrackC,
};
