const Logger = require("./lib/logger");
const format = require("./lib/format");

function run() {
  const logger = new Logger("app");
  logger.log(format.pad(7, 3));
}

run();
