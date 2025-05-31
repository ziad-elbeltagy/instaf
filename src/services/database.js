const mongoose = require('mongoose');
const logger = require('../utils/logger');
const config = require('../config/config');

class DatabaseService {
    constructor() {
        this.isConnected = false;
    }

    async connect() {
        if (this.isConnected) {
            logger.warn('Already connected to MongoDB');
            return;
        }

        logger.info('Connecting to MongoDB...');
        try {
            await mongoose.connect(config.MONGODB.URI);
            
            this.isConnected = true;
            logger.info('Successfully connected to MongoDB');
            this._setupEventListeners();

        } catch (error) {
            logger.error('MongoDB connection failed:', error);
            throw error;
        }
    }

    async disconnect() {
        if (!this.isConnected) {
            logger.warn('Not connected to MongoDB');
            return;
        }

        try {
            await mongoose.disconnect();
            this.isConnected = false;
            logger.info('Disconnected from MongoDB');
        } catch (error) {
            logger.error('Error disconnecting from MongoDB:', error);
            throw error;
        }
    }

    _setupEventListeners() {
        mongoose.connection.on('error', err => {
            this.isConnected = false;
            logger.error('MongoDB connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            this.isConnected = false;
            logger.warn('MongoDB disconnected');
        });

        mongoose.connection.on('reconnected', () => {
            this.isConnected = true;
            logger.info('MongoDB reconnected');
        });
    }

    getConnectionState() {
        return {
            isConnected: this.isConnected,
            readyState: mongoose.connection.readyState
        };
    }
}

module.exports = DatabaseService;
