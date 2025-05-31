const logger = require('./utils/logger');
const config = require('./config/config');
const DatabaseService = require('./services/database');
const InstagramService = require('./services/instagram');
const MonitorService = require('./services/monitor');
const TelegramHandler = require('./telegram/handler');
const telegramService = require('./services/telegram');

class Bot {
    constructor() {
        this.isInitializing = true;
        this._initializeServices();
    }

    _initializeServices() {
        // Initialize services
        this.databaseService = new DatabaseService();
        this.instagramService = new InstagramService();
        
        // Initialize Telegram bot first
        const bot = telegramService.initialize();
        
        // Initialize services that need the bot instance
        this.monitorService = new MonitorService(this.instagramService, bot);
        this.telegramHandler = new TelegramHandler(bot, this.monitorService);
    }

    async initialize() {
        try {
            logger.info('Starting bot initialization...');

            // Connect to MongoDB first
            await this.databaseService.connect();
            logger.info('Database connection established');

            // Set up Telegram command handlers before starting monitoring
            this.telegramHandler.setupHandlers();
            logger.info('Telegram handlers configured');

            // Clear initialization flag before starting monitoring
            this.isInitializing = false;
            logger.info('Bot initialization completed');

            // Start monitoring last
            logger.info('Starting monitoring service...');
            await this.monitorService.start();
            logger.info('Monitoring service started successfully');
            
        } catch (error) {
            logger.error('Bot initialization failed:', error);
            throw error;
        }
    }

    async gracefulShutdown() {
        logger.info("Starting graceful shutdown...");
        
        try {
            // Stop monitoring first
            await this.monitorService.stop();
            logger.info("Monitoring stopped.");

            // Stop Telegram polling
            await telegramService.stop();
            logger.info("Telegram service stopped.");

            // Close MongoDB connection last
            await this.databaseService.disconnect();
            logger.info("Database disconnected.");

            logger.info("Graceful shutdown completed.");
        } catch (error) {
            logger.error("Error during shutdown:", error);
            throw error;
        }
    }

    async getHealthStatus() {
        const dbState = this.databaseService.getConnectionState();
        
        return {
            status: this.isInitializing ? 'INITIALIZING' : 
                    (dbState.isConnected && this.monitorService.isRunning) ? 'UP' : 'DOWN',
            components: {
                database: {
                    status: dbState.isConnected ? 'UP' : 'DOWN',
                    details: {
                        readyState: dbState.readyState
                    }
                },
                monitor: {
                    status: this.monitorService.isRunning ? 'UP' : 'DOWN',
                    details: {
                        isInitializing: this.monitorService.isInitializing,
                        checkInterval: this.monitorService.options.checkInterval
                    }
                }
            },
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = Bot;
