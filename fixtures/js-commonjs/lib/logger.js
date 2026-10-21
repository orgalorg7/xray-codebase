const { formatDate } = require("./format");

class Logger {
  constructor(prefix) {
    this.prefix = prefix;
  }

  log(message) {
    console.log(`[${formatDate(new Date())}] ${this.prefix}: ${message}`);
  }
}

module.exports = Logger;
