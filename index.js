// const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // REMOVED
// const puppeteerExtra = require('puppeteer-extra'); // REMOVED
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios'); // For fetching image data
const crypto = require('crypto'); // For hashing
require('dotenv').config();

// --- Mongoose Schemas and Models --- (Remain the same)
const MonitoredUserSchema = new mongoose.Schema({
  username: { type: String, required: true, lowercase: true, index: true },
  chatId: { type: String, required: true, index: true },
  addedByUserId: { type: String, required: true },
}, { timestamps: true });
MonitoredUserSchema.index({ username: 1, chatId: 1 }, { unique: true });
const MonitoredUser = mongoose.model('MonitoredUser', MonitoredUserSchema);

const FollowerHistorySchema = new mongoose.Schema({
  username: { type: String, required: true, lowercase: true, index: true },
  scrapedUsername: { type: String, lowercase: true },
  userFullname: String,
  userDescription: String, // Bio
  userProfilePic: String,
  userProfilePicHash: String, // NEW: To store the hash of the profile picture
  isPrivate: Boolean,
  followersCount: Number,
  followingCount: Number,
  postsCount: Number,
  isVerified: Boolean,
  rawFollowers: String,
  rawFollowing: String,
  rawPosts: String,
  apiResponseJson: mongoose.Schema.Types.Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });
FollowerHistorySchema.index({ username: 1, createdAt: -1 });
const FollowerHistory = mongoose.model('FollowerHistory', FollowerHistorySchema);


class InstagramFollowerBot {
  constructor(options = {}) {
    this.options = {
      apiTimeout: options.apiTimeout ?? parseInt(process.env.API_TIMEOUT_MS || '15000', 10),
      imageFetchTimeout: options.imageFetchTimeout ?? parseInt(process.env.IMAGE_FETCH_TIMEOUT_MS || '10000', 10), // Timeout for fetching image
      requestDelay: options.requestDelay ?? parseInt(process.env.REQUEST_DELAY_MS || '1500', 10), // Slightly increase for image hashing
      checkInterval: options.checkInterval ?? parseInt(process.env.ONE_MINUTE_CHECK_INTERVAL_MS || process.env.CHECK_INTERVAL_MS || '60000', 10),
      ...options
    };
    // ... (rest of constructor remains the same) ...
    this.mongodbUri = options.mongodbUri || process.env.MONGODB_URI;
    if (!this.mongodbUri) {
        throw new Error("MongoDB URI (MONGODB_URI) must be provided via options or .env file.");
    }

    this.telegramToken = options.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
    if (!this.telegramToken) {
        throw new Error("Telegram Bot Token must be provided via options or .env file.");
    }
    this.bot = new TelegramBot(this.telegramToken, { polling: true });

    const rawAuthorizedUsers = options.authorizedUsers || process.env.TELEGRAM_AUTHORIZED_USERS;
    this.authorizedUsers = new Set(
        rawAuthorizedUsers ? rawAuthorizedUsers.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id)) : []
    );

    this.isRunning = false;
    this.intervalId = null;
    this.isInitializing = true;

    this.MonitoredUser = MonitoredUser;
    this.FollowerHistory = FollowerHistory;

    this._initialize();
  }

  // ... (_initialize, initializeDatabase, _createAuthorizedHandler, setupTelegramHandlers, sendAccountStats, _delay remain mostly the same) ...
  async _initialize() {
    try {
      await this.initializeDatabase();
      this.setupTelegramHandlers(); // Sets up command handlers and callback query listener
      this.isInitializing = false;
      console.log('✅ Bot initialized successfully (API Mode with Image Hashing).');
      console.log(`🕒 Monitoring check interval set to: ${this.options.checkInterval / 1000} seconds.`);
      console.log(`📞 API call delay set to: ${this.options.requestDelay} ms.`);
      await this.start();
    } catch (error) {
      console.error('❌ Bot initialization failed:', error);
      process.exit(1);
    }
  }

  async initializeDatabase() {
    console.log('⚙️ Connecting to MongoDB...');
    try {
      await mongoose.connect(this.mongodbUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log('✅ Connected to MongoDB successfully.');
      mongoose.connection.on('error', err => console.error('🔴 MongoDB connection error:', err));
      mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected.'));
    } catch (error) {
      console.error('❌ MongoDB initial connection failed:', error.message);
      throw error;
    }
  }

  _createAuthorizedHandler(commandRegex, handlerFn) {
    this.bot.onText(commandRegex, async (msg, match) => {
      if (this.isInitializing) {
        this.bot.sendMessage(msg.chat.id, "⏳ Bot is still initializing, please wait a moment...");
        return;
      }
      if (this.authorizedUsers.size > 0 && !this.authorizedUsers.has(msg.from.id)) {
        this.bot.sendMessage(msg.chat.id, '❌ Unauthorized access.');
        console.warn(`Unauthorized access by ${msg.from.id} (${msg.from.username || 'N/A'}) in chat ${msg.chat.id}`);
        return;
      }
      try {
        await handlerFn(msg, match);
      } catch (e) {
        console.error(`❌ Handler error for ${commandRegex} by ${msg.from.id}:`, e);
        let errMsg = `An unexpected error occurred: ${e.message}`;
        if (e.name === 'MongoServerError' && e.code === 11000) {
            errMsg = `⚠️ Account might already be monitored or unique constraint failed.`;
        }
        this.bot.sendMessage(msg.chat.id, errMsg);
      }
    });
  }

  setupTelegramHandlers() {
    console.log('🤖 Setting up Telegram command handlers...');
    this._createAuthorizedHandler(/\/start$/, (msg) => {
      this.bot.sendMessage(msg.chat.id, "🤖 *Instagram Follower Monitor Bot (API Mode)*\n\nMonitoring is automatic. Use /help for commands.", { parse_mode: 'Markdown' });
    });
    this._createAuthorizedHandler(/\/help$/, (msg) => {
      const helpMsg = `
🤖 *Instagram Follower Monitor Bot - Commands*

Monitoring starts automatically.

/add \`username\` - Add an Instagram account to monitor.
/remove \`username\` - Remove an account from monitoring.
/list - Show all monitored accounts in this chat.
/status - Show bot's monitoring status.
/stats \`username\` (optional) - Get follower statistics. If no username, lists accounts to choose.
/help - Show this help message.

Example: \`/add anadexter\` or just \`/stats\`
      `;
      this.bot.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'Markdown' });
    });
    this._createAuthorizedHandler(/\/add (.+)/, async (msg, match) => {
        const username = match[1].trim().replace('@', '').toLowerCase();
        const chatId = msg.chat.id.toString();
        const userId = msg.from.id.toString();
        if (!username) return this.bot.sendMessage(chatId, '⚠️ Usage: /add `username`');
        if (await this.MonitoredUser.findOne({ username, chatId })) {
            return this.bot.sendMessage(chatId, `⚠️ @${username} is already monitored here.`);
        }
        await new this.MonitoredUser({ username, chatId, addedByUserId: userId }).save();
        this.bot.sendMessage(chatId, `✅ Added @${username}. Performing initial check...`);
        await this.checkSingleAccount(username);
    });
    this._createAuthorizedHandler(/\/remove (.+)/, async (msg, match) => {
        const username = match[1].trim().replace('@', '').toLowerCase();
        const chatId = msg.chat.id.toString();
        if (!username) return this.bot.sendMessage(chatId, '⚠️ Usage: /remove `username`');
        const result = await this.MonitoredUser.deleteOne({ username, chatId });
        this.bot.sendMessage(chatId, result.deletedCount ? `✅ Removed @${username}.` : `⚠️ @${username} not found.`);
    });
    this._createAuthorizedHandler(/\/list$/, async (msg) => {
        const chatId = msg.chat.id.toString();
        const users = await this.MonitoredUser.find({ chatId }).sort({ createdAt: 1 });
        if (!users.length) return this.bot.sendMessage(chatId, '📝 No accounts monitored here.');
        const list = users.map((u, i) => `${i + 1}. @${u.username}`).join('\n');
        this.bot.sendMessage(chatId, `📋 *Monitored Accounts (${users.length}):*\n\n${list}`, { parse_mode: 'Markdown' });
    });
    this._createAuthorizedHandler(/\/status$/, (msg) => {
        const statusMsg = this.isRunning ? '🟢 Actively Monitoring' : '🟡 Initializing/Issue (intended to monitor)';
        let nextCheck = 'Checks occur periodically.';
        if (this.isRunning && this.intervalId) {
            const intervalSec = Math.round(this.options.checkInterval / 1000);
            nextCheck = `Checks approx. every ${intervalSec} sec.`;
        } else if (!this.isRunning && !this.isInitializing) nextCheck = "⚠️ Loop inactive. Check logs.";
        else if (this.isInitializing) nextCheck = "Bot initializing.";
        this.bot.sendMessage(msg.chat.id, `📊 *Status*\n\nBot: ${statusMsg}\n${nextCheck}`, { parse_mode: 'Markdown' });
    });

    this._createAuthorizedHandler(/\/stats(?: (.+))?$/, async (msg, match) => {
        const chatId = msg.chat.id.toString();
        const usernameParam = match[1] ? match[1].trim().replace('@', '').toLowerCase() : null;

        if (usernameParam) {
            await this.sendAccountStats(chatId, usernameParam, msg.message_id);
        } else {
            const monitoredAccounts = await this.MonitoredUser.find({ chatId }).sort({ username: 1 });
            if (!monitoredAccounts || monitoredAccounts.length === 0) {
                return this.bot.sendMessage(chatId, '📝 You are not monitoring any accounts. Use /add `username`.');
            }
            const inlineKeyboard = monitoredAccounts.map(acc => ([
                { text: `@${acc.username}`, callback_data: `stats_${acc.username}` }
            ]));
             if (inlineKeyboard.length > 0) {
                 this.bot.sendMessage(chatId, '👇 Please choose an account for stats:', {
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
            } else {
                 this.bot.sendMessage(chatId, 'No accounts to select for stats.');
            }
        }
    });

    this.bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data;
        const chatId = msg.chat.id.toString();
        this.bot.answerCallbackQuery(callbackQuery.id);

        if (data.startsWith('stats_')) {
            const username = data.substring('stats_'.length);
            console.log(`📊 Callback for stats: @${username} in chat ${chatId}`);
            try {
                await this.bot.editMessageText(`Fetching stats for @${username}...`, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: { inline_keyboard: [] } 
                }).catch(e => console.warn("Minor: Could not edit message to remove keyboard:", e.message));
                
                await this.sendAccountStats(chatId, username);
            } catch (e) {
                console.error(`Error in stats callback for @${username}:`, e);
                this.bot.sendMessage(chatId, `❌ Error fetching stats for @${username}: ${e.message}`);
            }
        }
    });

    this.bot.on('polling_error', (e) => console.error('🔴 TG Polling Error:', e.code, e.message));
    this.bot.on('webhook_error', (e) => console.error('🔴 TG Webhook Error:', e.code, e.message));
    this.bot.on('error', (e) => console.error('🔴 General TG Lib Error:', e));
    console.log('✅ Telegram command handlers set up.');
  }

  async sendAccountStats(chatId, username, originalMessageId = null) {
    const history = await this.FollowerHistory.find({ username })
        .sort({ createdAt: -1 })
        .limit(10);

    let statsText;
    if (!history || history.length === 0) {
        statsText = `📊 No historical data found for @${username}.`;
    } else {
        const latest = history[0];
        const oldest = history[history.length - 1];
        const fChange = (latest.followersCount || 0) - (oldest.followersCount || 0);
        const icon = fChange > 0 ? '📈' : fChange < 0 ? '📉' : '➖';

        statsText = `📊 *Stats for @${username}*\n`;
        if (latest.userFullname) statsText += `👤 Name: ${latest.userFullname}\n`;
        statsText += `👥 Followers: ${latest.followersCount?.toLocaleString() || 'N/A'}\n`;
        statsText += `➡️ Following: ${latest.followingCount?.toLocaleString() || 'N/A'}\n`;
        statsText += `📝 Posts: ${latest.postsCount?.toLocaleString() || 'N/A'}\n`;
        statsText += `✅ Verified: ${latest.isVerified ? 'Yes' : 'No'}\n`;
        statsText += `${latest.isPrivate ? '🔒 Private Account' : '🌎 Public Account'}\n`;
        if (latest.userDescription) statsText += `📜 Bio: ${latest.userDescription.substring(0, 50)}${latest.userDescription.length > 50 ? '...' : ''}\n`;
        statsText += `${icon} Change (last ${history.length} checks): ${fChange > 0 ? '+' : ''}${fChange.toLocaleString()}\n`;
        statsText += `Last Updated: ${new Date(latest.createdAt).toLocaleString()}`;
    }
    
    this.bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' });
  }


  async _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _fetchInstagramDataAPI(username) { // Remains the same
    const url = `https://fanhub.pro/tucktools_user?username=${encodeURIComponent(username)}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.apiTimeout);
      const response = await fetch(url, {
        method: "GET",
        headers: { "Origin": "https://www.tucktools.com", "Referer": "https://www.tucktools.com/", "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`API fail @${username} status ${response.status}. Body: ${(await response.text().catch(()=>'')).substring(0,100)}`);
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`API call @${username} timed out.`);
      throw error; // Rethrow other errors
    }
  }

  _parseApiResponse(apiData, targetUsername) { // Add userProfilePicHash
    if (!apiData || apiData.status !== true) {
      const errorMessage = apiData ? (apiData.message || `API status not true for @${targetUsername}`) : `No data/invalid status @${targetUsername}`;
      console.warn(`  ⚠️ ${errorMessage}`);
      return {
        username: targetUsername.toLowerCase(), scrapedUsername: targetUsername.toLowerCase(),
        userFullname: null, userDescription: null, userProfilePic: null, userProfilePicHash: null,
        isPrivate: null, followersCount: 0, followingCount: 0, postsCount: 0, isVerified: null,
        rawFollowers: '0', rawFollowing: '0', rawPosts: '0',
        apiResponseJson: apiData || { status: false, message: "No data from API or processing error" },
      };
    }
    return {
      username: targetUsername.toLowerCase(),
      scrapedUsername: (apiData.username || targetUsername).toLowerCase(),
      userFullname: apiData.user_fullname || null,
      userDescription: apiData.user_description || null,
      userProfilePic: apiData.user_profile_pic || null,
      userProfilePicHash: null, // Will be populated after fetching/hashing image
      isPrivate: apiData.is_private === true,
      followersCount: parseInt(apiData.user_followers, 10) || 0,
      followingCount: parseInt(apiData.user_following, 10) || 0,
      postsCount: parseInt(apiData.total_posts, 10) || 0,
      isVerified: apiData.is_verified === true,
      rawFollowers: String(apiData.user_followers || '0'),
      rawFollowing: String(apiData.user_following || '0'),
      rawPosts: String(apiData.total_posts || '0'),
      apiResponseJson: apiData,
    };
  }

  async _getImageHash(url) {
    if (!url) return null;
    try {
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: this.options.imageFetchTimeout 
        });
        if (response.status === 200) {
            return crypto.createHash('md5').update(response.data).digest('hex');
        }
        console.warn(`  ⚠️ Failed to fetch image for hashing (status ${response.status}): ${url}`);
        return null;
    } catch (error) {
        console.warn(`  ⚠️ Error fetching/hashing image ${url}: ${error.message.substring(0, 100)}`);
        return null;
    }
  }


  async scrapeProfile(username) {
    try {
      const apiData = await this._fetchInstagramDataAPI(username);
      let profileData = this._parseApiResponse(apiData, username);

      // If API call was successful and we have a profile picture URL, fetch and hash it
      if (profileData.apiResponseJson && profileData.apiResponseJson.status === true && profileData.userProfilePic) {
        console.log(`  🖼️ Fetching PFP for hashing: @${username}`);
        profileData.userProfilePicHash = await this._getImageHash(profileData.userProfilePic);
        if (profileData.userProfilePicHash) {
            console.log(`  🖼️ PFP Hash for @${username}: ${profileData.userProfilePicHash.substring(0,8)}...`);
        }
      } else {
        profileData.userProfilePicHash = null; // Ensure it's null if no pic or API error
      }
      return { success: true, data: profileData, timestamp: new Date().toISOString() };
    } catch (error) {
      console.error(`  ❌ Error in scrapeProfile for @${username}: ${error.message}`);
      return { success: false, error: error.message, timestamp: new Date().toISOString() };
    }
  }

  async checkSingleAccount(username) {
    console.log(`🔍 Checking account: @${username}`);
    const result = await this.scrapeProfile(username); // This now includes PFP hashing

    if (!result.success || !result.data) {
      console.error(`  ❌ Failed to get data for @${username}: ${result.error || 'No data returned'}`);
      return null;
    }
    
    const currentData = result.data;

    // If the API itself returned status:false, it's handled in _parseApiResponse & scrapeProfile,
    // currentData.apiResponseJson.status would be false.
    if (currentData.apiResponseJson && currentData.apiResponseJson.status === false) {
        console.warn(`  ⚠️ API issue for @${username}. Not processing as valid data. Resp: ${JSON.stringify(currentData.apiResponseJson)}`);
        // We don't save this to FollowerHistory as a "valid" record for comparison
        return null; 
    }

    const previousData = await this.FollowerHistory.findOne({
        username: currentData.username,
    }).sort({ createdAt: -1 });

    let hasChanged = false;
    let changesForNotification = {
        followerDiff: 0, followingDiff: 0, postsDiff: 0,
        verifiedChanged: false, privateChanged: false, profilePicChanged: false, nameChanged: false,
        current: currentData, previous: previousData
    };

    if (previousData) {
        changesForNotification.followerDiff = (currentData.followersCount || 0) - (previousData.followersCount || 0);
        changesForNotification.followingDiff = (currentData.followingCount || 0) - (previousData.followingCount || 0);
        changesForNotification.postsDiff = (currentData.postsCount || 0) - (previousData.postsCount || 0);
        changesForNotification.verifiedChanged = currentData.isVerified !== previousData.isVerified;
        changesForNotification.privateChanged = currentData.isPrivate !== previousData.isPrivate;
        
        // Compare PFP hashes if both exist
        if (currentData.userProfilePicHash && previousData.userProfilePicHash) {
            changesForNotification.profilePicChanged = currentData.userProfilePicHash !== previousData.userProfilePicHash;
        } else if (currentData.userProfilePicHash && !previousData.userProfilePicHash) {
            changesForNotification.profilePicChanged = true; // Had no hashed pic, now has one
        } else if (!currentData.userProfilePicHash && previousData.userProfilePicHash) {
            changesForNotification.profilePicChanged = true; // Had a hashed pic, now has none (or couldn't be hashed)
        } else { // Both hashes are null (e.g., no pic or pic fetch failed for both)
             changesForNotification.profilePicChanged = false;
        }
        // Fallback: if hashes are not available but URLs changed (less reliable)
        // This ensures if a pic URL appears/disappears entirely, it's caught even if hashing failed
        if (!changesForNotification.profilePicChanged && (currentData.userProfilePic && !previousData.userProfilePic || !currentData.userProfilePic && previousData.userProfilePic)) {
            changesForNotification.profilePicChanged = true;
        }
        
        changesForNotification.nameChanged = currentData.userFullname !== (previousData.userFullname || null);

        if ( changesForNotification.followerDiff !== 0 || changesForNotification.followingDiff !== 0 ||
             changesForNotification.postsDiff !== 0 || changesForNotification.verifiedChanged ||
             changesForNotification.privateChanged || changesForNotification.profilePicChanged ||
             changesForNotification.nameChanged ) {
            hasChanged = true;
        }
    } else { // This is the first successful record for this account
        hasChanged = true; 
        if (currentData.userProfilePicHash) { // If there's a pic on the first record with a hash
            changesForNotification.profilePicChanged = true; 
        }
    }

    if (hasChanged) {
        try {
            await new this.FollowerHistory(currentData).save(); // Save the new state
            console.log(`  💾 Saved history for @${currentData.username} (change/initial).`);
        } catch (dbError) {
            console.error(`  ❌ DB insert error for @${currentData.username}:`, dbError.message);
        }

        if (previousData) {
            console.log(`  🔄 Changes detected for @${currentData.username}. Notifying...`);
            await this._notifyChanges(currentData.username, changesForNotification);
        } else {
            console.log(`  🌟 Initial data for @${currentData.username}. Notifying...`);
            await this._notifyNewAccount(currentData.username, currentData, result.timestamp, changesForNotification.profilePicChanged);
        }
    } else {
        console.log(`  ✅ No changes for @${currentData.username}.`);
    }
    return currentData;
  }
  
  async _notifyChanges(username, changes) { // Logic for sending notifications (photo and text)
    const { current, previous, followerDiff, followingDiff, postsDiff, verifiedChanged, privateChanged, profilePicChanged, nameChanged } = changes;
    
    const subscribers = await this.MonitoredUser.find({ username }).select('chatId -_id');
    if (!subscribers || !subscribers.length) return;
    const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];

    if (profilePicChanged && current.userProfilePic) {
        console.log(`  🖼️ PFP changed for @${username} (Hash: ${current.userProfilePicHash ? current.userProfilePicHash.substring(0,8)+'...' : 'N/A'}). Notifying ${uniqueChatIds.length} subs.`);
        for (const chatId of uniqueChatIds) {
            try {
                await this.bot.sendPhoto(chatId, current.userProfilePic, { caption: `📸 @${username} changed their profile picture!` });
            } catch (e) {
                console.error(`  ❌ Failed to send PFP to chat ${chatId} for @${username}: ${e.message}`);
                try { await this.bot.sendMessage(chatId, `📸 @${username} changed PFP (image send failed).`); } catch (ef) { console.error(`Failed to send PFP fallback: ${ef.message}`);}
            }
        }
    } else if (profilePicChanged) { // Pic changed but no new URL (e.g., removed, or hash indicates change but URL is same old one that's now invalid)
        for (const chatId of uniqueChatIds) {
             try { await this.bot.sendMessage(chatId, `📸 @${username} changed PFP (new picture URL not available or removed).`); } catch (et) { console.error(`Failed to send PFP no URL text: ${et.message}`);}
        }
    }

    let messageParts = [];
    if (nameChanged) { messageParts.push(`👤 Name: "${previous.userFullname || 'N/A'}" → "${current.userFullname || 'N/A'}"`); }
    if (verifiedChanged) { messageParts.push(`🛡️ Verification: ${previous.isVerified ? '✅ Verified → ❌ Unverified' : '❌ Unverified → ✅ Verified'}`); }
    if (privateChanged) { messageParts.push(`🔒 Privacy: ${previous.isPrivate ? 'Private → 🌎 Public' : '🌎 Public → Private'}`); }
    if (followerDiff !== 0) { const i = followerDiff > 0 ? '📈' : '📉'; messageParts.push(`${i} Followers: ${followerDiff > 0 ? '+' : ''}${followerDiff.toLocaleString()} (${(previous.followersCount||0).toLocaleString()}→${(current.followersCount||0).toLocaleString()})`); }
    if (followingDiff !== 0) { const i = followingDiff > 0 ? '📈' : '📉'; messageParts.push(`${i} Following: ${followingDiff > 0 ? '+' : ''}${followingDiff.toLocaleString()} (${(previous.followingCount||0).toLocaleString()}→${(current.followingCount||0).toLocaleString()})`); }
    if (postsDiff !== 0) { messageParts.push(`📝 Posts: ${postsDiff > 0 ? '+' : ''}${postsDiff.toLocaleString()} (${(previous.postsCount||0).toLocaleString()}→${(current.postsCount||0).toLocaleString()})`); }

    if (messageParts.length > 0) {
        let txt = `🔄 *Update @${username}*\n\n${messageParts.join('\n')}\n\n⏰ ${new Date().toLocaleString()}`;
        await this._broadcastToSubscribersTextOnly(txt, username);
    } else if (!profilePicChanged) { 
        console.log(`  ℹ️ No textual changes for @${username} to notify.`);
    }
  }
  
  async _notifyNewAccount(username, data, scrapeTimestamp, initialProfilePicExists = false) { // Send initial PFP
    const recordTimestamp = data.createdAt || scrapeTimestamp || Date.now();
    let message = `✨ *Initial data for @${username}*\n\n`;
    if (data.userFullname) message += `👤 Name: ${data.userFullname}\n`;
    message += `👥 Followers: ${(data.followersCount || 0).toLocaleString()}\n`;
    message += `➡️ Following: ${(data.followingCount || 0).toLocaleString()}\n`;
    message += `📝 Posts: ${(data.postsCount || 0).toLocaleString()}\n`;
    message += `✅ Verified: ${data.isVerified ? 'Yes' : 'No'}\n`;
    message += `${data.isPrivate ? '🔒 Private Account' : '🌎 Public Account'}\n`;
    message += `\n⏰ ${new Date(recordTimestamp).toLocaleString()}`;
    await this._broadcastToSubscribersTextOnly(message, username);

    if (initialProfilePicExists && data.userProfilePic) { // 'initialProfilePicExists' is true if a pic was found on first check
        const subscribers = await this.MonitoredUser.find({ username }).select('chatId -_id');
        if (!subscribers || !subscribers.length) return;
        const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
        for (const chatId of uniqueChatIds) {
            try {
                await this.bot.sendPhoto(chatId, data.userProfilePic, { caption: `🖼️ Initial profile picture for @${username}` });
            } catch (e) {
                console.warn(`  ⚠️ Could not send initial PFP for @${username} to chat ${chatId}: ${e.message}`);
            }
        }
    }
  }

  async _broadcastToSubscribersTextOnly(messageText, targetUsername) { // Stays the same
    const subscribers = await this.MonitoredUser.find({ username: targetUsername }).select('chatId -_id');
    if (!subscribers || !subscribers.length) return;
    const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
    for (const chatId of uniqueChatIds) {
        try {
            if (messageText) {
                await this.bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown' });
            }
        } catch (botError) {
            if (botError.response && (botError.response.statusCode === 403 || botError.response.statusCode === 400)) {
                console.warn(`  ⚠️ Bot blocked/chat ${chatId} not found for @${targetUsername} (text).`);
            } else {
                console.error(`  ❌ Failed to send text message to ${chatId} for @${targetUsername}:`, botError.message);
            }
        }
    }
  }

  async getUniqueMonitoredAccounts() { // Stays the same
    try { return (await this.MonitoredUser.distinct('username')) || []; }
    catch (dbError) { console.error('❌ DB error fetching unique accounts:', dbError.message); return []; }
  }

  async checkAllAccounts() { // Stays the same
    if (this.isInitializing) return console.log("⏳ Check cycle: Bot initializing.");
    const accounts = await this.getUniqueMonitoredAccounts();
    if (!accounts.length) return;
    console.log(`🔄 Starting API check cycle for ${accounts.length} account(s)...`);
    for (const [index, username] of accounts.entries()) {
      try {
        await this.checkSingleAccount(username);
        if (index < accounts.length - 1) {
          await this._delay(this.options.requestDelay + Math.random() * 200);
        }
      } catch (error) {
        console.error(`💥 Unhandled error in check cycle for @${username}: ${error.message}`);
      }
    }
    const nextCheckSec = Math.round(this.options.checkInterval / 1000);
    console.log(`✅ API Check cycle complete. Next in ~${nextCheckSec} sec.`);
  }

  async start() { // Stays the same
    if (this.isInitializing) return "Bot initializing. Monitoring starts soon.";
    if (this.isRunning) return 'Monitor already active.';
    this.isRunning = true;
    console.log('🚀 API Monitor starting periodic checks...');
    if (this.intervalId) clearInterval(this.intervalId);
    await this.checkAllAccounts();
    this.intervalId = setInterval(() => this.checkAllAccounts(), this.options.checkInterval);
    console.log('✅ API Monitoring loop initiated.');
    return 'Monitoring active.';
  }

  async stop() { // Stays the same
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.isRunning = false;
    console.log('🛑 API Monitoring stopped.');
    return 'Monitoring stopped.';
  }

  async gracefulShutdown() { // Stays the same
    console.log("\n👋 Initiating graceful shutdown...");
    await this.stop();
    if (mongoose.connection.readyState === 1) {
      console.log("🔌 Disconnecting MongoDB...");
      await mongoose.disconnect();
      console.log("MongoDB disconnected.");
    }
    console.log("Bot shutdown complete.");
    process.exit(0);
  }
}

// --- Main Execution --- (Stays the same)
if (require.main === module) {
    try {
        const bot = new InstagramFollowerBot();
        const shutdownHandler = (signal) => {
            console.log(`\nReceived ${signal}.`);
            bot.gracefulShutdown();
        };
        process.on('SIGINT', shutdownHandler);
        process.on('SIGTERM', shutdownHandler);
        console.log('🤖 Instagram Follower Monitor Bot (API Mode with Image Hashing) is launching...');
        console.log('   Bot will start monitoring automatically once initialized.');
    } catch (e) {
        console.error("💥 CRITICAL ERROR ON BOT LAUNCH:", e.message);
        process.exit(1);
    }
}

module.exports = InstagramFollowerBot;