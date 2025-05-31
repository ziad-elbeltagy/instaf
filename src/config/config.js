// External Dependencies
require('dotenv').config();

const config = {
    LOG_PREFIX: '[InstaBot]',
    MONGODB: {
        URI: process.env.MONGODB_URI,
    },
    TELEGRAM: {
        BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        AUTHORIZED_USERS: new Set(
            process.env.TELEGRAM_AUTHORIZED_USERS
                ? process.env.TELEGRAM_AUTHORIZED_USERS.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
                : []
        )
    },
    API: {
        TIMEOUT_MS: parseInt(process.env.API_TIMEOUT_MS || '15000', 10),
        IMAGE_FETCH_TIMEOUT_MS: parseInt(process.env.IMAGE_FETCH_TIMEOUT_MS || '10000', 10),
        REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '1500', 10),
        CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10),
        INSTAGRAM_API_URL_BASE: process.env.INSTAGRAM_API_URL_BASE || "https://fanhub.pro/tucktools_user"
    }
};

module.exports = config;
