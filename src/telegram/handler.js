const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');
const config = require('../config/config');

class TelegramHandler {
    constructor(bot, monitorService) {
        this.bot = bot; // Using the injected bot instance
        this.monitorService = monitorService;
        this.authorizedUsers = config.TELEGRAM.AUTHORIZED_USERS;
    }

    _createAuthorizedHandler(commandRegex, handlerFn) {
        this.bot.onText(commandRegex, async (msg, match) => {
            const command = (match && match[0]) ? match[0].split(' ')[0] : 'UnknownCommand';
            logger.debug(`Received command: ${command} from user ${msg.from.id} in chat ${msg.chat.id}`);

            if (this.monitorService.isInitializing) {
                this.bot.sendMessage(msg.chat.id, "⏳ The bot is still starting up. Please try again in a moment.");
                return;
            }

            if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(msg.from.id)) {
                this.bot.sendMessage(msg.chat.id, '❌ You are not authorized to use this command.');
                logger.warn(`Unauthorized command attempt: ${command} by user ${msg.from.id} (@${msg.from.username || 'N/A'}) in chat ${msg.chat.id}.`);
                return;
            }

            try {
                await handlerFn(msg, match);
            } catch (e) {
                this._handleCommandError(e, msg, command);
            }
        });
    }

    setupHandlers() {
        this._setupStartCommand();
        this._setupHelpCommand();
        this._setupAddCommand();
        this._setupRemoveCommand();
        this._setupListCommand();
        this._setupStatusCommand();
        this._setupStatsCommand();
        this._setupCallbackQueryHandler();
        this._setupErrorHandlers();

        logger.info('Telegram command handlers and listeners set up.');
    }

    _setupStartCommand() {
        this._createAuthorizedHandler(/\/start$/, (msg) => {
            this.bot.sendMessage(msg.chat.id, "🤖 *Instagram Profile Monitor Bot*\n\nI automatically monitor Instagram accounts for changes. Use /help to see available commands.", { parse_mode: 'Markdown' });
        });
    }

    _setupHelpCommand() {
        this._createAuthorizedHandler(/\/help$/, (msg) => {
            const helpMsg = `
🤖 *Instagram Follower Monitor - Help*

Monitoring is automatic once accounts are added.

Available commands:
/add \`username\` - Add an Instagram account to monitor.
/remove \`username\` - Remove an account from monitoring.
/list - Show all accounts monitored in this chat.
/status - Display the bot's current operational status.
/stats \`username\` (optional) - Get follower statistics for an account.

Stories from monitored accounts are automatically checked every hour.

Example: \`/add instagram\` or simply \`/stats\`
            `;
            this.bot.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'Markdown' });
        });
    }

    _setupAddCommand() {
        this._createAuthorizedHandler(/\/add (.+)/, async (msg, match) => {
            const username = match[1].trim().replace('@', '').toLowerCase();
            await this.monitorService.addAccount(username, msg.chat.id.toString(), msg.from.id.toString());
        });
    }

    _setupRemoveCommand() {
        this._createAuthorizedHandler(/\/remove (.+)/, async (msg, match) => {
            const username = match[1].trim().replace('@', '').toLowerCase();
            await this.monitorService.removeAccount(username, msg.chat.id.toString());
        });
    }

    _setupListCommand() {
        this._createAuthorizedHandler(/\/list$/, async (msg) => {
            await this.monitorService.listAccounts(msg.chat.id.toString());
        });
    }

    _setupStatusCommand() {
        this._createAuthorizedHandler(/\/status$/, (msg) => {
            this.monitorService.getStatus(msg.chat.id);
        });
    }

    _setupStatsCommand() {
        this._createAuthorizedHandler(/\/stats(?: (.+))?$/, async (msg, match) => {
            const username = match[1] ? match[1].trim().replace('@', '').toLowerCase() : null;
            await this.monitorService.getStats(msg.chat.id.toString(), username);
        });
    }

    _setupCallbackQueryHandler() {
        this.bot.on('callback_query', async (callbackQuery) => {
            const msg = callbackQuery.message;
            const data = callbackQuery.data;
            const chatId = msg.chat.id.toString();
            const fromUserId = callbackQuery.from.id;

            await this.bot.answerCallbackQuery(callbackQuery.id);

            if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(fromUserId)) {
                logger.warn(`Unauthorized callback_query attempt: Data='${data}' by user ${fromUserId} in chat ${chatId}.`);
                return;
            }

            if (data.startsWith('stats_')) {
                const username = data.substring('stats_'.length);
                await this.monitorService.handleStatsCallback(username, chatId, msg);
            }
        });
    }

    _setupErrorHandlers() {
        this.bot.on('polling_error', (error) => logger.error('Telegram Polling Error:', error));
        this.bot.on('webhook_error', (error) => logger.error('Telegram Webhook Error:', error));
        this.bot.on('error', (error) => logger.error('General Telegram Bot Error:', error));
    }

    _handleCommandError(error, msg, command) {
        logger.error(`Handler error for command ${command} (User: ${msg.from.id}, Chat: ${msg.chat.id}):`, error);
        
        let userErrorMessage = '⚠️ An unexpected error occurred while processing your command. Please try again.';
        if (error.name === 'MongoServerError' && error.code === 11000) {
            userErrorMessage = '⚠️ This Instagram account might already be monitored in this chat.';
        } else if (error.message.includes('timed out')) {
            userErrorMessage = '⏳ The operation timed out. Please try again later.';
        }

        this.bot.sendMessage(msg.chat.id, userErrorMessage).catch(sendErr => {
            logger.error(`Failed to send error message to chat ${msg.chat.id}:`, sendErr);
        });
    }
}

module.exports = TelegramHandler;
