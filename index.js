const express = require('express');
const http = require('http'); // For graceful shutdown of the HTTP server
const InstagramFollowerBot = require('./bot'); // Adjust path if your bot class is elsewhere

// Load environment variables
require('dotenv').config();

const PORT = process.env.PORT || 3000; // Port for the Express server
const LOG_PREFIX = '[InstaBot-Server]';

// --- Global Error Handlers (for the server process) ---
// These should be set up early.
process.on('unhandledRejection', (reason, promise) => {
    console.error(`${LOG_PREFIX} FATAL: Unhandled Rejection at:`, promise, 'reason:', reason);
    // Implement a more robust shutdown or restart strategy for production
    // For now, log and exit to prevent undefined state.
    // Consider if botInstance needs to be gracefully shut down here too.
    process.exit(1); // Or trigger bot.gracefulShutdown() if botInstance is accessible
});

process.on('uncaughtException', (error) => {
    console.error(`${LOG_PREFIX} FATAL: Uncaught Exception:`, error);
    // Implement a more robust shutdown or restart strategy for production
    process.exit(1); // Or trigger bot.gracefulShutdown()
});


// --- Main Application Logic ---
async function main() {
    const app = express();

    // --- Initialize the Bot ---
    // The bot will start its own monitoring logic internally upon successful initialization
    let botInstance;
    try {
        botInstance = new InstagramFollowerBot();
        // Wait for the bot's internal initialization to complete, especially if it's async
        // and you need to ensure it's ready before the server claims to be "healthy".
        // We can add a promise to the bot's _initialize method or check a flag.
        // For now, we assume bot initialization logs its status.
        // The bot's _initialize method already calls its start() method.
    } catch (botError) {
        console.error(`${LOG_PREFIX} CRITICAL: Failed to instantiate InstagramFollowerBot:`, botError.message, botError.stack);
        process.exit(1); // Cannot continue if bot fails to instantiate
    }

    // --- Express Routes ---
    app.get('/', (req, res) => {
        res.send('Instagram Follower Monitor Bot is running.');
    });

    app.get('/health', (req, res) => {
        // More sophisticated health checks could be added here:
        // - Check MongoDB connection (mongoose.connection.readyState)
        // - Check if the bot's monitoring loop (botInstance.isRunning) is active
        if (botInstance && !botInstance.isInitializing && botInstance.isRunning) {
            res.status(200).json({ status: 'UP', message: 'Bot is monitoring.' });
        } else if (botInstance && botInstance.isInitializing) {
            res.status(503).json({ status: 'INITIALIZING', message: 'Bot is initializing.' });
        }
        else {
            res.status(503).json({ status: 'DOWN', message: 'Bot may not be operational or is not running its monitoring loop.' });
        }
    });

    // --- Start the HTTP Server ---
    const server = http.createServer(app);

    server.listen(PORT, () => {
        console.log(`${LOG_PREFIX} HTTP server listening on port ${PORT}`);
        console.log(`${LOG_PREFIX} Bot is expected to be running its monitoring tasks.`);
    });

    server.on('error', (error) => {
        if (error.syscall !== 'listen') {
            throw error;
        }
        const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;
        switch (error.code) {
            case 'EACCES':
                console.error(`${LOG_PREFIX} ${bind} requires elevated privileges`);
                process.exit(1);
                break;
            case 'EADDRINUSE':
                console.error(`${LOG_PREFIX} ${bind} is already in use`);
                process.exit(1);
                break;
            default:
                throw error;
        }
    });

    // --- Graceful Shutdown Logic ---
    const gracefulShutdownServer = (signal) => {
        console.log(`\n${LOG_PREFIX} Received ${signal}. Starting graceful shutdown...`);

        // 1. Stop the HTTP server from accepting new connections
        console.log(`${LOG_PREFIX} Closing HTTP server...`);
        server.close(async (err) => {
            if (err) {
                console.error(`${LOG_PREFIX} Error closing HTTP server:`, err);
            } else {
                console.log(`${LOG_PREFIX} HTTP server closed.`);
            }

            // 2. Gracefully shut down the bot (stops monitoring, disconnects DB)
            if (botInstance) {
                console.log(`${LOG_PREFIX} Shutting down the bot instance...`);
                await botInstance.gracefulShutdown(); // This method now handles its own exit(0)
            } else {
                console.log(`${LOG_PREFIX} No bot instance to shut down. Exiting.`);
                process.exit(0);
            }
            // botInstance.gracefulShutdown() will call process.exit(0)
        });

        // If server doesn't close in time, force shut down
        setTimeout(() => {
            console.error(`${LOG_PREFIX} Could not close connections in time, forcefully shutting down.`);
            if (botInstance) {
                 botInstance.gracefulShutdown().finally(() => process.exit(1));
            } else {
                process.exit(1);
            }
        }, 20000); // 20 seconds timeout
    };

    process.on('SIGTERM', () => gracefulShutdownServer('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdownServer('SIGINT')); // Ctrl+C
}

// --- Run the Application ---
main().catch(error => {
    console.error(`${LOG_PREFIX} CRITICAL: Unhandled error in main application function:`, error);
    process.exit(1);
});