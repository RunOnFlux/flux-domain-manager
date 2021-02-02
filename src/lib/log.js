/* eslint no-console: ["error", { allow: ["warn", "error", "log"] }] */
module.exports = {
  error(...args) {
    console.error(...args);
  },

  warn(...args) {
    console.warn(...args);
  },

  info(...args) {
    console.log(...args);
  },

  debug(...args) {
    console.log(...args);
  },
};
