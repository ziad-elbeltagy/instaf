// External Dependencies
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios'); // For fetching image data
const crypto = require('crypto'); // For hashing

// Load environment variables from .env file
require('dotenv').config();

// --- Constants and Configuration ---
const LOG_PREFIX = '[InstaBot]';
const MONGODB_URI = process.env.MONGODB_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_AUTHORIZED_USERS_RAW = process.env.TELEGRAM_AUTHORIZED_USERS;

const DEFAULT_API_TIMEOUT_MS = 15000;
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_REQUEST_DELAY_MS = 1500; // Delay between processing accounts in a cycle
const DEFAULT_CHECK_INTERVAL_MS = 60000; // 1 minute

// --- Mongoose Schemas and Models ---
const MonitoredUserSchema = new mongoose.Schema({
  username: { type: String, required: true, lowercase: true, index: true },
  chatId: { type: String, required: true, index: true }, // Telegram chat ID
  addedByUserId: { type: String, required: true },   // Telegram user ID who added
}, { timestamps: true }); // Adds createdAt and updatedAt
MonitoredUserSchema.index({ username: 1, chatId: 1 }, { unique: true });
const MonitoredUser = mongoose.model('MonitoredUser', MonitoredUserSchema);

const FollowerHistorySchema = new mongoose.Schema({
  username: { type: String, required: true, lowercase: true, index: true },
  scrapedUsername: { type: String, lowercase: true }, // Username as returned by API
  userFullname: String,
  userDescription: String, // Bio
  userProfilePic: String,  // URL of the profile picture
  userProfilePicHash: String, // MD5 hash of the profile picture content
  isPrivate: Boolean,
  followersCount: Number,
  followingCount: Number,
  postsCount: Number,
  isVerified: Boolean,
  // rawFollowers, etc., are stringified numbers from API for historical consistency if needed
  rawFollowers: String,
  rawFollowing: String,
  rawPosts: String,
  apiResponseJson: mongoose.Schema.Types.Mixed, // Store the raw API response for auditing
}, { timestamps: { createdAt: true, updatedAt: false } }); // Only createdAt for history records
FollowerHistorySchema.index({ username: 1, createdAt: -1 }); // For efficient history queries
const FollowerHistory = mongoose.model('FollowerHistory', FollowerHistorySchema);

/**
 * @class InstagramFollowerBot
 * @description Monitors Instagram user profiles for changes using an external API and notifies Telegram users.
 */
class InstagramFollowerBot {
  /**
   * Initializes the bot with provided options or environment variables.
   * @param {object} options - Configuration options for the bot.
   */
  constructor(options = {}) {
    this.logger = {
        info: (message, ...args) => console.log(`${LOG_PREFIX} INFO: ${message}`, ...args),
        warn: (message, ...args) => console.warn(`${LOG_PREFIX} WARN: ${message}`, ...args),
        error: (message, ...args) => console.error(`${LOG_PREFIX} ERROR: ${message}`, ...args),
        debug: (message, ...args) => { // Only log debug if DEBUG env var is set
            if (process.env.DEBUG === 'true' || process.env.DEBUG === 'insta-bot') {
                console.debug(`${LOG_PREFIX} DEBUG: ${message}`, ...args);
            }
        }
    };

    this.options = {
      apiTimeout: options.apiTimeout ?? parseInt(process.env.API_TIMEOUT_MS || DEFAULT_API_TIMEOUT_MS.toString(), 10),
      imageFetchTimeout: options.imageFetchTimeout ?? parseInt(process.env.IMAGE_FETCH_TIMEOUT_MS || DEFAULT_IMAGE_FETCH_TIMEOUT_MS.toString(), 10),
      requestDelay: options.requestDelay ?? parseInt(process.env.REQUEST_DELAY_MS || DEFAULT_REQUEST_DELAY_MS.toString(), 10),
      checkInterval: options.checkInterval ?? parseInt(process.env.CHECK_INTERVAL_MS || DEFAULT_CHECK_INTERVAL_MS.toString(), 10),
      // Add other options as needed, e.g., API endpoint URL if it becomes configurable
      instagramApiUrlBase: process.env.INSTAGRAM_API_URL_BASE || "https://fanhub.pro/tucktools_user",
      ...options
    };

    this.mongodbUri = options.mongodbUri || MONGODB_URI;
    if (!this.mongodbUri) {
        this.logger.error("MongoDB URI (MONGODB_URI) is not configured. Exiting.");
        throw new Error("MongoDB URI is required.");
    }

    this.telegramToken = options.telegramToken || TELEGRAM_BOT_TOKEN;
    if (!this.telegramToken) {
        this.logger.error("Telegram Bot Token (TELEGRAM_BOT_TOKEN) is not configured. Exiting.");
        throw new Error("Telegram Bot Token is required.");
    }
    this.bot = new TelegramBot(this.telegramToken, { polling: true });

    this.authorizedUsers = new Set(
      TELEGRAM_AUTHORIZED_USERS_RAW
        ? TELEGRAM_AUTHORIZED_USERS_RAW.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
        : []
    );
    if (this.authorizedUsers.size > 0) {
        this.logger.info(`Authorization enabled for user IDs: ${[...this.authorizedUsers].join(', ')}`);
    } else {
        this.logger.warn("Authorization is not configured. All users will have access.");
    }

    this.isRunning = false;
    this.intervalId = null;
    this.isInitializing = true;

    this.MonitoredUser = MonitoredUser;
    this.FollowerHistory = FollowerHistory;

    this._initialize();
  }

  /**
   * Asynchronously initializes the bot's database connection and Telegram handlers.
   * Starts the monitoring process upon successful initialization.
   * @private
   */
  async _initialize() {
    try {
      await this._initializeDatabase();
      this._setupTelegramHandlers();
      this.isInitializing = false;
      this.logger.info('Bot initialized successfully.');
      this.logger.info(`Monitoring check interval: ${this.options.checkInterval / 1000} seconds.`);
      this.logger.info(`Delay between account checks: ${this.options.requestDelay} ms.`);
      await this.start(); // Automatically start monitoring
    } catch (error) {
      this.logger.error('Bot initialization failed:', error.message, error.stack);
      process.exit(1); // Exit if initialization fails critically
    }
  }

  /**
   * Connects to the MongoDB database.
   * @private
   */
  async _initializeDatabase() {
    this.logger.info('Connecting to MongoDB...');
    try {
      await mongoose.connect(this.mongodbUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        // serverSelectionTimeoutMS: 5000, // Mongoose default is 30000ms
        // connectTimeoutMS: 10000       // Mongoose default is 30000ms
      });
      this.logger.info('Successfully connected to MongoDB.');

      mongoose.connection.on('error', err => this.logger.error('MongoDB connection error after initial setup:', err));
      mongoose.connection.on('disconnected', () => this.logger.warn('MongoDB disconnected.'));
      mongoose.connection.on('reconnected', () => this.logger.info('MongoDB reconnected.'));

    } catch (error) {
      this.logger.error('Initial MongoDB connection failed:', error.message);
      throw error; // Re-throw to be caught by _initialize
    }
  }

  /**
   * Creates a wrapper for Telegram command handlers to include authorization and error handling.
   * @param {RegExp} commandRegex - The regex to match the command.
   * @param {Function} handlerFn - The async function to execute for the command.
   * @private
   */
  _createAuthorizedHandler(commandRegex, handlerFn) {
    this.bot.onText(commandRegex, async (msg, match) => {
      const command = (match && match[0]) ? match[0].split(' ')[0] : 'UnknownCommand';
      this.logger.debug(`Received command: ${command} from user ${msg.from.id} in chat ${msg.chat.id}`);

      if (this.isInitializing) {
        this.bot.sendMessage(msg.chat.id, "⏳ The bot is still starting up. Please try again in a moment.");
        return;
      }

      if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(msg.from.id)) {
        this.bot.sendMessage(msg.chat.id, '❌ You are not authorized to use this command.');
        this.logger.warn(`Unauthorized command attempt: ${command} by user ${msg.from.id} (@${msg.from.username || 'N/A'}) in chat ${msg.chat.id}.`);
        return;
      }

      try {
        await handlerFn(msg, match);
      } catch (e) {
        this.logger.error(`Handler error for command ${command} (User: ${msg.from.id}, Chat: ${msg.chat.id}):`, e.message, e.stack);
        let userErrorMessage = `⚠️ An unexpected error occurred while processing your command. Please try again.`;
        if (e.name === 'MongoServerError' && e.code === 11000) { // Duplicate key
            userErrorMessage = `⚠️ This Instagram account might already be monitored in this chat, or another unique data constraint was violated.`;
        } else if (e.message.includes('timed out')) { // Custom check for timeout messages
            userErrorMessage = `⏳ The operation timed out. Please try again later.`;
        }
        // Avoid sending technical details to the user unless it's a known, safe error
        this.bot.sendMessage(msg.chat.id, userErrorMessage).catch(sendErr => {
            this.logger.error(`Failed to send error message to chat ${msg.chat.id}:`, sendErr.message);
        });
      }
    });
  }

  /**
   * Sets up all Telegram command handlers and the callback query listener.
   * @private
   */
  _setupTelegramHandlers() {
    this.logger.info('Setting up Telegram command handlers...');

    this._createAuthorizedHandler(/\/start$/, (msg) => {
      this.bot.sendMessage(msg.chat.id, "🤖 *Instagram Profile Monitor Bot*\n\nI automatically monitor Instagram accounts for changes. Use /help to see available commands.", { parse_mode: 'Markdown' });
    });

    this._createAuthorizedHandler(/\/help$/, (msg) => {
      const helpMsg = `
🤖 *Instagram Follower Monitor - Help*

Monitoring is automatic once accounts are added.

Available commands:
/add \`username\` - Add an Instagram account to monitor.
/remove \`username\` - Remove an account from monitoring.
/list - Show all accounts monitored in this chat.
/status - Display the bot's current operational status.
/stats \`username\` (optional) - Get follower statistics for an account. If no username is provided, I'll list monitored accounts for you to choose from.
/help - Show this help message.

Example: \`/add instagram\` or simply \`/stats\`
      `;
      this.bot.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'Markdown' });
    });

    this._createAuthorizedHandler(/\/add (.+)/, async (msg, match) => {
        const username = match[1].trim().replace('@', '').toLowerCase();
        const chatId = msg.chat.id.toString();
        const userId = msg.from.id.toString();

        if (!username) {
            return this.bot.sendMessage(chatId, '⚠️ Please provide a username. Usage: /add `username`');
        }
        if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) { // Basic username validation
            return this.bot.sendMessage(chatId, '⚠️ Invalid Instagram username format.');
        }

        const existing = await this.MonitoredUser.findOne({ username, chatId });
        if (existing) {
            return this.bot.sendMessage(chatId, `ℹ️ @${username} is already being monitored in this chat.`);
        }

        await new this.MonitoredUser({ username, chatId, addedByUserId: userId }).save();
        this.logger.info(`User @${username} added for monitoring in chat ${chatId} by user ${userId}.`);
        this.bot.sendMessage(chatId, `✅ @${username} added to monitoring list. Performing an initial check...`);
        await this.checkSingleAccount(username); // Perform initial check
    });

    this._createAuthorizedHandler(/\/remove (.+)/, async (msg, match) => {
        const username = match[1].trim().replace('@', '').toLowerCase();
        const chatId = msg.chat.id.toString();
        if (!username) return this.bot.sendMessage(chatId, '⚠️ Usage: /remove `username`');

        const result = await this.MonitoredUser.deleteOne({ username, chatId });
        if (result.deletedCount > 0) {
            this.logger.info(`User @${username} removed from monitoring in chat ${chatId}.`);
            this.bot.sendMessage(chatId, `✅ @${username} has been removed from the monitoring list for this chat.`);
        } else {
            this.bot.sendMessage(chatId, `⚠️ @${username} was not found in your monitoring list for this chat.`);
        }
    });

    this._createAuthorizedHandler(/\/list$/, async (msg) => {
        const chatId = msg.chat.id.toString();
        const users = await this.MonitoredUser.find({ chatId }).sort({ username: 1 }); // Sort by username

        if (!users.length) {
            return this.bot.sendMessage(chatId, '📝 No accounts are currently being monitored in this chat. Use /add to add one!');
        }
        const userList = users.map((user, index) => `${index + 1}. @${user.username}`).join('\n');
        this.bot.sendMessage(chatId, `📋 *Monitored Accounts in this Chat (${users.length}):*\n\n${userList}`, { parse_mode: 'Markdown' });
    });

    this._createAuthorizedHandler(/\/status$/, (msg) => {
        const statusMessage = this.isRunning ? '🟢 Actively Monitoring' : '🟡 Initializing or an issue occurred (intended to be monitoring)';
        let nextCheckInfo = 'Periodic checks are scheduled.';
        if (this.isRunning && this.intervalId) {
            const intervalSeconds = Math.round(this.options.checkInterval / 1000);
            nextCheckInfo = `Checks occur approximately every ${intervalSeconds} seconds.`;
        } else if (!this.isRunning && !this.isInitializing) {
            nextCheckInfo = "⚠️ WARNING: Monitoring loop is not currently active. Please check server logs.";
        } else if (this.isInitializing) {
            nextCheckInfo = "Bot is currently initializing.";
        }
        this.bot.sendMessage(msg.chat.id, `📊 *Bot Status*\n\nOperational Status: ${statusMessage}\n${nextCheckInfo}`, { parse_mode: 'Markdown' });
    });

    this._createAuthorizedHandler(/\/stats(?: (.+))?$/, async (msg, match) => {
        const chatId = msg.chat.id.toString();
        const usernameParam = match[1] ? match[1].trim().replace('@', '').toLowerCase() : null;

        if (usernameParam) {
            await this.sendAccountStats(chatId, usernameParam);
        } else {
            const monitoredAccounts = await this.MonitoredUser.find({ chatId }).sort({ username: 1 });
            if (!monitoredAccounts.length) {
                return this.bot.sendMessage(chatId, '📝 You are not monitoring any accounts in this chat. Use /add `username` to get started.');
            }
            const inlineKeyboard = monitoredAccounts.map(acc => ([
                { text: `@${acc.username}`, callback_data: `stats_${acc.username}` }
            ]));
             if (inlineKeyboard.length > 0) {
                 this.bot.sendMessage(chatId, '👇 Please choose an account to view statistics for:', {
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
            } else { // Should ideally not be reached if monitoredAccounts.length > 0
                 this.bot.sendMessage(chatId, 'ℹ️ No monitored accounts found to select for stats.');
            }
        }
    });

    // Callback query handler for inline keyboard (e.g., from /stats)
    this.bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data; // e.g., "stats_username"
        const chatId = msg.chat.id.toString();
        const fromUserId = callbackQuery.from.id;

        this.logger.debug(`Received callback_query: Data='${data}', FromUser=${fromUserId}, Chat=${chatId}`);

        // Always answer callback query promptly to remove "loading" state on client
        this.bot.answerCallbackQuery(callbackQuery.id).catch(e => this.logger.warn(`Failed to answer callback query ${callbackQuery.id}:`, e.message));

        // Authorization check for callback query (important if chat is a group)
        if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(fromUserId)) {
            this.logger.warn(`Unauthorized callback_query attempt: Data='${data}' by user ${fromUserId} in chat ${chatId}.`);
            // Optionally send a private message to the user if bot can initiate it, or just ignore.
            return;
        }

        if (data.startsWith('stats_')) {
            const username = data.substring('stats_'.length);
            this.logger.info(`Processing stats callback for @${username} in chat ${chatId}.`);
            try {
                // Edit the original message to remove the keyboard and indicate action
                if (msg) { // msg might be undefined if the original message was deleted
                    this.bot.editMessageText(`⏳ Fetching statistics for @${username}...`, {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        reply_markup: { inline_keyboard: [] } // Remove keyboard
                    }).catch(e => this.logger.warn(`Minor: Could not edit message (ID: ${msg.message_id}) to remove keyboard:`, e.message));
                }
                await this.sendAccountStats(chatId, username); // Sends a new message with the stats
            } catch (e) {
                this.logger.error(`Error handling stats callback for @${username}:`, e.message, e.stack);
                this.bot.sendMessage(chatId, `❌ Sorry, an error occurred while fetching stats for @${username}.`).catch(sendErr => this.logger.error(`Failed to send error for stats callback to ${chatId}:`, sendErr.message));
            }
        }
    });

    // Global error listeners for the bot
    this.bot.on('polling_error', (error) => this.logger.error('Telegram Polling Error:', error.code, error.message, error.stack));
    this.bot.on('webhook_error', (error) => this.logger.error('Telegram Webhook Error:', error.code, error.message, error.stack));
    this.bot.on('error', (error) => this.logger.error('General Telegram Bot Library Error:', error.message, error.stack)); // Catch-all for other node-telegram-bot-api errors

    this.logger.info('Telegram command handlers and listeners set up.');
  }

  /**
   * Sends formatted statistics for a given Instagram username to a chat.
   * @param {string} chatId - The Telegram chat ID to send the message to.
   * @param {string} username - The Instagram username.
   */
  async sendAccountStats(chatId, username) {
    this.logger.debug(`Fetching stats for @${username} for chat ${chatId}.`);
    const history = await this.FollowerHistory.find({ username })
        .sort({ createdAt: -1 })
        .limit(10); // Get up to 10 most recent records for trend

    let statsText;
    if (!history || history.length === 0) {
        statsText = `📊 No historical data found for @${username}. Has it been checked yet?`;
    } else {
        const latest = history[0];
        const oldest = history.length > 1 ? history[history.length - 1] : latest; // Handle case of single history entry
        const followerChange = (latest.followersCount || 0) - (oldest.followersCount || 0);
        const changeIcon = followerChange > 0 ? '📈' : followerChange < 0 ? '📉' : '➖';

        statsText = `📊 *Statistics for @${username}*\n\n`;
        if (latest.userFullname) statsText += `👤 *Name:* ${latest.userFullname}\n`;
        statsText += `👥 *Followers:* ${latest.followersCount?.toLocaleString() || 'N/A'}\n`;
        statsText += `➡️ *Following:* ${latest.followingCount?.toLocaleString() || 'N/A'}\n`;
        statsText += `📝 *Posts:* ${latest.postsCount?.toLocaleString() || 'N/A'}\n`;
        statsText += `✅ *Verified:* ${latest.isVerified ? 'Yes' : 'No'}\n`;
        statsText += `${latest.isPrivate ? '🔒 Private Account' : '🌎 Public Account'}\n`;
        if (latest.userDescription) {
            const bioSnippet = latest.userDescription.replace(/\n/g, ' ').substring(0, 70); // Max 70 chars, newlines to spaces
            statsText += `📜 *Bio:* ${bioSnippet}${latest.userDescription.length > 70 ? '...' : ''}\n`;
        }
        if (history.length > 1) {
            statsText += `\n${changeIcon} *Change (last ${history.length} checks):* ${followerChange > 0 ? '+' : ''}${followerChange.toLocaleString()} followers\n`;
        }
        statsText += `\n🕒 *Last Checked:* ${new Date(latest.createdAt).toLocaleString()}`;
    }
    
    this.bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' }).catch(e => {
        this.logger.error(`Failed to send stats message to chat ${chatId} for @${username}:`, e.message);
    });
  }

  /**
   * Delays execution for a specified number of milliseconds.
   * @param {number} ms - Milliseconds to delay.
   * @returns {Promise<void>}
   * @private
   */
  async _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Fetches Instagram user data from the external API.
   * @param {string} username - The Instagram username.
   * @returns {Promise<object|null>} Parsed JSON data from API or null on failure.
   * @private
   */
  async _fetchInstagramDataAPI(username) {
    const apiUrl = `${this.options.instagramApiUrlBase}?username=${encodeURIComponent(username)}`;
    this.logger.debug(`Calling Instagram API for @${username}: ${apiUrl}`);
    try {
      const controller = new AbortController(); // For request timeout
      const timeoutId = setTimeout(() => controller.abort(), this.options.apiTimeout);

      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "Origin": "https://www.tucktools.com", // These headers are specific to this API
          "Referer": "https://www.tucktools.com/",
          "User-Agent": "Mozilla/5.0 (compatible; InstagramMonitorBot/1.0; +yourdomain.com/botinfo)", // Be a good internet citizen
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId); // Clear timeout if request completes

      if (!response.ok) {
        // Attempt to get more info from response body for logging
        let errorBody = 'N/A';
        try { errorBody = (await response.text()).substring(0, 250); } catch (_) {}
        this.logger.warn(`API request for @${username} failed with status ${response.status}. URL: ${apiUrl}. Response: ${errorBody}`);
        throw new Error(`API request failed for @${username} (status ${response.status})`);
      }
      const data = await response.json();
      this.logger.debug(`API response for @${username} (status ${data.status}):`, JSON.stringify(data).substring(0,100) + "...");
      return data;

    } catch (error) {
      if (error.name === 'AbortError') { // fetch specific timeout error
        this.logger.warn(`API call for @${username} timed out after ${this.options.apiTimeout}ms. URL: ${apiUrl}`);
        throw new Error(`API call for @${username} timed out.`);
      }
      this.logger.error(`Error fetching Instagram API data for @${username}: ${error.message}. URL: ${apiUrl}`, error.stack);
      throw error; // Re-throw to be handled by calling function
    }
  }

  /**
   * Parses the raw API response into a structured format for database and internal use.
   * @param {object} apiData - The raw JSON data from the API.
   * @param {string} targetUsername - The username that was queried.
   * @returns {object} Parsed profile data.
   * @private
   */
  _parseApiResponse(apiData, targetUsername) {
    this.logger.debug(`Parsing API response for @${targetUsername}. Has status: ${apiData ? apiData.status : 'N/A'}`);
    if (!apiData || apiData.status !== true) {
      const errorMessage = apiData ? (apiData.message || `API status not true for @${targetUsername}`) : `No data or invalid status from API for @${targetUsername}`;
      this.logger.warn(errorMessage); // Log the specific API message if available
      return { // Return a "default" or "error" structure
        username: targetUsername.toLowerCase(), 
        scrapedUsername: targetUsername.toLowerCase(), // Fallback
        userFullname: null, userDescription: null, userProfilePic: null, userProfilePicHash: null,
        isPrivate: null, followersCount: 0, followingCount: 0, postsCount: 0, isVerified: null,
        rawFollowers: '0', rawFollowing: '0', rawPosts: '0',
        apiResponseJson: apiData || { status: false, message: "No valid data from API or processing error" },
      };
    }
    // If apiData.status is true, proceed with parsing
    return {
      username: targetUsername.toLowerCase(), // The queried username, for consistency
      scrapedUsername: (apiData.username || targetUsername).toLowerCase(), // Username from API
      userFullname: apiData.user_fullname || null,
      userDescription: apiData.user_description || null,
      userProfilePic: apiData.user_profile_pic || null,
      userProfilePicHash: null, // This will be populated later by _getImageHash
      isPrivate: apiData.is_private === true,
      followersCount: parseInt(apiData.user_followers, 10) || 0,
      followingCount: parseInt(apiData.user_following, 10) || 0,
      postsCount: parseInt(apiData.total_posts, 10) || 0,
      isVerified: apiData.is_verified === true,
      rawFollowers: String(apiData.user_followers || '0'),
      rawFollowing: String(apiData.user_following || '0'),
      rawPosts: String(apiData.total_posts || '0'),
      apiResponseJson: apiData, // Store the full successful response
    };
  }

  /**
   * Fetches an image from a URL and computes its MD5 hash.
   * @param {string|null} url - The URL of the image.
   * @returns {Promise<string|null>} The MD5 hash of the image or null if fetching/hashing fails.
   * @private
   */
  async _getImageHash(url) {
    if (!url) {
      this.logger.debug("Skipping image hash: URL is null.");
      return null;
    }
    this.logger.debug(`Attempting to fetch and hash image from URL: ${url.substring(0, 70)}...`);
    try {
        const response = await axios.get(url, { 
            responseType: 'arraybuffer', // Crucial for binary data
            timeout: this.options.imageFetchTimeout 
        });
        if (response.status === 200 && response.data) {
            const hash = crypto.createHash('md5').update(response.data).digest('hex');
            this.logger.debug(`Successfully hashed image from ${url.substring(0,70)}... Hash: ${hash.substring(0,8)}...`);
            return hash;
        }
        this.logger.warn(`Failed to fetch image for hashing (status ${response.status}): ${url}`);
        return null;
    } catch (error) {
        // Axios errors often have useful `error.code` or `error.response.status`
        this.logger.warn(`Error fetching/hashing image ${url.substring(0,70)}...: ${error.message}. Code: ${error.code || 'N/A'}`);
        return null;
    }
  }

  /**
   * Fetches profile data (including PFP hash) for a given username.
   * @param {string} username - The Instagram username.
   * @returns {Promise<object>} Object containing success status, data, error, and timestamp.
   */
  async scrapeProfile(username) {
    this.logger.info(`Fetching profile data for @${username}...`);
    try {
      const apiData = await this._fetchInstagramDataAPI(username);
      let profileData = this._parseApiResponse(apiData, username);

      // If API parsing was successful (implies apiData.status === true) and a PFP URL exists
      if (profileData.apiResponseJson && profileData.apiResponseJson.status === true && profileData.userProfilePic) {
        this.logger.debug(`Fetching profile picture for hashing: @${username}`);
        profileData.userProfilePicHash = await this._getImageHash(profileData.userProfilePic);
        if (profileData.userProfilePicHash) {
            this.logger.debug(`Profile picture hash for @${username}: ${profileData.userProfilePicHash.substring(0,8)}...`);
        } else {
            this.logger.warn(`Could not generate hash for profile picture of @${username}. URL: ${profileData.userProfilePic}`);
        }
      } else {
        profileData.userProfilePicHash = null; // Ensure hash is null if no pic or API issue
        if (profileData.apiResponseJson && profileData.apiResponseJson.status === true && !profileData.userProfilePic) {
            this.logger.debug(`User @${username} has no profile picture URL from API.`);
        }
      }
      return { success: true, data: profileData, timestamp: new Date().toISOString() };
    } catch (error) {
      // _fetchInstagramDataAPI already logs its specific errors
      this.logger.error(`Overall error in scrapeProfile for @${username}: ${error.message}`);
      return { success: false, error: error.message, timestamp: new Date().toISOString() };
    }
  }

  /**
   * Checks a single Instagram account for changes and notifies subscribers.
   * Saves data to history only if a significant change is detected or it's the first record.
   * @param {string} username - The Instagram username to check.
   * @returns {Promise<object|null>} The current profile data or null on failure.
   */
  async checkSingleAccount(username) {
    this.logger.info(`Processing account: @${username}`);
    const result = await this.scrapeProfile(username); // Includes PFP hashing

    if (!result.success || !result.data) {
      this.logger.error(`Failed to get valid data for @${username} from scrapeProfile: ${result.error || 'No data object'}`);
      return null;
    }
    
    const currentData = result.data;

    // If the API response itself indicated an issue (e.g., user not found, status:false)
    if (currentData.apiResponseJson && currentData.apiResponseJson.status === false) {
        this.logger.warn(`API indicated an issue for @${username}. Data will not be compared or saved as a valid history point. API Response: ${JSON.stringify(currentData.apiResponseJson)}`);
        // Consider if you want to save this "error response" to a different log or collection
        return null; 
    }

    const previousData = await this.FollowerHistory.findOne({
        username: currentData.username,
        // 'apiResponseJson.status': true // Optionally, only compare against previously *successful* fetches
    }).sort({ createdAt: -1 });

    let hasChanged = false;
    // Initialize changesForNotification with all fields from currentData to ensure they are available
    let changesForNotification = {
        followerDiff: 0, followingDiff: 0, postsDiff: 0,
        verifiedChanged: false, privateChanged: false, profilePicChanged: false, nameChanged: false,
        current: currentData, 
        previous: previousData // previousData can be null
    };

    if (previousData) {
        changesForNotification.followerDiff = (currentData.followersCount || 0) - (previousData.followersCount || 0);
        changesForNotification.followingDiff = (currentData.followingCount || 0) - (previousData.followingCount || 0);
        changesForNotification.postsDiff = (currentData.postsCount || 0) - (previousData.postsCount || 0);
        changesForNotification.verifiedChanged = currentData.isVerified !== previousData.isVerified;
        changesForNotification.privateChanged = currentData.isPrivate !== previousData.isPrivate;
        
        // Compare PFP hashes. Handles cases where one or both might be null.
        changesForNotification.profilePicChanged = currentData.userProfilePicHash !== (previousData.userProfilePicHash || null);
        // If hashes are the same but one URL is null and other isn't (or vice-versa), it's a change.
        // This catches a pic appearing or disappearing even if hashing failed for one.
        if (!changesForNotification.profilePicChanged && 
            ((currentData.userProfilePic && !previousData.userProfilePic) || (!currentData.userProfilePic && previousData.userProfilePic))) {
            changesForNotification.profilePicChanged = true;
        }

        changesForNotification.nameChanged = currentData.userFullname !== (previousData.userFullname || null);

        if ( changesForNotification.followerDiff !== 0 || changesForNotification.followingDiff !== 0 ||
             changesForNotification.postsDiff !== 0 || changesForNotification.verifiedChanged ||
             changesForNotification.privateChanged || changesForNotification.profilePicChanged ||
             changesForNotification.nameChanged ) {
            hasChanged = true;
        }
    } else { // This is the first valid record for this account
        hasChanged = true; 
        if (currentData.userProfilePicHash) { // If there's a pic on the first record with a hash
            changesForNotification.profilePicChanged = true; // Consider this a "change" for notification purposes
        }
    }

    if (hasChanged) {
        try {
            // Only save if it's a change OR the very first record for this user
            await new this.FollowerHistory(currentData).save();
            this.logger.info(`Saved history for @${currentData.username} (Reason: ${previousData ? 'change detected' : 'initial record'}).`);
        } catch (dbError) {
            this.logger.error(`Database insert error for @${currentData.username}:`, dbError.message, dbError.stack);
        }

        if (previousData) { // It's an update with changes
            this.logger.info(`Changes detected for @${currentData.username}. Preparing notification...`);
            await this._notifyChanges(currentData.username, changesForNotification);
        } else { // It's the first successful record
            this.logger.info(`Initial data processed for @${currentData.username}. Preparing notification...`);
            await this._notifyNewAccount(currentData.username, currentData, result.timestamp, changesForNotification.profilePicChanged);
        }
    } else {
        this.logger.info(`No significant changes detected for @${currentData.username}.`);
    }
    return currentData;
  }
  
  /**
   * Notifies subscribers about detected changes to a monitored profile.
   * @param {string} username - The Instagram username.
   * @param {object} changes - An object detailing the detected changes.
   * @private
   */
  async _notifyChanges(username, changes) {
    const { current, previous, followerDiff, followingDiff, postsDiff, verifiedChanged, privateChanged, profilePicChanged, nameChanged } = changes;
    
    const subscribers = await this.MonitoredUser.find({ username }).select('chatId -_id');
    if (!subscribers || !subscribers.length) {
        this.logger.debug(`No subscribers found for @${username} to notify about changes.`);
        return;
    }
    const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
    this.logger.info(`Notifying ${uniqueChatIds.length} subscriber(s) about changes for @${username}.`);

    // Handle profile picture change notification (sends image separately)
    if (profilePicChanged && current.userProfilePic) {
        this.logger.info(`Profile picture changed for @${username}. Sending image to subscribers.`);
        for (const chatId of uniqueChatIds) {
            try {
                await this.bot.sendPhoto(chatId, current.userProfilePic, { caption: `📸 @${username} updated their profile picture!` });
            } catch (e) {
                this.logger.error(`Failed to send profile picture to chat ${chatId} for @${username}: ${e.message}`);
                // Send a fallback text message if image send fails
                try { await this.bot.sendMessage(chatId, `ℹ️ @${username} updated their profile picture (image could not be sent).`); }
                catch (ef) { this.logger.error(`Failed to send PFP change fallback text to chat ${chatId}:`, ef.message); }
            }
        }
    } else if (profilePicChanged) { // Pic changed but no new URL (e.g., removed, or hash different but URL invalid)
        this.logger.info(`Profile picture for @${username} changed, but no new valid URL. Sending text notification.`);
        for (const chatId of uniqueChatIds) {
             try { await this.bot.sendMessage(chatId, `ℹ️ @${username} updated their profile picture (new picture URL not available or it was removed).`); }
             catch (et) { this.logger.error(`Failed to send PFP change (no URL) text to chat ${chatId}:`, et.message); }
        }
    }

    // Prepare and send a text summary of other changes
    let messageParts = [];
    if (nameChanged) { messageParts.push(`👤 *Name:* "${previous.userFullname || 'N/A'}" → "${current.userFullname || 'N/A'}"`); }
    if (verifiedChanged) { messageParts.push(`🛡️ *Verification:* ${previous.isVerified ? '✅ Verified → ❌ Unverified' : '❌ Unverified → ✅ Verified'}`); }
    if (privateChanged) { messageParts.push(`🔒 *Privacy:* ${previous.isPrivate ? 'Private Account → 🌎 Public Account' : '🌎 Public Account → 🔒 Private Account'}`); }
    if (followerDiff !== 0) { const i = followerDiff > 0 ? '📈' : '📉'; messageParts.push(`${i} *Followers:* ${followerDiff > 0 ? '+' : ''}${followerDiff.toLocaleString()} (${(previous.followersCount||0).toLocaleString()} → ${(current.followersCount||0).toLocaleString()})`); }
    if (followingDiff !== 0) { const i = followingDiff > 0 ? '📈' : '📉'; messageParts.push(`${i} *Following:* ${followingDiff > 0 ? '+' : ''}${followingDiff.toLocaleString()} (${(previous.followingCount||0).toLocaleString()} → ${(current.followingCount||0).toLocaleString()})`); }
    if (postsDiff !== 0) { messageParts.push(`📝 *Posts:* ${postsDiff > 0 ? '+' : ''}${postsDiff.toLocaleString()} (${(previous.postsCount||0).toLocaleString()} → ${(current.postsCount||0).toLocaleString()})`); }

    if (messageParts.length > 0) {
        let textMessageSummary = `🔄 *Profile Update for @${username}*\n\n${messageParts.join('\n')}`;
        textMessageSummary += `\n\n🕒 ${new Date().toLocaleString()}`; // Timestamp of this notification
        await this._broadcastToSubscribersTextOnly(textMessageSummary, username);
    } else if (!profilePicChanged) { 
        // This case means no textual changes AND profile pic didn't change,
        // which should have been caught by `hasChanged` in `checkSingleAccount`.
        // Logging it just in case.
        this.logger.debug(`No textual changes to notify for @${username} (and PFP didn't trigger separate notification).`);
    }
  }
  
  /**
   * Notifies subscribers about a newly monitored account's initial data.
   * @param {string} username - The Instagram username.
   * @param {object} data - The initial profile data.
   * @param {string} scrapeTimestamp - ISO string timestamp of when the data was scraped.
   * @param {boolean} initialProfilePicExists - Whether a profile picture was found and hashed.
   * @private
   */
  async _notifyNewAccount(username, data, scrapeTimestamp, initialProfilePicExists = false) {
    const recordTimestamp = data.createdAt || scrapeTimestamp || Date.now(); // Use DB timestamp if available
    let message = `✨ *Initial data recorded for @${username}*\n\n`;
    if (data.userFullname) message += `👤 *Name:* ${data.userFullname}\n`;
    message += `👥 *Followers:* ${(data.followersCount || 0).toLocaleString()}\n`;
    message += `➡️ *Following:* ${(data.followingCount || 0).toLocaleString()}\n`;
    message += `📝 *Posts:* ${(data.postsCount || 0).toLocaleString()}\n`;
    message += `✅ *Verified:* ${data.isVerified ? 'Yes' : 'No'}\n`;
    message += `${data.isPrivate ? '🔒 Private Account' : '🌎 Public Account'}\n`;
    message += `\n🕒 ${new Date(recordTimestamp).toLocaleString()}`;
    await this._broadcastToSubscribersTextOnly(message, username);

    // Send initial profile picture if it exists
    if (initialProfilePicExists && data.userProfilePic) {
        this.logger.info(`Sending initial profile picture for newly added @${username}.`);
        const subscribers = await this.MonitoredUser.find({ username }).select('chatId -_id');
        if (!subscribers || !subscribers.length) return;
        const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
        for (const chatId of uniqueChatIds) {
            try {
                await this.bot.sendPhoto(chatId, data.userProfilePic, { caption: `🖼️ Initial profile picture for @${username}` });
            } catch (e) {
                this.logger.warn(`Could not send initial profile picture for @${username} to chat ${chatId}: ${e.message}`);
            }
        }
    }
  }

  /**
   * Broadcasts a text-only message to all subscribers of a target username.
   * @param {string} messageText - The text message to send.
   * @param {string} targetUsername - The Instagram username whose subscribers to notify.
   * @private
   */
  async _broadcastToSubscribersTextOnly(messageText, targetUsername) {
    if (!messageText) {
        this.logger.debug(`_broadcastToSubscribersTextOnly called with empty message for @${targetUsername}. Skipping.`);
        return;
    }
    const subscribers = await this.MonitoredUser.find({ username: targetUsername }).select('chatId -_id');
    if (!subscribers || !subscribers.length) {
        this.logger.debug(`No subscribers for @${targetUsername} to send text message.`);
        return;
    }
    const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
    this.logger.debug(`Broadcasting text message to ${uniqueChatIds.length} chat(s) for @${targetUsername}.`);

    for (const chatId of uniqueChatIds) {
        try {
            await this.bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
        } catch (botError) {
            // Handle common errors like bot blocked by user, chat not found, etc.
            if (botError.response && (botError.response.statusCode === 403 || botError.response.statusCode === 400)) {
                this.logger.warn(`Telegram send error (bot blocked/chat not found) to chat ${chatId} for @${targetUsername}: ${botError.response.body ? botError.response.body.description : botError.message}`);
                // Future: Consider removing this chatId from monitoring this targetUsername if error persists.
            } else {
                this.logger.error(`Failed to send text message to chat ${chatId} for @${targetUsername}:`, botError.message, botError.stack);
            }
        }
    }
  }

  /**
   * Retrieves a list of unique Instagram usernames currently being monitored.
   * @returns {Promise<string[]>} An array of unique usernames.
   */
  async getUniqueMonitoredAccounts() {
    try {
      const accounts = await this.MonitoredUser.distinct('username');
      this.logger.debug(`Found ${accounts ? accounts.length : 0} unique accounts to monitor.`);
      return accounts || [];
    } catch (dbError) {
      this.logger.error('Database error fetching unique monitored accounts:', dbError.message, dbError.stack);
      return []; // Return empty array on error to prevent breaking the check cycle
    }
  }

  /**
   * Iterates through all unique monitored accounts and checks them for changes.
   */
  async checkAllAccounts() {
    if (this.isInitializing) {
        this.logger.info("Account check cycle skipped: Bot is still initializing.");
        return;
    }
    const accounts = await this.getUniqueMonitoredAccounts();
    if (!accounts.length) {
        this.logger.debug('No accounts currently configured for monitoring.'); // Less verbose for frequent checks
        return;
    }

    this.logger.info(`Starting periodic check cycle for ${accounts.length} unique account(s)...`);
    for (const [index, username] of accounts.entries()) {
      this.logger.debug(`Checking account ${index + 1}/${accounts.length}: @${username}`);
      try {
        await this.checkSingleAccount(username);
      } catch (error) { // Catch unhandled errors from checkSingleAccount itself
        this.logger.error(`Critical unhandled error during check cycle for @${username}: ${error.message}`, error.stack);
      }
      // Add delay between processing accounts to avoid overwhelming the API or local resources
      if (index < accounts.length - 1) {
        const delayMs = this.options.requestDelay + Math.floor(Math.random() * 500); // Add some jitter
        this.logger.debug(`Delaying ${delayMs}ms before next account check.`);
        await this._delay(delayMs);
      }
    }
    const nextCheckSeconds = Math.round(this.options.checkInterval / 1000);
    this.logger.info(`Periodic check cycle completed for ${accounts.length} account(s). Next check scheduled in approximately ${nextCheckSeconds} seconds.`);
  }

  /**
   * Starts the main monitoring loop.
   * @returns {Promise<string>} A message indicating the monitoring status.
   */
  async start() {
    if (this.isInitializing) {
        this.logger.warn("Attempted to start monitoring while bot is still initializing.");
        return "Bot is initializing. Monitoring will commence automatically once ready.";
    }
    if (this.isRunning) {
      this.logger.info('Monitoring is already active.');
      return 'Monitoring is already active.';
    }
    
    this.isRunning = true; // Set state immediately
    this.logger.info('Starting main monitoring loop...');
    
    // Clear any existing interval from a previous faulty state, just in case
    if (this.intervalId) {
        this.logger.warn('Clearing pre-existing intervalId. This should not happen in normal operation.');
        clearInterval(this.intervalId);
        this.intervalId = null;
    }
    
    // Perform an initial check immediately upon starting
    await this.checkAllAccounts(); 

    // Set up the periodic checks
    this.intervalId = setInterval(async () => {
        if (!this.isRunning) { // Should be caught by stop(), but as a safeguard
            this.logger.warn("Monitoring interval fired but bot is not in 'running' state. Clearing interval.");
            clearInterval(this.intervalId);
            this.intervalId = null;
            return;
        }
        await this.checkAllAccounts();
    }, this.options.checkInterval);

    this.logger.info('Main monitoring loop initiated successfully.');
    return 'Monitoring has been activated.';
  }

  /**
   * Stops the main monitoring loop.
   * @returns {Promise<string>} A message indicating the monitoring status.
   */
  async stop() { // This is primarily for graceful shutdown now
    this.logger.info('Attempting to stop monitoring loop...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.info('Monitoring interval has been cleared.');
    } else {
      this.logger.info('No active monitoring interval to clear.');
    }
    this.isRunning = false; // Set operational state
    this.logger.info('Monitoring has been stopped.');
    return 'Monitoring has been stopped.';
  }

  /**
   * Performs a graceful shutdown of the bot, stopping monitoring and disconnecting from the database.
   */
  async gracefulShutdown() {
    this.logger.info("Initiating graceful shutdown sequence...");
    await this.stop(); // Stop the monitoring loop

    if (mongoose.connection.readyState === 1) { // 1: connected
        this.logger.info("Disconnecting from MongoDB...");
        try {
            await mongoose.disconnect();
            this.logger.info("Successfully disconnected from MongoDB.");
        } catch (dbError) {
            this.logger.error("Error during MongoDB disconnection:", dbError.message, dbError.stack);
        }
    } else {
        this.logger.info("MongoDB connection already closed or not established.");
    }

    this.logger.info("Bot shutdown sequence complete. Exiting application.");
    process.exit(0); // Exit the process cleanly
  }
}

// --- Main Application Execution ---
if (require.main === module) {
    // Ensure critical environment variables are set
    if (!MONGODB_URI || !TELEGRAM_BOT_TOKEN) {
        console.error(`${LOG_PREFIX} CRITICAL ERROR: MONGODB_URI and TELEGRAM_BOT_TOKEN environment variables must be set.`);
        process.exit(1);
    }

    try {
        const bot = new InstagramFollowerBot(); // Initialization and auto-start are handled within the constructor

        // Handler for process termination signals
        const shutdownHandler = (signal) => {
            console.info(`\n${LOG_PREFIX} Received signal: ${signal}. Initiating graceful shutdown...`);
            bot.gracefulShutdown();
        };

        process.on('SIGINT', shutdownHandler);  // Ctrl+C
        process.on('SIGTERM', shutdownHandler); // kill command

        // Optional: Handle unhandled promise rejections and uncaught exceptions
        process.on('unhandledRejection', (reason, promise) => {
            console.error(`${LOG_PREFIX} FATAL: Unhandled Rejection at:`, promise, 'reason:', reason);
            // Consider a more robust shutdown or restart strategy here for production
            bot.gracefulShutdown().finally(() => process.exit(1));
        });
        process.on('uncaughtException', (error) => {
            console.error(`${LOG_PREFIX} FATAL: Uncaught Exception:`, error);
            // Consider a more robust shutdown or restart strategy here for production
            bot.gracefulShutdown().finally(() => process.exit(1));
        });


        console.log(`${LOG_PREFIX} Instagram Follower Monitor Bot (API Mode with Image Hashing) is launching...`);
        console.log(`${LOG_PREFIX} Bot will start monitoring automatically once fully initialized.`);
        console.log(`${LOG_PREFIX} Press Ctrl+C to exit gracefully.`);

    } catch (e) {
        // This catches errors during the synchronous part of the bot instantiation
        console.error(`${LOG_PREFIX} CRITICAL ERROR ON BOT LAUNCH (before async init):`, e.message, e.stack);
        process.exit(1);
    }
}

module.exports = InstagramFollowerBot;