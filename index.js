const express = require('express');
const http = require('http');
const Bot = require('./src/Bot');
const logger = require('./src/utils/logger');

// Load environment variables
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// --- Global Error Handlers (for the server process) ---
// These should be set up early.
process.on('unhandledRejection', (reason, promise) => {
    logger.error('FATAL: Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    logger.error('FATAL: Uncaught Exception:', error);
    process.exit(1);
});


// --- Main Application Logic ---
async function main() {
    const app = express();
    let botInstance;
    let isShuttingDown = false;  // Add shutdown flag

    try {
        botInstance = new Bot();
        await botInstance.initialize();
    } catch (error) {
        logger.error('CRITICAL: Failed to initialize bot:', error);
        process.exit(1);
    }

    // Express Routes
    app.get('/', (req, res) => {
        res.send('Instagram Follower Monitor Bot is running.');
    });

    app.get('/health', async (req, res) => {
        if (!botInstance) {
            return res.status(503).json({ 
                status: 'DOWN', 
                message: 'Bot instance not available',
                timestamp: new Date().toISOString()
            });
        }

        const health = await botInstance.getHealthStatus();
        const statusCode = health.status === 'UP' ? 200 : 503;
        res.status(statusCode).json(health);
    });

    // Start HTTP Server
    const server = http.createServer(app);

    server.listen(PORT, () => {
        logger.info(`HTTP server listening on port ${PORT}`);
    });

    // Graceful Shutdown Logic
    const gracefulShutdown = async (signal) => {
        if (isShuttingDown) {
            logger.info(`Received ${signal} but shutdown already in progress. Ignoring.`);
            return;
        }
        isShuttingDown = true;
        logger.info(`Received ${signal}. Starting graceful shutdown...`);

        server.close(async (err) => {
            if (err) {
                logger.error('Error closing HTTP server:', err);
            } else {
                logger.info('HTTP server closed.');
            }

            if (botInstance) {
                try {
                    await botInstance.gracefulShutdown();
                    process.exit(0);
                } catch (error) {
                    logger.error('Error during bot shutdown:', error);
                    process.exit(1);
                }
            } else {
                process.exit(0);
            }
        });

        // Force shutdown after timeout
        setTimeout(() => {
            logger.error('Could not close connections in time, forcefully shutting down');
            process.exit(1);
        }, 20000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// --- Run the Application ---
main().catch(error => {
    console.error(`${LOG_PREFIX} CRITICAL: Unhandled error in main application function:`, error);
    process.exit(1);
});