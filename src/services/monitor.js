const { MonitoredUser, FollowerHistory, StoryHistory, PostHistory } = require('../models/models');
const logger = require('../utils/logger');
const config = require('../config/config');

class MonitorService {
    constructor(instagramService, bot) {  // Add bot parameter
        this.instagramService = instagramService;
        this.bot = bot;  // Use the provided bot instance
        this.isRunning = false;
        this.isInitializing = true;
        this.isReady = false; // New flag to track full initialization
        this.intervalId = null;
        this.storyIntervalId = null;
        this.postIntervalId = null;
        this._recentlyAddedAccounts = {};
        this._lastStoryVideoUrl = new Map();
        this._lastPostCheck = new Map(); // Track last post check time per user
        this._requestQueue = []; // Queue for rate limiting
        this._lastRequestTime = 0;
        this.options = {
            requestDelay: 30000, // 30 seconds between requests (2 per minute)
            checkInterval: config.API.CHECK_INTERVAL_MS,
            postCheckInterval: 3600000 // 1 hour for post checks
        };
    }

    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async addAccount(username, chatId, userId) {
        if (!username) {
            await this.bot.sendMessage(chatId, '⚠️ Please provide a username. Usage: /add `username`');
            return;
        }

        if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
            await this.bot.sendMessage(chatId, '⚠️ Invalid Instagram username format.');
            return;
        }

        const existing = await MonitoredUser.findOne({ username, chatId });
        if (existing) {
            await this.bot.sendMessage(chatId, `ℹ️ @${username} is already being monitored in this chat.`);
            return;
        }

        await new MonitoredUser({ username, chatId, addedByUserId: userId }).save();
        logger.info(`User @${username} added for monitoring in chat ${chatId} by user ${userId}.`);
        await this.bot.sendMessage(chatId, `✅ @${username} added to monitoring list. Performing initial checks...`);

        // Perform initial profile and story checks
        try {
            // Check profile first
            this._recentlyAddedAccounts[username] = Date.now();
            await this.checkSingleAccount(username, { forceInitialNotification: true });

            // Then check stories
            const storyResult = await this.instagramService.fetchStoryData(username);
            if (storyResult.status === 'ok' && storyResult.mediaUrl) {
                await this.bot.sendMessage(chatId, `📸 Checking for active stories from @${username}...`);
                await this._processStoryResult(username, storyResult);
            } else if (storyResult.status === 'no_stories') {
                await this.bot.sendMessage(chatId, `ℹ️ No active stories found for @${username}.`);
            }
        } catch (error) {
            logger.error(`Error during initial checks for @${username}:`, error);
            await this.bot.sendMessage(chatId, `⚠️ Added @${username} but encountered some issues during initial checks. Monitoring will continue normally.`);
        }
    }

    async removeAccount(username, chatId) {
        const result = await MonitoredUser.deleteOne({ username, chatId });
        if (result.deletedCount > 0) {
            logger.info(`User @${username} removed from monitoring in chat ${chatId}.`);
            const stillMonitored = await MonitoredUser.countDocuments({ username });
            
            if (stillMonitored === 0) {
                // Delete all history data for this user since no one is monitoring them anymore
                const [followerResult, storyResult, postResult] = await Promise.all([
                    FollowerHistory.deleteMany({ username }),
                    StoryHistory.deleteMany({ username }),
                    PostHistory.deleteMany({ username })
                ]);
                logger.info(`Deleted ${followerResult.deletedCount} follower records, ${storyResult.deletedCount} story records, and ${postResult.deletedCount} post records for @${username}`);
                await this.bot.sendMessage(chatId, `✅ @${username} has been removed and all their data has been deleted.`);
            } else {
                await this.bot.sendMessage(chatId, `✅ @${username} has been removed from this chat's monitoring list.`);
            }
        } else {
            await this.bot.sendMessage(chatId, `⚠️ @${username} was not found in your monitoring list.`);
        }
    }

    async listAccounts(chatId) {
        const users = await MonitoredUser.find({ chatId }).sort({ username: 1 });

        if (!users.length) {
            await this.bot.sendMessage(chatId, '📝 No accounts are currently being monitored. Use /add to add one!');
            return;
        }

        const userList = users.map((user, index) => `${index + 1}. @${user.username}`).join('\n');
        await this.bot.sendMessage(chatId, `📋 *Monitored Accounts (${users.length}):*\n\n${userList}`, { parse_mode: 'Markdown' });
    }

    async getStatus(chatId) {
        const statusMessage = this.isRunning ? '🟢 Actively Monitoring' : '🟡 Starting up or issue occurred';
        let nextCheckInfo = this.isRunning ? 
            `Checks occur every ${Math.round(this.options.checkInterval / 1000)} seconds.` :
            this.isInitializing ? "Bot is currently initializing." : "⚠️ WARNING: Monitoring loop is not active.";

        await this.bot.sendMessage(chatId, 
            `📊 *Bot Status*\n\nOperational Status: ${statusMessage}\n${nextCheckInfo}`, 
            { parse_mode: 'Markdown' });
    }

    async getStats(chatId, username) {
        if (username) {
            await this.sendAccountStats(chatId, username);
        } else {
            const monitoredAccounts = await MonitoredUser.find({ chatId }).sort({ username: 1 });
            if (!monitoredAccounts.length) {
                await this.bot.sendMessage(chatId, '📝 You are not monitoring any accounts. Use /add `username` to start.');
                return;
            }

            const inlineKeyboard = monitoredAccounts.map(acc => ([
                { text: `@${acc.username}`, callback_data: `stats_${acc.username}` }
            ]));
            
            await this.bot.sendMessage(chatId, '👇 Choose an account to view statistics for:', {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }
    }

    async handleStatsCallback(username, chatId, msg) {
        try {
            if (msg) {
                await this.bot.editMessageText(`⏳ Fetching statistics for @${username}...`, {
                    chat_id: chatId,
                    message_id: msg.message_id,
                    reply_markup: { inline_keyboard: [] }
                });
            }
            await this.sendAccountStats(chatId, username);
        } catch (error) {
            logger.error(`Error handling stats callback for @${username}:`, error);
            await this.bot.sendMessage(chatId, `❌ Error fetching stats for @${username}.`);
        }
    }

    async sendAccountStats(chatId, username) {
        const history = await FollowerHistory.find({ username })
            .sort({ createdAt: -1 })
            .limit(10);

        let statsText;
        if (!history || history.length === 0) {
            statsText = `📊 No historical data found for @${username}. Has it been checked yet?`;
        } else {
            const latest = history[0];
            const oldest = history[history.length - 1];
            const followerChange = (latest.followersCount || 0) - (oldest.followersCount || 0);
            const changeIcon = followerChange > 0 ? '📈' : followerChange < 0 ? '📉' : '➖';

            statsText = this._formatStatsMessage(latest, followerChange, history.length);
        }
        
        await this.bot.sendMessage(chatId, statsText, { parse_mode: 'Markdown' });
    }

    _formatStatsMessage(latest, followerChange, historyLength) {
        const instagramUrl = `https://instagram.com/${latest.username}`;
        let message = `👤 *Name:* ${latest.userFullname || 'N/A'}\n`;
        message += `👥 *Followers:* ${latest.followersCount?.toLocaleString() || 'N/A'}\n`;
        message += `➡️ *Following:* ${latest.followingCount?.toLocaleString() || 'N/A'}\n`;
        message += `📝 *Posts:* ${latest.postsCount?.toLocaleString() || 'N/A'}\n`;
        message += `✅ *Verified:* ${latest.isVerified ? 'Yes' : 'No'}\n`;
        message += `${latest.isPrivate ? '🔒 Private Account' : '🌎 Public Account'}\n`;
        
        if (latest.userDescription) {
            const bioSnippet = latest.userDescription.replace(/\n/g, ' ').substring(0, 70);
            message += `📜 *Bio:* ${bioSnippet}${latest.userDescription.length > 70 ? '...' : ''}\n`;
        }
        
        if (historyLength > 1) {
            const changeIcon = followerChange > 0 ? '📈' : followerChange < 0 ? '📉' : '➖';
            message += `\n${changeIcon} *Change (last ${historyLength} checks):* ${followerChange > 0 ? '+' : ''}${followerChange.toLocaleString()} followers\n`;
        }
        
        const now = new Date();
        message += `\n🕒 *Last Checked:* ${now.toLocaleString()}\n\n[View Profile](${instagramUrl})`;
        return message;
    }

    async checkSingleAccount(username, options = {}) {
        const result = await this._rateLimitedRequest(() => 
            this.instagramService.fetchProfileData(username)
        );
        
        if (!result.success) return null;

        const currentData = result.data;
        if (!currentData.apiResponseJson?.status) return null;

        // Check if post count increased
        const previousData = await FollowerHistory.findOne({ username }).sort({ createdAt: -1 });
        if (previousData && currentData.postsCount > previousData.postsCount) {
            // Post count increased, fetch new posts
            await this._checkNewPosts(username);
        }

        await this._processProfileData(username, currentData, options);
        return currentData;
    }

    async _checkNewPosts(username) {
        try {
            const lastCheck = this._lastPostCheck.get(username) || 0;
            const now = Date.now();
            
            // Only check if it's been at least 5 minutes since last check
            if (now - lastCheck < 300000) {
                return;
            }

            this._lastPostCheck.set(username, now);
            
            const postResult = await this._rateLimitedRequest(() =>
                this.instagramService.fetchAllPosts(username)
            );

            if (postResult.status === 'ok' && postResult.posts) {
                await this._processPostResult(username, postResult.posts);
            }
        } catch (error) {
            logger.error(`Error checking posts for @${username}:`, error);
        }
    }

    async _processPostResult(username, posts) {
        // Find the most recent post we've processed
        const lastProcessedPost = await PostHistory.findOne({ username })
            .sort({ processedAt: -1 })
            .limit(1);

        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const newPosts = posts.filter(post => 
            !lastProcessedPost || 
            new Date(post.timestamp) > lastProcessedPost.processedAt
        );

        if (newPosts.length > 0) {
            logger.info(`Found ${newPosts.length} new posts for @${username}`);
            
            for (const post of newPosts) {
                const postRecord = new PostHistory({
                    username,
                    postId: post.id,
                    mediaUrl: post.mediaUrl,
                    mediaType: post.mediaType,
                    caption: post.caption,
                    timestamp: new Date(post.timestamp),
                    processedAt: new Date(),
                    sentTo: []
                });
                
                await postRecord.save();
                await this._notifyPost(username, post, postRecord);
            }
        }
    }

    async _notifyPost(username, post, postRecord) {
        const subscribers = await MonitoredUser.find({ username }).select('chatId -_id');
        const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
        const instagramUrl = `https://instagram.com/${username}`;
        
        for (const chatId of uniqueChatIds) {
            if (postRecord.sentTo.includes(chatId)) {
                continue;
            }

            try {
                const emoji = post.mediaType === 'video' ? '🎬' : '📸';
                let sent = false;

                if (post.mediaType === 'video') {
                    await this.bot.sendVideo(chatId, post.mediaUrl, {
                        caption: `${emoji} New Instagram post from [@${username}](${instagramUrl})\n\n${post.caption || ''}`,
                        parse_mode: 'Markdown'
                    }).then(() => sent = true).catch(async () => {
                        await this.bot.sendMessage(chatId, 
                            `${emoji} New Instagram post from [@${username}](${instagramUrl})\n\n${post.caption || ''}`,
                            { parse_mode: 'Markdown' }
                        );
                        sent = true;
                    });
                } else if (post.mediaType === 'photo') {
                    await this.bot.sendPhoto(chatId, post.mediaUrl, {
                        caption: `${emoji} New Instagram post from [@${username}](${instagramUrl})\n\n${post.caption || ''}`,
                        parse_mode: 'Markdown'
                    }).then(() => sent = true).catch(async () => {
                        await this.bot.sendMessage(chatId, 
                            `${emoji} New Instagram post from [@${username}](${instagramUrl})\n\n${post.caption || ''}`,
                            { parse_mode: 'Markdown' }
                        );
                        sent = true;
                    });
                }
                
                if (sent) {
                    await PostHistory.updateOne(
                        { _id: postRecord._id },
                        { $addToSet: { sentTo: chatId } }
                    );
                }
            } catch (error) {
                logger.error(`Failed to notify chat ${chatId} about post from @${username}:`, error);
            }
        }
    }

    async _processProfileData(username, currentData, options) {
        const previousData = await FollowerHistory.findOne({ username }).sort({ createdAt: -1 });
        const changes = this._detectChanges(currentData, previousData);

        if (changes.hasChanged) {
            await new FollowerHistory(currentData).save();
            if (previousData) {
                await this._notifyChanges(username, changes);
            } else if (!this._shouldSuppressNotification(username, options)) {
                await this._notifyNewAccount(username, currentData);
            }
        }
    }

    async _notifyNewAccount(username, data) {
        const subscribers = await MonitoredUser.find({ username }).select('chatId -_id');
        const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
        const instagramUrl = `https://instagram.com/${username}`;
        
        const message = this._formatStatsMessage(data, 0, 1);
        
        for (const chatId of uniqueChatIds) {
            try {
                if (data.userProfilePic) {
                    await this.bot.sendPhoto(chatId, data.userProfilePic, {
                        caption: `📊 *Initial data for* [@${username}](${instagramUrl})\n\n${message}`,
                        parse_mode: 'Markdown'
                    }).catch(async (error) => {
                        logger.warn(`Failed to send profile picture for @${username}, falling back to text-only:`, error);
                        await this.bot.sendMessage(chatId, 
                            `📊 *Initial data for* [@${username}](${instagramUrl})\n\n${message}`, 
                            { parse_mode: 'Markdown' }
                        );
                    });
                } else {
                    await this.bot.sendMessage(chatId, 
                        `📊 *Initial data for* [@${username}](${instagramUrl})\n\n${message}`, 
                        { parse_mode: 'Markdown' }
                    );
                }
                logger.debug(`Initial data notification sent to chat ${chatId} for @${username}`);
            } catch (error) {
                logger.error(`Failed to send initial data to chat ${chatId} for @${username}:`, error);
            }
        }
    }

    async _notifyChanges(username, changes) {
        const subscribers = await MonitoredUser.find({ username }).select('chatId -_id');
        const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
        const instagramUrl = `https://instagram.com/${username}`;
        
        let changeMessage = `🔄 *Changes detected for* [@${username}](${instagramUrl})\n\n`;
        
        if (changes.followerDiff !== 0) {
            const emoji = changes.followerDiff > 0 ? '📈' : '📉';
            changeMessage += `${emoji} *Followers:* ${changes.followerDiff > 0 ? '+' : ''}${changes.followerDiff.toLocaleString()}\n`;
        }
        
        if (changes.followingDiff !== 0) {
            const emoji = changes.followingDiff > 0 ? '📈' : '📉';
            changeMessage += `${emoji} *Following:* ${changes.followingDiff > 0 ? '+' : ''}${changes.followingDiff.toLocaleString()}\n`;
        }
        
        if (changes.postsDiff !== 0) {
            const emoji = changes.postsDiff > 0 ? '📈' : '📉';
            changeMessage += `${emoji} *Posts:* ${changes.postsDiff > 0 ? '+' : ''}${changes.postsDiff.toLocaleString()}\n`;
        }
        
        if (changes.verifiedChanged) {
            changeMessage += `✅ *Verified Status:* ${changes.current.isVerified ? 'Now Verified' : 'No Longer Verified'}\n`;
        }
        
        if (changes.privateChanged) {
            changeMessage += `${changes.current.isPrivate ? '🔒' : '🌎'} *Privacy:* ${changes.current.isPrivate ? 'Now Private' : 'Now Public'}\n`;
        }
        
        if (changes.nameChanged) {
            changeMessage += `👤 *Name:* ${changes.previous.userFullname || 'N/A'} → ${changes.current.userFullname || 'N/A'}\n`;
        }
        
        if (changes.profilePicChanged) {
            changeMessage += `🖼️ *Profile Picture:* Updated\n`;
        }
        
        changeMessage += `\n📊 *Current Stats*\n`;
        changeMessage += `👥 *Followers:* ${changes.current.followersCount?.toLocaleString() || 'N/A'}\n`;
        changeMessage += `➡️ *Following:* ${changes.current.followingCount?.toLocaleString() || 'N/A'}\n`;
        changeMessage += `📝 *Posts:* ${changes.current.postsCount?.toLocaleString() || 'N/A'}\n`;
        
        changeMessage += `\n🕒 *Detected at:* ${new Date().toLocaleString()}\n\n[View Profile](${instagramUrl})`;
        
        for (const chatId of uniqueChatIds) {
            try {
                await this.bot.sendMessage(chatId, changeMessage, { parse_mode: 'Markdown' });
                logger.debug(`Change notification sent to chat ${chatId} for @${username}`);
            } catch (error) {
                logger.error(`Failed to send change notification to chat ${chatId} for @${username}:`, error);
            }
        }
    }

    _detectChanges(current, previous) {
        if (!previous) return { hasChanged: true };

        const changes = {
            hasChanged: false,
            followerDiff: (current.followersCount || 0) - (previous.followersCount || 0),
            followingDiff: (current.followingCount || 0) - (previous.followingCount || 0),
            postsDiff: (current.postsCount || 0) - (previous.postsCount || 0),
            verifiedChanged: current.isVerified !== previous.isVerified,
            privateChanged: current.isPrivate !== previous.isPrivate,
            profilePicChanged: current.userProfilePicHash !== previous.userProfilePicHash,
            nameChanged: current.userFullname !== previous.userFullname,
            current,
            previous
        };

        changes.hasChanged = changes.followerDiff !== 0 || changes.followingDiff !== 0 ||
            changes.postsDiff !== 0 || changes.verifiedChanged || changes.privateChanged ||
            changes.profilePicChanged || changes.nameChanged;

        return changes;
    }

    _shouldSuppressNotification(username, options) {
        if (options.forceInitialNotification) return false;
        
        const addedAt = this._recentlyAddedAccounts[username];
        if (!addedAt) return false;

        const now = Date.now();
        if (now - addedAt < 90000) return true;

        delete this._recentlyAddedAccounts[username];
        return false;
    }

    async start() {
        if (this.isRunning) {
            logger.info('Monitoring is already active.');
            return;
        }

        try {
            logger.info('Starting monitoring service...');
            
            await this._getUniqueMonitoredAccounts();
            
            this.isInitializing = false;
            this.isRunning = true;
            
            logger.info('Starting initial account check...');
            await this.checkAllAccounts();
            
            logger.info('Setting up monitoring intervals...');
            this.intervalId = setInterval(() => {
                if (!this.isRunning) {
                    clearInterval(this.intervalId);
                    this.intervalId = null;
                    return;
                }
                this.checkAllAccounts().catch(err => 
                    logger.error('Error in periodic account check:', err));
            }, this.options.checkInterval);
            
            await this._startStoryMonitor();
            await this._startPostMonitor();
            
            logger.info('Monitoring service started successfully.');
        } catch (error) {
            this.isRunning = false;
            logger.error('Failed to start monitoring service:', error);
            throw error;
        }
    }

    async stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.storyIntervalId) {
            clearInterval(this.storyIntervalId);
            this.storyIntervalId = null;
        }

        if (this.postIntervalId) {
            clearInterval(this.postIntervalId);
            this.postIntervalId = null;
        }

        this.isRunning = false;
        logger.info('Monitoring stopped.');
    }

    async checkAllAccounts() {
        if (this.isInitializing) {
            logger.warn("Account check cycle skipped: Service is still initializing.");
            return;
        }

        if (!this.isRunning) {
            logger.warn("Account check cycle skipped: Service is not running.");
            return;
        }

        try {
            const accounts = await this._getUniqueMonitoredAccounts();
            if (!accounts.length) {
                logger.debug('No accounts currently configured for monitoring.');
                return;
            }

            logger.info(`Starting check cycle for ${accounts.length} account(s)...`);
            for (const [index, username] of accounts.entries()) {
                if (!this.isRunning) {
                    logger.info('Monitoring stopped, interrupting check cycle.');
                    break;
                }

                try {
                    await this.checkSingleAccount(username);
                    if (index < accounts.length - 1) {
                        await this._delay(this.options.requestDelay + Math.floor(Math.random() * 500));
                    }
                } catch (error) {
                    logger.error(`Error checking account @${username}:`, error);
                    // Continue with next account despite error
                }
            }
            
            logger.info('Account check cycle completed.');
        } catch (error) {
            logger.error('Error during account check cycle:', error);
            // Don't throw the error to avoid crashing the monitoring loop
        }
    }

    async _getUniqueMonitoredAccounts() {
        try {
            return await MonitoredUser.distinct('username');
        } catch (error) {
            logger.error('Error fetching monitored accounts:', error);
            return [];
        }
    }

    async _startStoryMonitor() {
        const STORY_CHECK_INTERVAL = 3600000; // 1 hour
        
        const checkStories = async () => {
            if (this.isInitializing) return;
            
            const usernames = await this._getUniqueMonitoredAccounts();
            for (const username of usernames) {
                try {
                    const storyResult = await this.instagramService.fetchStoryData(username);
                    await this._processStoryResult(username, storyResult);
                    await this._delay(2000 + Math.floor(Math.random() * 1000));
                } catch (error) {
                    logger.error(`Error checking stories for @${username}:`, error);
                }
            }
        };

        await checkStories();
        this.storyIntervalId = setInterval(checkStories, STORY_CHECK_INTERVAL);
        logger.info('Story monitor started (hourly checks)');
    }

    async _processStoryResult(username, storyResult) {
        if (storyResult.status === 'ok' && storyResult.mediaUrl) {
            // Find the most recent story we've processed for this user
            const lastProcessedStory = await StoryHistory.findOne({ username })
                .sort({ processedAt: -1 })
                .limit(1);

            // If we have a last processed story, only process if this one is newer
            // Add a 5-minute buffer to account for any time differences
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const isNewStory = !lastProcessedStory || 
                             (lastProcessedStory.processedAt < fiveMinutesAgo);

            if (isNewStory) {
                // New story, create record and notify
                logger.info(`New story detected for @${username}`);
                const storyRecord = new StoryHistory({
                    username,
                    mediaUrl: storyResult.mediaUrl,
                    mediaType: storyResult.mediaType,
                    storyTimestamp: new Date(), // This is just for record keeping
                    processedAt: new Date(),    // This is what we use for checking new stories
                    sentTo: [] // Will be populated as we send notifications
                });
                await storyRecord.save();
                await this._notifyStory(username, storyResult.mediaUrl, storyResult.mediaType, storyRecord);
            } else {
                logger.debug(`Story already processed for @${username} (last processed at: ${lastProcessedStory.processedAt})`);
            }
        } else if (storyResult.status === 'no_stories') {
            logger.debug(`No active stories for @${username}`);
        }
    }

    async _notifyStory(username, mediaUrl, mediaType, storyRecord) {
        const subscribers = await MonitoredUser.find({ username }).select('chatId -_id');
        const uniqueChatIds = [...new Set(subscribers.map(s => s.chatId))];
        const instagramUrl = `https://instagram.com/${username}`;
        
        for (const chatId of uniqueChatIds) {
            if (storyRecord.sentTo.includes(chatId)) {
                logger.debug(`Story already sent to chat ${chatId} for @${username}`);
                continue;
            }

            try {
                const emoji = mediaType === 'video' ? '🎬' : '📸';
                let sent = false;

                if (mediaType === 'video') {
                    await this.bot.sendVideo(chatId, mediaUrl, {
                        caption: `${emoji} New Instagram story from [@${username}](${instagramUrl})`,
                        parse_mode: 'Markdown'
                    }).then(() => sent = true).catch(async () => {
                        await this.bot.sendMessage(chatId, 
                            `${emoji} New Instagram story from [@${username}](${instagramUrl})`,
                            { parse_mode: 'Markdown' }
                        );
                        sent = true;
                    });
                } else if (mediaType === 'photo') {
                    await this.bot.sendPhoto(chatId, mediaUrl, {
                        caption: `${emoji} New Instagram story from [@${username}](${instagramUrl})`,
                        parse_mode: 'Markdown'
                    }).then(() => sent = true).catch(async () => {
                        await this.bot.sendMessage(chatId, 
                            `${emoji} New Instagram story from [@${username}](${instagramUrl})`,
                            { parse_mode: 'Markdown' }
                        );
                        sent = true;
                    });
                }
                
                if (sent) {
                    await StoryHistory.updateOne(
                        { _id: storyRecord._id },
                        { $addToSet: { sentTo: chatId } }
                    );
                    logger.debug(`Story notification sent and recorded for chat ${chatId}`);
                }
            } catch (error) {
                logger.error(`Failed to notify chat ${chatId} about story from @${username}:`, error);
            }
        }
    }

    async _startPostMonitor() {
        const checkPosts = async () => {
            if (this.isInitializing) return;
            
            const usernames = await this._getUniqueMonitoredAccounts();
            for (const username of usernames) {
                try {
                    await this._checkNewPosts(username);
                    await this._delay(2000 + Math.floor(Math.random() * 1000));
                } catch (error) {
                    logger.error(`Error checking posts for @${username}:`, error);
                }
            }
        };

        await checkPosts();
        this.postIntervalId = setInterval(checkPosts, this.options.postCheckInterval);
        logger.info('Post monitor started (hourly checks)');
    }

    // Add rate limiting method
    async _rateLimitedRequest(fn) {
        const now = Date.now();
        const timeSinceLastRequest = now - this._lastRequestTime;
        
        if (timeSinceLastRequest < this.options.requestDelay) {
            await this._delay(this.options.requestDelay - timeSinceLastRequest);
        }
        
        this._lastRequestTime = Date.now();
        return fn();
    }
}

module.exports = MonitorService;
