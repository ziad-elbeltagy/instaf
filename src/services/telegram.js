const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const logger = require('../utils/logger');

class TelegramService {
    constructor() {
        this.bot = null;
    }

    initialize() {
        if (this.bot) {
            logger.warn('Telegram bot is already initialized');
            return this.bot;
        }

        this.bot = new TelegramBot(config.TELEGRAM.BOT_TOKEN, { polling: true });
        logger.info('Telegram bot initialized');
        return this.bot;
    }

    getBot() {
        if (!this.bot) {
            return this.initialize();
        }
        return this.bot;
    }

    async stop() {
        if (this.bot) {
            try {
                await this.bot.stopPolling();
                this.bot = null;
                logger.info('Telegram bot stopped');
            } catch (error) {
                logger.error('Error stopping Telegram bot:', error);
                throw error;
            }
        }
    }
}

module.exports = new TelegramService();
