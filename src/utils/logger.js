const { LOG_PREFIX } = require('../config/config');

const logger = {
    info: (message, ...args) => console.log(`${LOG_PREFIX} INFO: ${message}`, ...args),
    warn: (message, ...args) => console.warn(`${LOG_PREFIX} WARN: ${message}`, ...args),
    error: (message, ...args) => console.error(`${LOG_PREFIX} ERROR: ${message}`, ...args),
    debug: (message, ...args) => {
        if (process.env.DEBUG === 'true' || process.env.DEBUG === 'insta-bot') {
            console.debug(`${LOG_PREFIX} DEBUG: ${message}`, ...args);
        }
    }
};

module.exports = logger;
